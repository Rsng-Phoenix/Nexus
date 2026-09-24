/**
 * Nexus reminder relay (Cloudflare Worker + D1).
 *
 * Browsers can't schedule notifications for when the app is closed, so each device tells this
 * worker *when* to wake it. At that moment the worker sends a Web Push containing only an opaque
 * reference (the task uuid); the device's service worker looks the task up locally and shows
 * the notification. Task titles, notes and calendar details never reach this server.
 *
 * Secrets (set with `wrangler secret put`): VAPID_PRIVATE_JWK, VAPID_PUBLIC (base64url raw P-256).
 */

export interface Env {
  DB: D1Database;
  VAPID_PRIVATE_JWK: string;
  VAPID_PUBLIC: string;
  VAPID_SUBJECT: string;
  ALLOWED_ORIGINS: string;
}

type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
type ReminderIn = { ref: string; fireAt: number; kind?: string };

const MAX_REMINDERS_PER_DEVICE = 500;
const MAX_AHEAD_MS = 62 * 24 * 60 * 60 * 1000;

// ─── HTTP ──────────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin') ?? '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    const cors: Record<string, string> = allowed.includes(origin)
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin'
        }
      : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: allowed.includes(origin) ? 204 : 403, headers: cors });
    if (origin && !allowed.includes(origin)) return json({ error: 'origin not allowed' }, 403, cors);

    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/vapid') return json({ publicKey: env.VAPID_PUBLIC }, 200, cors);

      if (req.method === 'POST' && url.pathname === '/register') {
        const body = (await readJson(req)) as { subscription?: Sub };
        const sub = body.subscription;
        if (!validSub(sub)) return json({ error: 'bad subscription' }, 400, cors);
        const now = Date.now();
        const auth = await authenticate(req, env);
        if (auth) {
          await env.DB.prepare('UPDATE devices SET endpoint=?, p256dh=?, auth=?, seen_at=? WHERE id=?')
            .bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, now, auth).run();
          return json({ deviceId: auth }, 200, cors);
        }
        const id = crypto.randomUUID();
        const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
        await env.DB.prepare('INSERT INTO devices (id, secret_hash, endpoint, p256dh, auth, created_at, seen_at) VALUES (?,?,?,?,?,?,?)')
          .bind(id, await sha256(secret), sub.endpoint, sub.keys.p256dh, sub.keys.auth, now, now).run();
        return json({ deviceId: id, secret }, 200, cors);
      }

      const device = await authenticate(req, env);
      if (!device) return json({ error: 'unauthorized' }, 401, cors);

      if (req.method === 'PUT' && url.pathname === '/reminders') {
        // Replace this device's whole schedule (the app recomputes it after every change).
        const body = (await readJson(req)) as { reminders?: ReminderIn[] };
        const now = Date.now();
        const list = (body.reminders ?? [])
          .filter((r) => typeof r.ref === 'string' && r.ref.length <= 200 && Number.isFinite(r.fireAt))
          .filter((r) => r.fireAt > now - 60_000 && r.fireAt < now + MAX_AHEAD_MS)
          .slice(0, MAX_REMINDERS_PER_DEVICE);
        const stmts = [env.DB.prepare('DELETE FROM reminders WHERE device_id=?').bind(device)];
        for (const r of list) {
          stmts.push(
            env.DB.prepare('INSERT OR IGNORE INTO reminders (device_id, ref, fire_at, kind) VALUES (?,?,?,?)')
              .bind(device, r.ref, Math.round(r.fireAt), (r.kind ?? 'task').slice(0, 16))
          );
        }
        stmts.push(env.DB.prepare('UPDATE devices SET seen_at=? WHERE id=?').bind(now, device));
        await env.DB.batch(stmts);
        return json({ scheduled: list.length }, 200, cors);
      }

      if (req.method === 'POST' && url.pathname === '/snooze') {
        const body = (await readJson(req)) as ReminderIn;
        if (typeof body.ref !== 'string' || !Number.isFinite(body.fireAt)) return json({ error: 'bad request' }, 400, cors);
        await env.DB.prepare('INSERT OR IGNORE INTO reminders (device_id, ref, fire_at, kind) VALUES (?,?,?,?)')
          .bind(device, body.ref, Math.round(body.fireAt), (body.kind ?? 'task').slice(0, 16)).run();
        return json({ ok: true }, 200, cors);
      }

      if (req.method === 'POST' && url.pathname === '/test') {
        const d = await env.DB.prepare('SELECT * FROM devices WHERE id=?').bind(device).first<DeviceRow>();
        if (!d) return json({ error: 'unknown device' }, 404, cors);
        const res = await sendPush(env, d, JSON.stringify({ kind: 'test', ref: 'test', fireAt: Date.now() }));
        return json({ status: res.status }, 200, cors);
      }

      if (req.method === 'DELETE' && url.pathname === '/device') {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM reminders WHERE device_id=?').bind(device),
          env.DB.prepare('DELETE FROM devices WHERE id=?').bind(device)
        ]);
        return json({ ok: true }, 200, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'error' }, 500, cors);
    }
  },

  // Every minute: send everything that is due, then forget it.
  async scheduled(_evt: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(deliverDue(env));
  }
};

