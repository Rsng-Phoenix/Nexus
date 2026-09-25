import { signal } from '@preact/signals';
import { PUSH_WORKER_URL } from '../config';
import * as db from '../db/tasks';
import { fromStorage, toPlainText } from '../notes/codec';
import { getSettings, patchSettings, type FeedCreds } from '../settings/store';
import type { Task } from '../types';
import { deleteFile, readAppFile, writeAppFile } from '../sync/drive';
import { exportIcs } from './ics';

/**
 * "Show Nexus in your calendar apps": a live, read-only iCal feed of your dated tasks that
 * Google, Apple and Outlook Calendar subscribe to. Opt-in. Identical on Android.
 *
 *   feed address  <worker>/feed/<id>.ics      (id: 32 random bytes, base64url)
 *   updates       PUT <worker>/feed/<id>      Authorization: Bearer <key>
 *
 * The address and key are shared between your devices through nexus_calendar_feed.json in the
 * Drive app folder, so a task added on any device reaches the feed. Every device republishes only
 * when the calendar content actually changed.
 */

export const FEED_FILE_NAME = 'nexus_calendar_feed.json';
const PUBLISH_DELAY_MS = 4000;

/** When the feed was last sent (for "Updated 2 min ago"), and whether the last try failed. */
export const feedStatus = signal<{ at: number; error: string }>({ at: 0, error: '' });

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random32 = () => b64u(crypto.getRandomValues(new Uint8Array(32)));

export function newFeedCreds(notes = false): FeedCreds {
  return { v: 1, id: random32(), key: random32(), createdAt: Date.now(), notes, shared: false };
}

