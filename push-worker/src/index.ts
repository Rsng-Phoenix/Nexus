/**
 * Nexus reminder relay (Cloudflare Worker + D1).
 *
 * Browsers can't schedule notifications for when the app is closed, so each device tells this
 * worker *when* to wake it. At that moment the worker sends a Web Push containing only an opaque
 * reference (the task uuid); the device's service worker looks the task up locally and shows
 * the notification. Task titles, notes and calendar details never reach this server.
 *
 * It also lets the web app stay signed in to Google Drive: Google only gives browser apps
 * 1-hour tokens, so the app sends the one-time sign-in code here, the worker adds the OAuth client
 * secret and returns a refresh token *to the device*. Nothing is stored here; later the device
 * swaps its refresh token for a fresh 1-hour token through `/oauth/refresh`.
 *
 * "Scan to set up" hands a new device your linked calendars and settings through `/pair/<id>`:
 * the sending device encrypts them (AES-GCM) with a key that only travels inside the QR code /
 * link fragment, so this worker stores an unreadable blob for at most 10 minutes and deletes it
 * the moment the other device collects it.
 *
 * "Show Nexus in your calendar apps" publishes a read-only iCal feed at `/feed/<secret>.ics` that
 * Google, Apple and Outlook Calendar subscribe to. It is opt-in: this is the one place task titles
 * and dates are stored here, because those apps must be able to read them. The address is a
 * 256-bit secret (only its SHA-256 is stored), and only devices holding the separate write key can
 * change or delete it.
 *
 * Secrets (set with `wrangler secret put`): VAPID_PRIVATE_JWK, VAPID_PUBLIC (base64url raw P-256),
 * GOOGLE_CLIENT_SECRET (optional; without it the app falls back to hourly Google sign-in).
 */

