import { PUSH_WORKER_URL } from '../config';
import { getSettings, type LinkedCalendar, type LinkedSheet, type Settings, type SheetMapping } from '../settings/store';

/**
 * Scan to set up: copy linked calendars and preferences from one device to another with a QR
 * code (or a link). Identical wire format on Android.
 *
 *   link  = <app>/?pair=<id>&m=<send|get>#k=<key>
 *   blob  = base64url(iv[12] ‖ AES-256-GCM(key, JSON payload, aad = id))
 *
 * m=get  — the device showing the code already uploaded its setup; whoever opens the link gets it.
 * m=send — the device showing the code wants a setup; whoever opens the link sends theirs, and
 *          the showing device picks it up by polling.
 * The key only ever travels in the URL fragment (never sent to a server), so the relay stores an
 * unreadable blob for at most 10 minutes, readable once.
 */

export type PairMode = 'send' | 'get';
export type PairLink = { id: string; key: string; mode: PairMode };

export type SetupCalendar = { name: string; url: string; color: string; enabled: boolean };
/** A linked Google Sheet (its address and column choices); the receiver reads it itself. */
export type SetupSheet = { name: string; sheetId: string; gid: string; mapping: SheetMapping };
export type SetupPayload = {
  v: 1;
  /** "Chrome on Mac", shown to the receiver. */
  from: string;
  at: number;
  calendars: SetupCalendar[];
  /** Optional (older senders leave it out). */
  sheets?: SetupSheet[];
  prefs: Partial<Settings>;
  /** Google account to suggest when signing in on the new device. */
  account?: string;
};

/** Preferences that travel with a setup (same names as Android AppSettings). */
export const SETUP_PREF_KEYS = [
  'displayName',
  'themeMode',
  'fontScale',
  'weekStart',
  'startView',
  'autoArrange',
  'calendarRefreshMinutes',
  'notifyReminders',
  'notifyDeadlines',
  'notifyMeetings',
  'meetingLeadMinutes',
  'clashRadar',
  'clashMinMinutes',
  'defaultDueAlerts',
  'defaultDueAlertTime',
  'groupNotifications',
  'maxNotificationsPerHour',
  'snoozeMinutes',
  'checkInEnabled',
  'checkInDays',
  'windowStart',
  'windowEnd',
  'trashDays',
  'retentionDays',
  'vibrationEnabled',
  'vibrationStrength'
] as const satisfies readonly (keyof Settings)[];

export const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_CALENDARS = 30;
const MAX_SHEETS = 20;

// ─── bytes ─────────────────────────────────────────────────────────────────────

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export function newPairLink(mode: PairMode): PairLink {
  return { id: b64u(random(16)), key: b64u(random(32)), mode };
}

// ─── links ─────────────────────────────────────────────────────────────────────

/** Where the app lives, e.g. https://rsng-phoenix.github.io/Nexus/ */
export function appBaseUrl(): string {
  return new URL(import.meta.env.BASE_URL || '/', location.origin).toString();
}

export function pairUrl(link: PairLink, base = appBaseUrl()): string {
  return `${base}?pair=${link.id}&m=${link.mode}#k=${link.key}`;
}

