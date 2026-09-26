import * as db from '../db/tasks';
import { getSettings, patchSettings, type LinkedSheet, type SheetMapping } from '../settings/store';
import { readAppFile, writeAppFile } from '../sync/drive';
import { PRIORITIES, type Priority } from '../types';
import { dropSheetSnapshot, refreshSheet } from './liveSheet';

/**
 * Linked Google Sheets on all your devices: the links live in nexus_linked_sheets.json in the Drive
 * app folder (private to Nexus and your account), next to the tasks backup and the linked
 * calendars. Identical on Android (LinkedSheetsSync in LinkedSync.kt).
 *
 *   { "v": 1,
 *     "sheets":  [{ "id", "name", "sheetId", "gid", "mapping", "enabled", "updatedAt" }],
 *     "removed": [{ "sheetId", "gid", "at" }] }
 *
 * Sheets are matched by spreadsheet + tab (sheetId + gid). For each the newest change wins: an add
 * or edit (updatedAt) against a removal (at). Removals are remembered for 180 days so a device that
 * was off for a while doesn't bring an unlinked sheet back. The sheet's tasks themselves already
 * travel through the tasks backup (deterministic ids), so a device that gains a link only re-reads
 * the sheet, it never duplicates anything.
 *
 * settings/store.ts's LinkedSheet has no updatedAt (that file belongs to another change), so this
 * device's timestamps live in IndexedDB meta `linked_sheets_meta`: when each link was made or
 * changed here, and the removals made here. A link from before sync existed has no timestamp and
 * counts as 0: it is kept, but loses to any removal (the calendars behave the same). lastSyncAt is
 * deliberately not used as a stand-in: it advances on every read, which would resurrect a sheet
 * unlinked on another device.
 */

export const LINKED_SHEETS_FILE_NAME = 'nexus_linked_sheets.json';
const META_KEY = 'linked_sheets_meta';
const REMOVAL_KEEP_MS = 180 * 86_400_000;
const MAX_SHEETS = 30;

export type SyncedSheet = { id: string; name: string; sheetId: string; gid: string; mapping: SheetMapping; enabled: boolean; updatedAt: number };
export type SheetRemoval = { sheetId: string; gid: string; at: number };
export type LinkedSheetSet = { sheets: SyncedSheet[]; removed: SheetRemoval[] };

/** One spreadsheet tab, however it was linked. */
export const sheetKey = (r: { sheetId: string; gid: string }) => `${r.sheetId}#${r.gid}`;

const SHEET_ID = /^[A-Za-z0-9_-]{20,}$/;
const GID = /^\d*$/;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const ints = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)).slice(0, 200) : []);
const isPriority = (v: unknown): v is Priority => typeof v === 'string' && (PRIORITIES as string[]).includes(v);

/** The wizard's choices, checked field by field (a bad file must not make a bad task later). */
export function parseMapping(raw: unknown): SheetMapping | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (!Number.isInteger(m.headerRow) || !Number.isInteger(m.dateCol)) return null;
  let priority: SheetMapping['priority'];
  if (isPriority(m.priority)) priority = m.priority;
  else if (m.priority && typeof m.priority === 'object' && Number.isInteger((m.priority as { col?: unknown }).col)) {
    const p = m.priority as { col: number; fallback?: unknown };
    priority = { col: p.col, ...(isPriority(p.fallback) ? { fallback: p.fallback } : {}) };
  } else return null;
  return {
    headerRow: m.headerRow as number,
    titleCols: ints(m.titleCols),
    titleText: str(m.titleText, 200),
    dateCol: m.dateCol as number,
    notesCols: ints(m.notesCols),
    priority,
    offsets: ints(m.offsets),
    alertTime: Number.isInteger(m.alertTime) ? (m.alertTime as number) : 540,
    dayFirst: m.dayFirst !== false
  };
}