export interface Env {
  DB: D1Database;
  VAPID_PRIVATE_JWK: string;
  VAPID_PUBLIC: string;
  VAPID_SUBJECT: string;
  ALLOWED_ORIGINS: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Per-IP limit (Workers Rate Limiting binding, free). Optional so the worker runs without it. */
  LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
type ReminderIn = { ref: string; fireAt: number; kind?: string };

const MAX_REMINDERS_PER_DEVICE = 500;
/** Registered browsers/devices at most (a family's worth many times over), and when they expire. */
const MAX_DEVICES = 20000;
const DEVICE_IDLE_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_AHEAD_MS = 62 * 24 * 60 * 60 * 1000;
/** A ring this late (worker or push service was down) is dropped, never delivered in a burst. */
const MAX_LATE_MS = 12 * 60 * 60 * 1000;
const ICS_MAX_BYTES = 5 * 1024 * 1024;
/** Scan to set up: how long an encrypted hand-over waits, its size, and how many may wait at once. */
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_MAX_CHARS = 96 * 1024;
const PAIR_MAX_PENDING = 5000;
const PAIR_ID = /^[A-Za-z0-9_-]{22,64}$/;
/** Calendar feeds: a 32-byte secret address, a size cap, and feeds nobody updated for a year go. */
const FEED_ID = /^[A-Za-z0-9_-]{43}$/;
const FEED_MAX_BYTES = 1024 * 1024;
const FEED_MAX = 50000;
const FEED_IDLE_MS = 365 * 24 * 60 * 60 * 1000;
/** Calendar providers whose private iCal links may be fetched for a device (no open proxy). */
const ICS_HOSTS = [/^calendar\.google\.com$/, /^([a-z0-9-]+\.)*icloud\.com$/, /^calendar\.zoho\.(com|eu|in|com\.au|jp)$/, /^outlook\.(office365|live)\.com$/, /^outlook\.office\.com$/];

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
    // Nobody else can spend this free relay's daily quota: every call that writes or does work
    // is limited per IP. Calendar apps reading a feed and "is it collected yet?" polls are not.
    const cheapRead = (req.method === 'GET' || req.method === 'HEAD') && (url.pathname.startsWith('/feed/') || url.searchParams.has('peek') || url.pathname === '/vapid');
    if (!cheapRead && env.LIMITER) {
      const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
      const route = url.pathname.split('/')[1] || 'root';
      const { success } = await env.LIMITER.limit({ key: `${ip}:${route}` }).catch(() => ({ success: true }));
      if (!success) return json({ error: 'too many requests, try again in a minute' }, 429, { ...cors, 'Retry-After': '60' });
    }
    try {
      if (req.method === 'GET' && url.pathname === '/vapid') return json({ publicKey: env.VAPID_PUBLIC }, 200, cors);

      // ── Google sign-in that lasts (code → refresh token, returned to the device only) ──
      // Scan to set up: no device registration needed (a brand-new device has none yet).
      if (url.pathname.startsWith('/feed/')) return await feed(req, env, cors, url.pathname.slice(6));

      if (url.pathname.startsWith('/pair/')) return await pair(req, env, cors, url.pathname.slice(6), url.searchParams.has('peek'));

      if (url.pathname.startsWith('/oauth/')) {
        if (!allowed.includes(origin)) return json({ error: 'origin not allowed' }, 403, cors);
        if (req.method === 'GET' && url.pathname === '/oauth/config') {
          return json({ enabled: !!env.GOOGLE_CLIENT_SECRET, clientId: env.GOOGLE_CLIENT_ID }, 200, cors);
        }
        if (!env.GOOGLE_CLIENT_SECRET) return json({ error: 'not configured' }, 501, cors);
        if (req.method === 'POST' && url.pathname === '/oauth/token') {
          const b = (await readJson(req)) as { code?: string; code_verifier?: string; redirect_uri?: string };
          const redirect = String(b.redirect_uri ?? '');
          // The redirect must be one of the app's own origins (Google checks the exact URI too).
          if (!b.code || !b.code_verifier || !allowed.some((o) => redirect === o || redirect.startsWith(`${o}/`))) {
            return json({ error: 'bad request' }, 400, cors);
          }
          return googleToken(env, cors, {
            grant_type: 'authorization_code',
            code: String(b.code),
            code_verifier: String(b.code_verifier),
            redirect_uri: redirect
          });
        }
        if (req.method === 'POST' && url.pathname === '/oauth/refresh') {
          const b = (await readJson(req)) as { refresh_token?: string };
          if (!b.refresh_token || b.refresh_token.length > 2048) return json({ error: 'bad request' }, 400, cors);
          return googleToken(env, cors, { grant_type: 'refresh_token', refresh_token: String(b.refresh_token) });
        }
        return json({ error: 'not found' }, 404, cors);
      }

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
        const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first<{ n: number }>();
        if ((count?.n ?? 0) >= MAX_DEVICES) return json({ error: 'busy, try again later' }, 503, cors);
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

      // Linked calendars: a device's private iCal link, fetched on its behalf (browsers can't,
      // because calendar providers don't allow cross-origin reads). Allowlisted hosts only; the
      // link and the calendar are never stored or logged.
      // A task finished from a notification or widget: forget its future rings.
      if (req.method === 'POST' && url.pathname === '/cancel') {
        const body = (await readJson(req)) as { ref?: string };
        if (typeof body.ref !== 'string' || body.ref.length > 200) return json({ error: 'bad request' }, 400, cors);
        await env.DB.prepare('DELETE FROM reminders WHERE device_id=? AND ref=?').bind(device, body.ref).run();
        return json({ ok: true }, 200, cors);
      }

      // Linked calendars: a device's private iCal link, fetched on its behalf (browsers can't,
      // because calendar providers don't allow cross-origin reads). The link comes in the POST
      // body (never in a URL, so it isn't in any request log); allowlisted hosts only, every
      // redirect hop re-checked; nothing is stored or logged.
      if (req.method === 'POST' && url.pathname === '/ics') {
        const body = (await readJson(req)) as { url?: string };
        let target: URL;
        try {
          target = new URL(String(body.url ?? '').replace(/^webcals?:/i, 'https:'));
        } catch {
          return json({ error: 'bad url' }, 400, cors);
        }
        const okHost = (u: URL) => u.protocol === 'https:' && !u.port && ICS_HOSTS.some((h) => h.test(u.hostname));
        if (!okHost(target)) return json({ error: 'calendar host not supported' }, 400, cors);
        let res: Response | null = null;
        for (let hop = 0; hop < 4; hop++) {
          res = await fetch(target.toString(), {
            headers: { Accept: 'text/calendar, text/plain;q=0.8' },
            redirect: 'manual',
            signal: AbortSignal.timeout(20_000)
          }).catch(() => null);
          if (!res || res.status < 300 || res.status >= 400) break;
          const loc = res.headers.get('Location');
          if (!loc) break;
          const next = new URL(loc, target);
          if (!okHost(next)) return json({ error: 'redirected off host' }, 502, cors);
          target = next;
          res = null;
        }
        if (!res || !res.ok || !res.body) return json({ error: 'calendar unreachable', status: res?.status ?? 0 }, 502, cors);
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > ICS_MAX_BYTES) {
            await reader.cancel();
            return json({ error: 'calendar too large' }, 413, cors);
          }
          chunks.push(value);
        }
        const text = new TextDecoder().decode(concat(...chunks));
        if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2048))) return json({ error: 'not a calendar' }, 422, cors);
        return new Response(text, {
          status: 200,
          headers: { ...cors, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' }
        });
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
    ctx.waitUntil(ensurePairTable(env).then(() => env.DB.prepare('DELETE FROM pairs WHERE expires_at < ?').bind(Date.now()).run()).catch(() => {}));
    // Once a day is plenty for forgotten calendar feeds.
    if (new Date(_evt.scheduledTime).getUTCHours() === 3 && new Date(_evt.scheduledTime).getUTCMinutes() === 0) {
      ctx.waitUntil(ensureFeedTable(env).then(() => env.DB.prepare('DELETE FROM feeds WHERE updated_at < ?').bind(Date.now() - FEED_IDLE_MS).run()).catch(() => {}));
      // Devices that haven't checked in for months (browser data cleared, app removed).
      const stale = Date.now() - DEVICE_IDLE_MS;
      ctx.waitUntil(env.DB.batch([
        env.DB.prepare('DELETE FROM reminders WHERE device_id IN (SELECT id FROM devices WHERE seen_at < ?)').bind(stale),
        env.DB.prepare('DELETE FROM devices WHERE seen_at < ?').bind(stale)
      ]).catch(() => {}));
    }
  }
};

