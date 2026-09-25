import { getSettings, patchSettings, type LinkedCalendar, type LinkedRemoval } from '../settings/store';
import { readAppFile, writeAppFile } from '../sync/drive';
import { dropLinkedCache, fetchCalendar } from './linked';

/**
 * Linked calendars on all your devices: the links live in nexus_linked_calendars.json in the
 * Drive app folder (private to Nexus and your account), next to the tasks backup. Identical on
 * Android.
 *
 *   { "v": 1,
 *     "calendars": [{ "id", "name", "url", "color", "enabled", "updatedAt" }],
 *     "removed":   [{ "url", "at" }] }
 *
 * Calendars are matched by address. For each address the newest change wins: an add, rename,
 * colour or switch (updatedAt) against a removal (at). Removals are remembered for 180 days so
 * a device that was off for a while doesn't bring a deleted calendar back.
 */

export const LINKED_FILE_NAME = 'nexus_linked_calendars.json';
const REMOVAL_KEEP_MS = 180 * 86_400_000;
const MAX_CALENDARS = 30;

export type LinkedSet = { calendars: LinkedCalendar[]; removed: LinkedRemoval[] };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Reads the Drive file; anything malformed is skipped rather than trusted. */
export function parseLinkedFile(text: string): LinkedSet | null {
  try {
    const o = JSON.parse(text) as { v?: number; calendars?: unknown[]; removed?: unknown[] };
    if (o.v !== 1) return null;
    const calendars: LinkedCalendar[] = [];
    for (const raw of Array.isArray(o.calendars) ? o.calendars : []) {
      const c = raw as Record<string, unknown>;
      const url = str(c.url, 2048);
      if (!/^https:\/\/[^\s]+$/i.test(url)) continue;
      calendars.push({
        id: str(c.id, 64) || crypto.randomUUID(),
        name: str(c.name, 40) || 'Calendar',
        url,
        color: /^#[0-9a-f]{6}$/i.test(str(c.color, 7)) ? str(c.color, 7) : '#4A90E2',
        enabled: c.enabled !== false,
        updatedAt: Number(c.updatedAt) || 0
      });
    }
    const removed: LinkedRemoval[] = [];
    for (const raw of Array.isArray(o.removed) ? o.removed : []) {
      const r = raw as Record<string, unknown>;
      const url = str(r.url, 2048);
      if (url && Number(r.at) > 0) removed.push({ url, at: Number(r.at) });
    }
    return { calendars, removed };
  } catch {
    return null;
  }
}

/** Combines this device's calendars with the shared ones: newest change per address wins. */
export function mergeLinked(local: LinkedSet, remote: LinkedSet | null, now = Date.now()): LinkedSet {
  const tomb = new Map<string, number>();
  for (const r of [...local.removed, ...(remote?.removed ?? [])]) {
    if (now - r.at < REMOVAL_KEEP_MS) tomb.set(r.url, Math.max(tomb.get(r.url) ?? 0, r.at));
  }
  // This device's order first (its ids keep their downloaded copies), then new ones from Drive.
  const byUrl = new Map<string, LinkedCalendar>();
  for (const c of local.calendars) byUrl.set(c.url, c);
  for (const c of remote?.calendars ?? []) {
    const mine = byUrl.get(c.url);
    if (!mine) byUrl.set(c.url, c);
    else if ((c.updatedAt ?? 0) > (mine.updatedAt ?? 0)) byUrl.set(c.url, { ...c, id: mine.id });
  }
  const calendars = [...byUrl.values()].filter((c) => (c.updatedAt ?? 0) > (tomb.get(c.url) ?? -1)).slice(0, MAX_CALENDARS);
  const kept = new Set(calendars.map((c) => c.url));
  const removed = [...tomb].filter(([url]) => !kept.has(url)).map(([url, at]) => ({ url, at }));
  return { calendars, removed };
}

const wire = (s: LinkedSet) =>
  JSON.stringify({
    v: 1,
    calendars: [...s.calendars]
      .sort((a, b) => a.url.localeCompare(b.url))
      .map(({ name, url, color, enabled, updatedAt, id }) => ({ id, name, url, color, enabled, updatedAt: updatedAt ?? 0 })),
    removed: [...s.removed].sort((a, b) => a.url.localeCompare(b.url))
  });

// Ids differ between devices for the same calendar, so "changed" is judged without them.
const sameSet = (a: LinkedSet, b: LinkedSet) => {
  const strip = (s: LinkedSet) => wire({ ...s, calendars: s.calendars.map((c) => ({ ...c, id: '' })) });
  return strip(a) === strip(b);
};

/**
 * After each sync: bring in calendars added, changed or removed on your other devices, and share
 * this device's changes. Writes to Drive only when something actually changed.
 */
export async function syncLinkedCalendars(token: string): Promise<void> {
  const s = getSettings();
  const local: LinkedSet = { calendars: s.linkedCalendars, removed: s.linkedRemoved };
  const file = await readAppFile(token, LINKED_FILE_NAME);
  const remote = file ? parseLinkedFile(file.text) : null;
  if (!remote && !local.calendars.length && !local.removed.length) return;
  const merged = mergeLinked(local, remote);

  if (!sameSet(merged, local) || merged.calendars.some((c, i) => c.id !== local.calendars[i]?.id)) {
    const before = new Map(local.calendars.map((c) => [c.id, c]));
    patchSettings({ linkedCalendars: merged.calendars, linkedRemoved: merged.removed });
    const after = new Set(merged.calendars.map((c) => c.id));
    for (const [id] of before) if (!after.has(id)) await dropLinkedCache(id);
    for (const c of merged.calendars) {
      const was = before.get(c.id);
      if (!was || was.url !== c.url || (!was.enabled && c.enabled)) void fetchCalendar(c);
    }
  }
  if (!remote || !sameSet(merged, remote)) await writeAppFile(token, LINKED_FILE_NAME, wire(merged), file?.id ?? null);
}