/** Reads a scanned code / opened link; null when it is not a Nexus pairing link. */
export function parsePairLink(raw: string): PairLink | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const id = u.searchParams.get('pair') ?? '';
  const mode = u.searchParams.get('m');
  const key = new URLSearchParams(u.hash.replace(/^#/, '')).get('k') ?? '';
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
  if (mode !== 'send' && mode !== 'get') return null;
  return { id, key, mode };
}

/** Four digits both screens show, so you can tell the code came from your own device. */
export async function verifyCode(link: PairLink): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${link.id}.${link.key}`)));
  return String(((h[0] << 16) | (h[1] << 8) | h[2]) % 10000).padStart(4, '0');
}

// ─── crypto ────────────────────────────────────────────────────────────────────

async function aesKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', unb64u(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealPayload(link: PairLink, payload: SetupPayload): Promise<string> {
  const iv = random(12);
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(link.id) }, await aesKey(link.key), data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64u(out);
}

export async function openPayload(link: PairLink, blob: string): Promise<SetupPayload> {
  const bytes = unb64u(blob);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(link.id) },
    await aesKey(link.key),
    bytes.slice(12)
  );
  return cleanPayload(JSON.parse(new TextDecoder().decode(plain)));
}

// ─── payload ───────────────────────────────────────────────────────────────────

export function deviceName(ua = navigator.userAgent): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'a device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Nexus';
  return `${browser} on ${os}`;
}

export function buildPayload(s: Settings = getSettings()): SetupPayload {
  const prefs: Partial<Settings> = {};
  for (const k of SETUP_PREF_KEYS) (prefs as Record<string, unknown>)[k] = s[k];
  const account = s.googleEmail || s.dataOwnerEmail;
  return {
    v: 1,
    from: deviceName(),
    at: Date.now(),
    calendars: s.linkedCalendars.slice(0, MAX_CALENDARS).map(({ name, url, color, enabled }) => ({ name, url, color, enabled })),
    ...(s.linkedSheets.length ? { sheets: s.linkedSheets.slice(0, MAX_SHEETS).map(({ name, sheetId, gid, mapping }) => ({ name, sheetId, gid, mapping })) } : {}),
    prefs,
    ...(account ? { account } : {})
  };
}

/** Keeps only well-formed fields: the payload came from another device, so trust nothing. */
export function cleanPayload(raw: unknown, defaults: Settings = getSettings()): SetupPayload {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.v !== 1) throw new Error('This code is from a newer Nexus. Update Nexus on this device and scan again.');
  const calendars: SetupCalendar[] = [];
  for (const c of Array.isArray(o.calendars) ? o.calendars.slice(0, MAX_CALENDARS) : []) {
    const x = (c ?? {}) as Record<string, unknown>;
    const url = typeof x.url === 'string' ? x.url.trim() : '';
    if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 2048) continue;
    calendars.push({
      name: typeof x.name === 'string' ? x.name.slice(0, 40) : 'Calendar',
      url,
      color: typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : '#3B9EFF',
      enabled: x.enabled !== false
    });
  }
  const sheets: SetupSheet[] = [];
  for (const raw of Array.isArray(o.sheets) ? o.sheets.slice(0, MAX_SHEETS) : []) {
    const x = (raw ?? {}) as Record<string, unknown>;
    const mapping = cleanMapping(x.mapping);
    if (typeof x.sheetId !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(x.sheetId) || x.sheetId.length > 100) continue;
    if (typeof x.gid !== 'string' || !/^\d{0,12}$/.test(x.gid) || !mapping) continue;
    sheets.push({ name: typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 60) : 'Google Sheet', sheetId: x.sheetId, gid: x.gid, mapping });
  }
  const prefs: Partial<Settings> = {};
  const inPrefs = (o.prefs && typeof o.prefs === 'object' ? o.prefs : {}) as Record<string, unknown>;
  for (const k of SETUP_PREF_KEYS) {
    const v = inPrefs[k];
    if (v !== undefined && typeof v === typeof defaults[k]) (prefs as Record<string, unknown>)[k] = v;
  }
  const account = typeof o.account === 'string' && /^[^\s@]+@[^\s@]+$/.test(o.account) ? o.account.toLowerCase() : undefined;
  return {
    v: 1,
    from: typeof o.from === 'string' ? o.from.slice(0, 60) : 'another device',
    at: Number.isFinite(o.at) ? Number(o.at) : 0,
    calendars,
    ...(sheets.length ? { sheets } : {}),
    prefs,
    ...(account ? { account } : {})
  };
}

const PRIORITY_NAMES = ['HIGH', 'MEDIUM', 'LOW', 'NONE'] as const;
type P = (typeof PRIORITY_NAMES)[number];
const colIndex = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 500 ? (v as number) : null);
const colList = (v: unknown) => (Array.isArray(v) ? v.map(colIndex).filter((n): n is number => n !== null).slice(0, 20) : []);

/** A sheet's column choices from another device: only well-formed values, else null. */
export function cleanMapping(raw: unknown): SheetMapping | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const dateCol = colIndex(m.dateCol);
  const headerRow = Number.isInteger(m.headerRow) && (m.headerRow as number) >= -1 && (m.headerRow as number) < 1000 ? (m.headerRow as number) : null;
  if (dateCol === null || headerRow === null) return null;
  const titleCols = colList(m.titleCols);
  const titleText = typeof m.titleText === 'string' ? m.titleText.trim().slice(0, 80) : '';
  if (!titleCols.length && !titleText) return null;
  const isP = (v: unknown): v is P => PRIORITY_NAMES.includes(v as P);
  let priority: SheetMapping['priority'] = 'MEDIUM';
  if (isP(m.priority)) priority = m.priority;
  else if (m.priority && typeof m.priority === 'object') {
    const pr = m.priority as Record<string, unknown>;
    const col = colIndex(pr.col);
    if (col !== null) priority = { col, ...(isP(pr.fallback) ? { fallback: pr.fallback } : {}) };
  }
  const offsets = Array.isArray(m.offsets) ? m.offsets.filter((n) => Number.isInteger(n) && (n as number) >= -366 && (n as number) <= 366).slice(0, 10) as number[] : [0];
  const alertTime = Number.isInteger(m.alertTime) && (m.alertTime as number) >= 0 && (m.alertTime as number) < 1440 ? (m.alertTime as number) : 540;
  return { headerRow, titleCols, titleText, dateCol, notesCols: colList(m.notesCols), priority, offsets, alertTime, dayFirst: m.dayFirst !== false };
}

/** Sheets in [p] that this device doesn't read yet. */
export function newSheets(p: SetupPayload, have: LinkedSheet[]): SetupSheet[] {
  const known = new Set(have.map((l) => `${l.sheetId}|${l.gid}`));
  return (p.sheets ?? []).filter((x) => !known.has(`${x.sheetId}|${x.gid}`));
}

/** Calendars in the payload that this device doesn't have yet (matched by link). */
export function newCalendars(p: SetupPayload, have: LinkedCalendar[]): SetupCalendar[] {
  const known = new Set(have.map((c) => c.url));
  return p.calendars.filter((c) => !known.has(c.url));
}

// ─── relay ─────────────────────────────────────────────────────────────────────

export async function uploadSetup(link: PairLink, payload: SetupPayload): Promise<void> {
  const res = await fetch(`${PUSH_WORKER_URL}/pair/${link.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blob: await sealPayload(link, payload) })
  });
  if (!res.ok) throw new Error(res.status === 409 ? 'That code was already used. Make a new one.' : 'Could not reach Nexus. Check your connection.');
}

/** The setup waiting for this code, or null while nothing is there yet. */
export async function collectSetup(link: PairLink): Promise<SetupPayload | null> {
  const res = await fetch(`${PUSH_WORKER_URL}/pair/${link.id}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Could not reach Nexus. Check your connection.');
  const { blob } = (await res.json()) as { blob: string };
  try {
    return await openPayload(link, blob);
  } catch (e) {
    throw e instanceof Error && e.message.includes('newer') ? e : new Error('This code could not be opened. Make a new one on the other device.');
  }
}

/** False once the other device has collected (or the code expired). */
export async function stillWaiting(link: PairLink): Promise<boolean> {
  const res = await fetch(`${PUSH_WORKER_URL}/pair/${link.id}?peek`, { cache: 'no-store' });
  if (!res.ok) return true;
  return ((await res.json()) as { waiting: boolean }).waiting;
}
