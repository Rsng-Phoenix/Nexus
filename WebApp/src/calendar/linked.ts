import { signal } from '@preact/signals';
import { PUSH_WORKER_URL } from '../config';
import * as db from '../db/tasks';
import { workerAuth } from '../reminders/push';
import { getSettings, patchSettings, type LinkedCalendar } from '../settings/store';
import { parseIcs, type IcsEvent } from './ics';

/**
 * Linked calendars (read-only): private iCal links from Google, iCloud, Zoho or Outlook.
 * Browsers can't read those links directly (no CORS), so the Nexus relay fetches them for this
 * device only; the link lives in this device's settings and the calendar text in IndexedDB.
 */
/** [attemptedAt]: last try, successful or not, so a broken link isn't retried every minute. */
export type LinkedState = { events: IcsEvent[]; fetchedAt: number; attemptedAt?: number; error?: string; loading?: boolean };
export const linkedState = signal<Record<string, LinkedState>>({});

const cacheKey = (id: string) => `ics:${id}`;
const MINUTE = 60_000;
/** Opening the calendar re-checks anything older than this, whatever the interval. */
const ON_OPEN_MS = 2 * MINUTE;
const inFlight = new Map<string, Promise<void>>();

const updated = new Set<() => void>();
/** Called after a calendar's events change (fresh download or cached copy loaded). */
export function onLinkedUpdated(fn: () => void): () => void {
  updated.add(fn);
  return () => updated.delete(fn);
}
const notifyUpdated = () => updated.forEach((f) => f());

function set(id: string, patch: Partial<LinkedState>) {
  const cur = linkedState.value[id] ?? { events: [], fetchedAt: 0 };
  linkedState.value = { ...linkedState.value, [id]: { ...cur, ...patch } };
}