// ─── Calendar feed ─────────────────────────────────────────────────────────────

let feedTableReady = false;
async function ensureFeedTable(env: Env): Promise<void> {
  if (feedTableReady) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS feeds (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, ics TEXT NOT NULL, updated_at INTEGER NOT NULL)').run();
  feedTableReady = true;
}

async function sha256Hex(text: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare (both are hex digests of equal length). */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * GET  /feed/<secret>.ics            the calendar (for Google / Apple / Outlook; conditional GET).
 * PUT  /feed/<secret>  Bearer <key>  replace it (the first PUT claims the address for that key).
 * DELETE /feed/<secret> Bearer <key> turn it off.
 */
async function feed(req: Request, env: Env, cors: Record<string, string>, rest: string): Promise<Response> {
  const secret = rest.replace(/\.ics$/i, '');
  if (!FEED_ID.test(secret)) return new Response('Not found', { status: 404 });
  await ensureFeedTable(env);
  const id = await sha256Hex(`feed:${secret}`);

  if (req.method === 'GET' || req.method === 'HEAD') {
    const row = await env.DB.prepare('SELECT ics, updated_at FROM feeds WHERE id=?').bind(id).first<{ ics: string; updated_at: number }>();
    if (!row) return new Response('Not found', { status: 404, headers: { ...cors, 'Cache-Control': 'no-store' } });
    const etag = `"${row.updated_at.toString(36)}"`;
    const headers = {
      ...cors,
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
      ETag: etag,
      'Last-Modified': new Date(row.updated_at).toUTCString(),
      'X-Robots-Tag': 'noindex'
    };
    if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
    return new Response(req.method === 'HEAD' ? null : row.ics, { status: 200, headers });
  }

  const auth = req.headers.get('Authorization') ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return json({ error: 'unauthorized' }, 401, cors);
  const keyHash = await sha256Hex(`feedkey:${key}`);
  const row = await env.DB.prepare('SELECT key_hash FROM feeds WHERE id=?').bind(id).first<{ key_hash: string }>();
  if (row && !sameHash(row.key_hash, keyHash)) return json({ error: 'unauthorized' }, 401, cors);

  if (req.method === 'DELETE') {
    if (row) await env.DB.prepare('DELETE FROM feeds WHERE id=?').bind(id).run();
    return json({ ok: true }, 200, cors);
  }
  if (req.method === 'PUT') {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > FEED_MAX_BYTES) return json({ error: 'calendar too large' }, 413, cors);
    if (!/^BEGIN:VCALENDAR\r?\n/.test(text) || !/END:VCALENDAR\s*$/.test(text)) return json({ error: 'not a calendar' }, 422, cors);
    const now = Date.now();
    if (!row) {
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM feeds').first<{ n: number }>();
      if ((n?.n ?? 0) >= FEED_MAX) return json({ error: 'busy, try again later' }, 503, cors);
      await env.DB.prepare('INSERT OR IGNORE INTO feeds (id, key_hash, ics, updated_at) VALUES (?,?,?,?)').bind(id, keyHash, text, now).run();
    } else {
      await env.DB.prepare('UPDATE feeds SET ics=?, updated_at=? WHERE id=? AND key_hash=?').bind(text, now, id, keyHash).run();
    }
    return json({ ok: true, updatedAt: now }, 200, cors);
  }
  return json({ error: 'not found' }, 404, cors);
}