/** Reads the Drive file; anything malformed is skipped rather than trusted. */
export function parseLinkedSheetsFile(text: string): LinkedSheetSet | null {
  try {
    const o = JSON.parse(text) as { v?: number; sheets?: unknown[]; removed?: unknown[] };
    if (o.v !== 1) return null;
    const sheets: SyncedSheet[] = [];
    for (const raw of Array.isArray(o.sheets) ? o.sheets : []) {
      const s = raw as Record<string, unknown>;
      const sheetId = str(s.sheetId, 128);
      const gid = str(s.gid, 20);
      const mapping = parseMapping(s.mapping);
      if (!SHEET_ID.test(sheetId) || !GID.test(gid) || !mapping) continue;
      sheets.push({
        id: str(s.id, 64) || crypto.randomUUID(),
        name: str(s.name, 60) || 'Google Sheet',
        sheetId,
        gid,
        mapping,
        enabled: s.enabled !== false,
        updatedAt: Number(s.updatedAt) || 0
      });
    }
    const removed: SheetRemoval[] = [];
    for (const raw of Array.isArray(o.removed) ? o.removed : []) {
      const r = raw as Record<string, unknown>;
      const sheetId = str(r.sheetId, 128);
      const gid = str(r.gid, 20);
      if (SHEET_ID.test(sheetId) && GID.test(gid) && Number(r.at) > 0) removed.push({ sheetId, gid, at: Number(r.at) });
    }
    return { sheets, removed };
  } catch {
    return null;
  }
}

/** Combines this device's sheets with the shared ones: newest change per spreadsheet tab wins. */
export function mergeLinkedSheets(local: LinkedSheetSet, remote: LinkedSheetSet | null, now = Date.now()): LinkedSheetSet {
  const tomb = new Map<string, SheetRemoval>();
  for (const r of [...local.removed, ...(remote?.removed ?? [])]) {
    const k = sheetKey(r);
    if (now - r.at < REMOVAL_KEEP_MS && r.at > (tomb.get(k)?.at ?? 0)) tomb.set(k, r);
  }
  // This device's order first (its ids keep their row snapshots), then new ones from Drive.
  const byKey = new Map<string, SyncedSheet>();
  for (const s of local.sheets) byKey.set(sheetKey(s), s);
  for (const s of remote?.sheets ?? []) {
    const k = sheetKey(s);
    const mine = byKey.get(k);
    if (!mine) byKey.set(k, s);
    else if (s.updatedAt > mine.updatedAt) byKey.set(k, { ...s, id: mine.id });
  }
  const sheets = [...byKey.values()].filter((s) => s.updatedAt > (tomb.get(sheetKey(s))?.at ?? -1)).slice(0, MAX_SHEETS);
  const kept = new Set(sheets.map(sheetKey));
  const removed = [...tomb.values()].filter((r) => !kept.has(sheetKey(r)));
  return { sheets, removed };
}

/** The mapping with its keys in one fixed order, so two devices agree on "changed". */
const wireMapping = (m: SheetMapping) => ({
  headerRow: m.headerRow,
  titleCols: [...m.titleCols],
  dateCol: m.dateCol,
  titleText: m.titleText ?? '',
  notesCols: [...m.notesCols],
  priority: typeof m.priority === 'string' ? m.priority : { col: m.priority.col, fallback: m.priority.fallback ?? 'NONE' },
  offsets: [...m.offsets],
  alertTime: m.alertTime,
  dayFirst: m.dayFirst
});

const byKey = (a: { sheetId: string; gid: string }, b: { sheetId: string; gid: string }) => sheetKey(a).localeCompare(sheetKey(b));

export const wireLinkedSheets = (s: LinkedSheetSet) =>
  JSON.stringify({
    v: 1,
    sheets: [...s.sheets].sort(byKey).map(({ id, name, sheetId, gid, mapping, enabled, updatedAt }) => ({ id, name, sheetId, gid, mapping: wireMapping(mapping), enabled, updatedAt })),
    removed: [...s.removed].sort(byKey).map(({ sheetId, gid, at }) => ({ sheetId, gid, at }))
  });

// Ids differ between devices for the same sheet, so "changed" is judged without them.
const sameSet = (a: LinkedSheetSet, b: LinkedSheetSet) => {
  const strip = (s: LinkedSheetSet) => wireLinkedSheets({ ...s, sheets: s.sheets.map((x) => ({ ...x, id: '' })) });
  return strip(a) === strip(b);
};