type DeviceRow = { id: string; endpoint: string; p256dh: string; auth: string };

async function deliverDue(env: Env): Promise<void> {
  const now = Date.now();
  const due = await env.DB.prepare(
    `SELECT r.device_id, r.ref, r.fire_at, r.kind, d.endpoint, d.p256dh, d.auth
       FROM reminders r JOIN devices d ON d.id = r.device_id
      WHERE r.fire_at <= ? ORDER BY r.fire_at LIMIT 300`
  ).bind(now + 20_000).all<{ device_id: string; ref: string; fire_at: number; kind: string } & DeviceRow>();
  const rows = due.results ?? [];
  if (!rows.length) return;
  const gone = new Set<string>();
  await Promise.all(
    rows.map(async (r) => {
      const res = await sendPush(
        env,
        { id: r.device_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth },
        JSON.stringify({ kind: r.kind, ref: r.ref, fireAt: r.fire_at })
      ).catch(() => null);
      if (res && (res.status === 404 || res.status === 410)) gone.add(r.device_id); // unsubscribed
    })
  );
  const stmts = rows.map((r) =>
    env.DB.prepare('DELETE FROM reminders WHERE device_id=? AND ref=? AND fire_at=?').bind(r.device_id, r.ref, r.fire_at)
  );
  for (const id of gone) {
    stmts.push(env.DB.prepare('DELETE FROM reminders WHERE device_id=?').bind(id));
    stmts.push(env.DB.prepare('DELETE FROM devices WHERE id=?').bind(id));
  }
  await env.DB.batch(stmts);
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

async function authenticate(req: Request, env: Env): Promise<string | null> {
  const h = req.headers.get('Authorization') ?? '';
  const m = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/.exec(h);
  if (!m) return null;
  const row = await env.DB.prepare('SELECT secret_hash FROM devices WHERE id=?').bind(m[1]).first<{ secret_hash: string }>();
  if (!row) return null;
  return timingSafeEqual(row.secret_hash, await sha256(m[2])) ? m[1] : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) ─────────────────────────────

async function sendPush(env: Env, d: DeviceRow, payload: string): Promise<Response> {
  const body = await encrypt(payload, d.p256dh, d.auth);
  const aud = new URL(d.endpoint).origin;
  const jwt = await vapidJwt(env, aud);
  return fetch(d.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`
    },
    body
  });
}

let signingKey: CryptoKey | null = null;
async function vapidJwt(env: Env, aud: string): Promise<string> {
  signingKey ??= await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, enc.encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64u(new Uint8Array(sig))}`;
}

async function encrypt(payload: string, p256dhB64: string, authB64: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const uaPublic = unb64u(p256dhB64);
  const authSecret = unb64u(authB64);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(enc.encode(payload), new Uint8Array([2])); // last record, no padding
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

async function hmac(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

// ─── utils ─────────────────────────────────────────────────────────────────────

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function sha256(s: string): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

function validSub(s: Sub | undefined): s is Sub {
  return !!s && typeof s.endpoint === 'string' && s.endpoint.startsWith('https://') && s.endpoint.length < 1000 &&
    typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 200_000) throw new Error('payload too large');
  return text ? JSON.parse(text) : {};
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