// ─── Scan to set up ────────────────────────────────────────────────────────────

let pairTableReady = false;
async function ensurePairTable(env: Env): Promise<void> {
  if (pairTableReady) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS pairs (id TEXT PRIMARY KEY, blob TEXT NOT NULL, expires_at INTEGER NOT NULL)').run();
  pairTableReady = true;
}

/** PUT stores an encrypted hand-over once; GET returns it once and deletes it. */
async function pair(req: Request, env: Env, cors: Record<string, string>, id: string, peek: boolean): Promise<Response> {
  if (!PAIR_ID.test(id)) return json({ error: 'bad id' }, 400, cors);
  await ensurePairTable(env);
  const now = Date.now();
  if (req.method === 'PUT') {
    const text = await req.text();
    if (text.length > PAIR_MAX_CHARS + 64) return json({ error: 'too large' }, 413, cors);
    let blob = '';
    try {
      blob = String((JSON.parse(text) as { blob?: unknown }).blob ?? '');
    } catch {
      return json({ error: 'bad request' }, 400, cors);
    }
    if (!blob || blob.length > PAIR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(blob)) return json({ error: 'bad request' }, 400, cors);
    const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM pairs WHERE expires_at >= ?').bind(now).first<{ n: number }>();
    if ((pending?.n ?? 0) >= PAIR_MAX_PENDING) return json({ error: 'busy, try again in a minute' }, 503, cors);
    const res = await env.DB.prepare('INSERT OR IGNORE INTO pairs (id, blob, expires_at) VALUES (?,?,?)').bind(id, blob, now + PAIR_TTL_MS).run();
    if (!res.meta.changes) return json({ error: 'already used' }, 409, cors);
    return json({ ok: true, expiresAt: now + PAIR_TTL_MS }, 201, cors);
  }
  // ?peek: is it still waiting? Lets the sending screen show "received" without reading it.
  if (req.method === 'GET' && peek) {
    const row = await env.DB.prepare('SELECT 1 AS w FROM pairs WHERE id=? AND expires_at >= ?').bind(id, now).first<{ w: number }>();
    return json({ waiting: !!row }, 200, { ...cors, 'Cache-Control': 'no-store' });
  }
  if (req.method === 'GET') {
    const row = await env.DB.prepare('DELETE FROM pairs WHERE id=? AND expires_at >= ? RETURNING blob').bind(id, now).first<{ blob: string }>();
    if (!row) return json({ error: 'not found' }, 404, { ...cors, 'Cache-Control': 'no-store' });
    return json({ blob: row.blob }, 200, { ...cors, 'Cache-Control': 'no-store' });
  }
  return json({ error: 'not found' }, 404, cors);
}

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
      if (now - r.fire_at > MAX_LATE_MS) return; // stale: forget it silently
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

// ─── Google OAuth token endpoint ───────────────────────────────────────────────

async function googleToken(env: Env, cors: Record<string, string>, params: Record<string, string>): Promise<Response> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET ?? '' })
  });
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Only Google's error code goes back (e.g. invalid_grant = the user removed access).
    return json({ error: typeof out.error === 'string' ? out.error : 'token_error' }, res.status === 400 ? 400 : 502, cors);
  }
  return json(
    {
      access_token: out.access_token,
      expires_in: out.expires_in,
      scope: out.scope,
      ...(typeof out.refresh_token === 'string' ? { refresh_token: out.refresh_token } : {})
    },
    200,
    { ...cors, 'Cache-Control': 'no-store' }
  );
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