export function feedLinks(c: Pick<FeedCreds, 'id'>, base = PUSH_WORKER_URL) {
  const https = `${base}/feed/${c.id}.ics`;
  const webcal = https.replace(/^https?:\/\//, 'webcal://');
  return {
    https,
    webcal,
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent('Nexus')}`
  };
}

/** Open tasks with a deadline or reminder: what the calendar apps show. */
export function feedTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.deletedAt === 0 && !(t.archivedAt > 0) && !t.isCompleted && !t.isWontDo && (!!t.dueDate || t.reminderTime != null));
}

export function buildFeed(tasks: Task[], notes: boolean, now = Date.now()): string {
  return exportIcs(feedTasks(tasks), {
    now,
    calName: 'Nexus',
    notesToText: notes ? (n) => toPlainText(fromStorage(n)) : () => ''
  });
}

/** Content fingerprint that ignores DTSTAMP (it changes on every export). */
async function contentHash(ics: string): Promise<string> {
  const stable = ics.replace(/^DTSTAMP:.*$/gm, '');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable)));
  return b64u(h);
}

async function send(c: FeedCreds, method: 'PUT' | 'DELETE', body?: string): Promise<void> {
  const res = await fetch(`${PUSH_WORKER_URL}/feed/${c.id}`, {
    method,
    headers: { Authorization: `Bearer ${c.key}`, ...(body ? { 'Content-Type': 'text/calendar' } : {}) },
    body
  });
  if (!res.ok) throw new Error(res.status === 413 ? 'Too many tasks for one calendar feed' : `Could not update the calendar feed (${res.status})`);
}

let publishing: Promise<void> | null = null;
let again = false;

/** Sends the feed when its content changed since the last send (or always with [force]). */
export async function publishFeed(force = false): Promise<void> {
  const c = getSettings().calendarFeed;
  if (!c) return;
  if (publishing) {
    again = true;
    return publishing;
  }
  publishing = (async () => {
    try {
      const ics = buildFeed(await db.getAllTasksIncludingDeleted(), !!c.notes);
      const hash = await contentHash(`${c.id}\n${ics}`);
      if (!force && (await db.getMeta('feed_hash')) === hash) return;
      await send(c, 'PUT', ics);
      await db.setMeta('feed_hash', hash);
      feedStatus.value = { at: Date.now(), error: '' };
      await db.setMeta('feed_at', String(Date.now()));
    } catch (e) {
      feedStatus.value = { ...feedStatus.value, error: e instanceof Error ? e.message : 'Could not update the calendar feed' };
    } finally {
      publishing = null;
    }
  })();
  await publishing;
  if (again) {
    again = false;
    await publishFeed();
  }
}

let timer = 0;
/** After task edits: one send a few seconds after the last change. */
export function schedulePublishFeed(): void {
  if (!getSettings().calendarFeed) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => void publishFeed(), PUBLISH_DELAY_MS);
}

export async function loadFeedStatus(): Promise<void> {
  const at = Number((await db.getMeta('feed_at')) || 0);
  feedStatus.value = { at, error: '' };
}

// ─── Turning it on and off ─────────────────────────────────────────────────────

export async function enableFeed(notes = false): Promise<FeedCreds> {
  const c = newFeedCreds(notes);
  patchSettings({ calendarFeed: c });
  await db.setMeta('feed_hash', '');
  await publishFeed(true);
  return c;
}

/** Stops the feed everywhere: the address stops working in every calendar app. */
export async function disableFeed(token?: string | null): Promise<void> {
  const c = getSettings().calendarFeed;
  patchSettings({ calendarFeed: null });
  await db.setMeta('feed_hash', '');
  feedStatus.value = { at: 0, error: '' };
  if (c) await send(c, 'DELETE').catch(() => {});
  if (token) {
    const f = await readAppFile(token, FEED_FILE_NAME).catch(() => null);
    if (f) await deleteFile(token, f.id).catch(() => {});
  }
}

/** A new address; the old one stops working (for a link that was shared by mistake). */
export async function resetFeed(token?: string | null): Promise<FeedCreds> {
  const notes = !!getSettings().calendarFeed?.notes;
  await disableFeed(null);
  const c = await enableFeed(notes);
  if (token) await shareFeedCreds(token);
  return c;
}

export async function setFeedNotes(notes: boolean, token?: string | null): Promise<void> {
  const c = getSettings().calendarFeed;
  if (!c) return;
  patchSettings({ calendarFeed: { ...c, notes, shared: false } });
  await publishFeed(true);
  if (token) await shareFeedCreds(token);
}

// ─── Sharing between your devices (Drive) ──────────────────────────────────────

function parseCreds(text: string): FeedCreds | null {
  try {
    const o = JSON.parse(text) as Partial<FeedCreds>;
    const ok = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
    if (o.v !== 1 || !ok(o.id) || !ok(o.key)) return null;
    return { v: 1, id: o.id as string, key: o.key as string, createdAt: Number(o.createdAt) || 0, notes: !!o.notes, shared: true };
  } catch {
    return null;
  }
}

async function shareFeedCreds(token: string): Promise<void> {
  const c = getSettings().calendarFeed;
  if (!c) return;
  const existing = await readAppFile(token, FEED_FILE_NAME);
  const { shared: _s, ...wire } = c;
  await writeAppFile(token, FEED_FILE_NAME, JSON.stringify(wire), existing?.id ?? null);
  patchSettings({ calendarFeed: { ...c, shared: true } });
}

/**
 * After each sync: agree with your other devices on one feed. A feed turned on here and not yet
 * in Drive is uploaded; one turned on elsewhere is adopted; one turned off elsewhere (it was shared
 * and the Drive file is gone) is turned off here too. Then the feed is refreshed if it changed.
 */
export async function syncFeedCreds(token: string): Promise<void> {
  const local = getSettings().calendarFeed;
  const file = await readAppFile(token, FEED_FILE_NAME);
  const remote = file ? parseCreds(file.text) : null;
  if (remote) {
    const changed = !local || local.id !== remote.id || local.key !== remote.key || !!local.notes !== !!remote.notes;
    if (changed) patchSettings({ calendarFeed: remote });
    else if (!local.shared) patchSettings({ calendarFeed: { ...local, shared: true } });
  } else if (local?.shared) {
    patchSettings({ calendarFeed: null });
    await db.setMeta('feed_hash', '');
    return;
  } else if (local) {
    await shareFeedCreds(token);
  }
  await publishFeed();
}