/** Normalise what people paste (webcal://, spaces) and check it's a link we can fetch. */
export function normaliseCalendarUrl(raw: string): string | null {
  const s = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export type Provider = 'google' | 'apple' | 'zoho' | 'outlook' | 'other';

/**
 * Which service a linked calendar comes from, from its link's host (same rules as Android
 * LinkedCalendars.calendarProvider). Shown next to every event so it's clear whose it is.
 */
export function calendarProvider(url: string): { id: Provider; label: string } {
  let host = '';
  try {
    host = new URL(url.replace(/^webcals?:\/\//i, 'https://')).hostname.toLowerCase();
  } catch {
    return { id: 'other', label: 'Calendar' };
  }
  const ends = (...d: string[]) => d.some((x) => host === x || host.endsWith(`.${x}`));
  if (ends('google.com', 'googleusercontent.com')) return { id: 'google', label: 'Google' };
  if (ends('icloud.com', 'me.com')) return { id: 'apple', label: 'iCloud' };
  if (host.includes('zoho.')) return { id: 'zoho', label: 'Zoho' };
  if (ends('outlook.com', 'office365.com', 'live.com', 'office.com', 'hotmail.com')) return { id: 'outlook', label: 'Outlook' };
  return { id: 'other', label: host.replace(/^www\./, '') || 'Calendar' };
}

/** "Google · Work", or just "Google" when the calendar is named after its service. */
export function calendarSourceLabel(cal: { name: string; url: string }): string {
  const p = calendarProvider(cal.url).label;
  return cal.name.trim().toLowerCase() === p.toLowerCase() ? p : `${p} · ${cal.name}`;
}

export const CALENDAR_COLORS = ['#3B9EFF', '#A78BFA', '#F472B6', '#34D399', '#FBBF24', '#F97316', '#22D3EE'];

async function loadCached(cal: LinkedCalendar): Promise<void> {
  if (linkedState.value[cal.id]?.events.length) return;
  try {
    const raw = await db.getMeta(cacheKey(cal.id));
    if (!raw) return;
    const { text, at } = JSON.parse(raw) as { text: string; at: number };
    set(cal.id, { events: parseIcs(text), fetchedAt: at });
    notifyUpdated();
  } catch {
    /* corrupt cache: refetch */
  }
}

/** Fetch one calendar; a second call while one is running shares it. */
export function fetchCalendar(cal: LinkedCalendar): Promise<void> {
  const running = inFlight.get(cal.id);
  if (running) return running;
  const p = doFetch(cal).finally(() => inFlight.delete(cal.id));
  inFlight.set(cal.id, p);
  return p;
}

async function doFetch(cal: LinkedCalendar): Promise<void> {
  const auth = await workerAuth();
  if (!auth || !PUSH_WORKER_URL) {
    set(cal.id, { error: 'Turn on notifications in Settings to link calendars (the relay needs this device registered).' });
    return;
  }
  set(cal.id, { loading: true, error: undefined, attemptedAt: Date.now() });
  try {
    // The private link goes in the body, never in a URL (request logs).
    const res = await fetch(`${PUSH_WORKER_URL}/ics`, { method: 'POST', headers: auth, body: JSON.stringify({ url: cal.url }) });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      set(cal.id, { loading: false, error: body.error ? `Couldn't load: ${body.error}` : `Couldn't load (${res.status})` });
      return;
    }
    const text = await res.text();
    const events = parseIcs(text);
    const at = Date.now();
    set(cal.id, { events, fetchedAt: at, loading: false, error: undefined });
    await db.setMeta(cacheKey(cal.id), JSON.stringify({ text, at }));
    notifyUpdated();
  } catch {
    set(cal.id, { loading: false, error: "You're offline — showing the last copy" });
  }
}

/**
 * Load cached copies, then refresh anything older than [maxAgeMs] (default: the user's
 * "check every" interval). A failed fetch keeps the last good copy on screen.
 */
export async function refreshLinked(force = false, maxAgeMs?: number): Promise<void> {
  const s = getSettings();
  const stale = maxAgeMs ?? s.calendarRefreshMinutes * MINUTE;
  await Promise.all(
    s.linkedCalendars.map(async (c) => {
      await loadCached(c);
      const st = linkedState.value[c.id];
      if (c.enabled && (force || !st || Date.now() - Math.max(st.fetchedAt, st.attemptedAt ?? 0) > stale)) await fetchCalendar(c);
    })
  );
}

export function addLinkedCalendar(name: string, url: string): LinkedCalendar {
  const cals = getSettings().linkedCalendars;
  const cal: LinkedCalendar = {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 40) || 'Calendar',
    url,
    color: CALENDAR_COLORS[cals.length % CALENDAR_COLORS.length],
    enabled: true
  };
  patchSettings({ linkedCalendars: [...cals, cal] });
  void fetchCalendar(cal);
  return cal;
}

export function updateLinkedCalendar(id: string, patch: Partial<LinkedCalendar>): void {
  patchSettings({ linkedCalendars: getSettings().linkedCalendars.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
}

export async function removeLinkedCalendar(id: string): Promise<void> {
  patchSettings({ linkedCalendars: getSettings().linkedCalendars.filter((c) => c.id !== id) });
  const { [id]: _gone, ...rest } = linkedState.value;
  linkedState.value = rest;
  await db.deleteMeta(cacheKey(id));
}

/** The calendar page was opened: anything older than a couple of minutes is re-checked. */
export const refreshLinkedOnOpen = () => refreshLinked(false, ON_OPEN_MS);

/** Oldest successful fetch among shown calendars (0 = never), for "Updated 4 min ago". */
export function linkedUpdatedAt(): number {
  const shown = getSettings().linkedCalendars.filter((c) => c.enabled);
  if (!shown.length) return 0;
  return Math.min(...shown.map((c) => linkedState.value[c.id]?.fetchedAt ?? 0));
}

let autoStarted = false;
/**
 * Keep linked calendars current while Nexus is open: on start, whenever it comes back to the
 * front or back online, and a check every minute (each calendar is only fetched once its
 * interval has passed, so this costs nothing in between).
 */
export function startLinkedAutoRefresh(): void {
  if (autoStarted || typeof window === 'undefined') return;
  autoStarted = true;
  const tick = () => {
    if (document.visibilityState === 'visible' && navigator.onLine && getSettings().linkedCalendars.length) void refreshLinked();
  };
  tick();
  window.setInterval(tick, MINUTE);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('online', tick);
  window.addEventListener('focus', tick);
}