// ─── This device's timestamps (IndexedDB meta) ──────────────────────────────

type Meta = { updated: Record<string, number>; removed: Record<string, number> };

async function loadMeta(): Promise<Meta> {
  try {
    const m = await db.getMetaValue<Partial<Meta>>(META_KEY);
    return { updated: { ...(m?.updated ?? {}) }, removed: { ...(m?.removed ?? {}) } };
  } catch {
    return { updated: {}, removed: {} };
  }
}
const saveMeta = (m: Meta) => db.setMetaValue(META_KEY, m).catch(() => {});

/** A sheet linked or changed on this device (liveSheet.ts linkSheet). */
export async function markSheetUpdated(ref: { sheetId: string; gid: string }, at = Date.now()): Promise<void> {
  const m = await loadMeta();
  m.updated[sheetKey(ref)] = at;
  delete m.removed[sheetKey(ref)];
  await saveMeta(m);
}

/** A sheet unlinked on this device (liveSheet.ts unlinkSheet): the removal reaches the other devices. */
export async function markSheetRemoved(ref: { sheetId: string; gid: string }, at = Date.now()): Promise<void> {
  const m = await loadMeta();
  delete m.updated[sheetKey(ref)];
  m.removed[sheetKey(ref)] = at;
  await saveMeta(m);
}

const parseKey = (k: string): { sheetId: string; gid: string } => {
  const i = k.lastIndexOf('#');
  return { sheetId: k.slice(0, i), gid: k.slice(i + 1) };
};

/** This device's links and removals in the shared shape. */
export async function localLinkedSheets(links: LinkedSheet[] = getSettings().linkedSheets): Promise<LinkedSheetSet> {
  const meta = await loadMeta();
  return {
    sheets: links.map((l) => ({ id: l.id, name: l.name, sheetId: l.sheetId, gid: l.gid, mapping: l.mapping, enabled: l.enabled, updatedAt: meta.updated[sheetKey(l)] ?? 0 })),
    removed: Object.entries(meta.removed).map(([k, at]) => ({ ...parseKey(k), at }))
  };
}

/**
 * After each sync: bring in sheets linked, changed or unlinked on your other devices, and share this
 * device's. Writes to Drive only when something actually changed; a sheet that arrives is read
 * straight away.
 */
export async function syncLinkedSheets(token: string): Promise<void> {
  const links = getSettings().linkedSheets;
  const local = await localLinkedSheets(links);
  const file = await readAppFile(token, LINKED_SHEETS_FILE_NAME);
  const remote = file ? parseLinkedSheetsFile(file.text) : null;
  if (!remote && !local.sheets.length && !local.removed.length) return;
  const merged = mergeLinkedSheets(local, remote);

  if (!sameSet(merged, local) || merged.sheets.some((s, i) => s.id !== local.sheets[i]?.id)) {
    const before = new Map(links.map((l) => [l.id, l]));
    const next: LinkedSheet[] = merged.sheets.map((s) => {
      const was = before.get(s.id);
      return { id: s.id, name: s.name, sheetId: s.sheetId, gid: s.gid, mapping: s.mapping, enabled: s.enabled, lastSyncAt: was?.lastSyncAt ?? 0, lastError: was?.lastError ?? '' };
    });
    patchSettings({ linkedSheets: next });
    // Remember what the merge settled on, so this device's view of "newest" matches Drive's.
    const meta: Meta = { updated: {}, removed: {} };
    for (const s of merged.sheets) meta.updated[sheetKey(s)] = s.updatedAt;
    for (const r of merged.removed) meta.removed[sheetKey(r)] = r.at;
    await saveMeta(meta);
    const after = new Set(next.map((l) => l.id));
    for (const [id] of before) if (!after.has(id)) await dropSheetSnapshot(id);
    for (const l of next) {
      const was = before.get(l.id);
      if (!was || (!was.enabled && l.enabled)) void refreshSheet(l.id);
    }
  }
  if (!remote || !sameSet(merged, remote)) await writeAppFile(token, LINKED_SHEETS_FILE_NAME, wireLinkedSheets(merged), file?.id ?? null);
}
