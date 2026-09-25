import { signal } from '@preact/signals';
import * as db from '../db/tasks';
import { getSettings, patchSettings, type LinkedSheet, type SheetMapping } from '../settings/store';
import { dateToIso } from '../calendar/deadline';
import { deleteTasks, importTasks } from '../state/store';
import type { Task } from '../types';
import type { Cell } from './cell';
import { csvRowsToCells, parseCsv } from './csv';
import { buildImportPlan, type ImportItem } from './plan';

/**
 * A Google Sheet that keeps its tasks up to date ("Link a Google Sheet"). Nexus reads the sheet's
 * CSV export straight from Google (the sheet must be shared "Anyone with the link can view";
 * nothing goes through a Nexus server), turns rows into tasks with the column choices made in the
 * import wizard, and re-reads it every few minutes:
 *
 * - new rows → new tasks; rows that changed in the sheet → their task is updated;
 * - a task is never touched when its row didn't change, so edits and ticks made in Nexus stay;
 * - a row removed from the sheet removes its task, unless it was finished or edited in Nexus;
 * - tasks you deleted in Nexus don't come back.
 *
 * The tasks themselves reach your other devices through the normal Drive sync. Task ids use the
 * same recipe as a file import (plan.ts), with "gsheet:<sheet id>" and the tab id as file and
 * sheet name, so every device that reads the same sheet agrees on them.
 */

const SNAP = (id: string) => `sheet:${id}`;
const MAX_BYTES = 5 * 1024 * 1024;
const MINUTE = 60_000;

export type SheetRef = { sheetId: string; gid: string };

/** The sheet's address from whatever was pasted: the Share link, the address bar, with or without a tab. */
export function parseSheetUrl(raw: string): SheetRef | null {
  const s = raw.trim();
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (!m) return null;
  // No tab in the link: the first tab (asking for tab 0 fails for uploaded Excel files, whose tabs
  // have other numbers).
  const gid = /[#?&]gid=(\d+)/.exec(s)?.[1] ?? '';
  return { sheetId: m[1], gid };
}

export const sheetCsvUrl = (r: SheetRef) => `https://docs.google.com/spreadsheets/d/${r.sheetId}/export?format=csv${r.gid ? `&gid=${r.gid}` : ''}`;
export const sheetOpenUrl = (r: SheetRef) => `https://docs.google.com/spreadsheets/d/${r.sheetId}/edit${r.gid ? `#gid=${r.gid}` : ''}`;
export const sheetFileName = (r: SheetRef) => `gsheet:${r.sheetId}`;

export class SheetError extends Error {}

/** Reads the sheet's rows (first 5,000, as a file import). */
export async function fetchSheetRows(r: SheetRef): Promise<Cell[][]> {
  let res: Response;
  try {
    res = await fetch(sheetCsvUrl(r), { credentials: 'omit', cache: 'no-store' });
  } catch {
    // A private sheet sends the browser to Google's sign-in page, which the browser blocks: it looks
    // like a network error, so when online the likely cause is the sheet's sharing.
    throw new SheetError(
      typeof navigator !== 'undefined' && navigator.onLine === false
        ? "You're offline. Nexus will read the sheet when you're back online."
        : 'Nexus can’t read this sheet. In Google Sheets choose Share → General access → “Anyone with the link” (Viewer).'
    );
  }
  if (res.status === 404) throw new SheetError('That sheet was not found. Was it deleted, or is the link incomplete?');
  if (res.status === 400) throw new SheetError('Google couldn’t export that tab. Open the tab you want in Google Sheets and copy the link again.');
  const type = res.headers.get('content-type') ?? '';
  // A private sheet answers with Google's sign-in page instead of the data.
  if (res.status === 401 || res.status === 403 || type.includes('text/html')) {
    throw new SheetError('Nexus can’t read this sheet. In Google Sheets choose Share → General access → “Anyone with the link” (Viewer).');
  }
  if (!res.ok) throw new SheetError(`Google Sheets answered ${res.status}. Try again in a minute.`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new SheetError('This sheet is over 5 MB. Link a smaller tab.');
  return csvRowsToCells(parseCsv(text).rows);
}

type Snapshot = { rows: Record<string, string>; at: number };

async function loadSnap(id: string): Promise<Snapshot> {
  try {
    const raw = await db.getMeta(SNAP(id));
    if (raw) return JSON.parse(raw) as Snapshot;
  } catch {
    /* start fresh */
  }
  return { rows: {}, at: 0 };
}

/** What a row puts into its task; a task is only rewritten when this changes. */
const rowHash = (i: ImportItem) => JSON.stringify([i.description, i.notes, i.priority, i.dueDate, i.dueAlerts, i.dueAlertTime]);

const toRow = (i: ImportItem) => ({
  taskUuid: i.taskUuid,
  description: i.description.slice(0, 500),
  notes: i.notes.slice(0, 5000),
  priority: i.priority,
  dueDate: i.dueDate,
  dueAlerts: i.dueAlerts,
  dueAlertTime: i.dueAlertTime
});

export async function planSheet(ref: SheetRef, map: SheetMapping, rows: Cell[][], existing: Task[]) {
  return buildImportPlan({
    fileName: sheetFileName(ref),
    sheetName: ref.gid,
    rows,
    headerRow: map.headerRow,
    titleCols: [...map.titleCols].sort((a, b) => a - b),
    titleText: map.titleText,
    dateCol: map.dateCol,
    notesCols: [...map.notesCols].sort((a, b) => a - b),
    priority: map.priority,
    offsets: map.offsets,
    alertTime: map.alertTime,
    dayFirst: map.dayFirst,
    existingUuids: new Set(existing.filter((t) => t.deletedAt === 0).map((t) => t.taskUuid))
  });
}

export type SheetResult = { added: number; updated: number; removed: number };

/** Brings one linked sheet's tasks up to date (see the rules at the top). */
export async function applySheet(link: Pick<LinkedSheet, 'id' | 'sheetId' | 'gid' | 'mapping'>, rows: Cell[][]): Promise<SheetResult> {
  const all = await db.getAllTasksIncludingDeleted();
  const byUuid = new Map(all.map((t) => [t.taskUuid, t]));
  const plan = await planSheet(link, link.mapping, rows, all);
  const snap = await loadSnap(link.id);

  const changed = plan.items.filter((i) => !byUuid.has(i.taskUuid) || snap.rows[i.taskUuid] !== rowHash(i));
  const r = changed.length ? await importTasks(changed.map(toRow)) : { added: 0, updated: 0 };

  const now = new Set(plan.items.map((i) => i.taskUuid));
  const gone = Object.keys(snap.rows)
    .filter((u) => !now.has(u))
    .map((u) => byUuid.get(u))
    .filter((t): t is Task => !!t && t.deletedAt === 0 && !t.isCompleted && !t.isWontDo && t.updatedAt <= snap.at);
  if (gone.length) await deleteTasks(gone.map((t) => t.id));

  const next: Snapshot = { rows: Object.fromEntries(plan.items.map((i) => [i.taskUuid, rowHash(i)])), at: Date.now() };
  await db.setMeta(SNAP(link.id), JSON.stringify(next));
  return { added: r.added, updated: r.updated, removed: gone.length };
}

// ─── Linked sheets in settings ──────────────────────────────────────────────

/** Sheets being read right now (for a spinner). */
export const sheetBusy = signal<Record<string, boolean>>({});

function patchLink(id: string, patch: Partial<LinkedSheet>) {
  patchSettings({ linkedSheets: getSettings().linkedSheets.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
}

/** Saves a new linked sheet and remembers what its first import created. */
export async function linkSheet(ref: SheetRef, name: string, mapping: SheetMapping, rows: Cell[][]): Promise<{ link: LinkedSheet; result: SheetResult }> {
  const existing = getSettings().linkedSheets.find((l) => l.sheetId === ref.sheetId && l.gid === ref.gid);
  const link: LinkedSheet = {
    id: existing?.id ?? crypto.randomUUID(),
    name: name.trim().slice(0, 60) || 'Google Sheet',
    sheetId: ref.sheetId,
    gid: ref.gid,
    mapping,
    enabled: true,
    lastSyncAt: 0,
    lastError: ''
  };
  const result = await applySheet(link, rows);
  link.lastSyncAt = Date.now();
  patchSettings({ linkedSheets: [...getSettings().linkedSheets.filter((l) => l.id !== link.id), link] });
  return { link, result };
}

/** The sheet's tasks that are still ahead: open (not finished) and due today or later. */
export async function upcomingSheetTasks(id: string, today = dateToIso(new Date())): Promise<Task[]> {
  const made = new Set(Object.keys((await loadSnap(id)).rows));
  if (!made.size) return [];
  const all = await db.getAllTasksIncludingDeleted();
  return all.filter((t) => made.has(t.taskUuid) && t.deletedAt === 0 && !t.isCompleted && !t.isWontDo && !!t.dueDate && t.dueDate >= today);
}

/**
 * Stops updating from a sheet. With [removeUpcoming], its tasks that are still ahead go to
 * Recently deleted (and so leave your other devices and calendar apps too); past and finished
 * ones stay either way. Returns the ids removed, for Undo.
 */
export async function unlinkSheet(id: string, removeUpcoming = false): Promise<number[]> {
  const gone = removeUpcoming ? (await upcomingSheetTasks(id)).map((t) => t.id) : [];
  if (gone.length) await deleteTasks(gone);
  patchSettings({ linkedSheets: getSettings().linkedSheets.filter((l) => l.id !== id) });
  await db.deleteMeta(SNAP(id));
  return gone;
}

const inFlight = new Map<string, Promise<SheetResult | null>>();

export function refreshSheet(id: string): Promise<SheetResult | null> {
  const running = inFlight.get(id);
  if (running) return running;
  const p = (async () => {
    const link = getSettings().linkedSheets.find((l) => l.id === id);
    if (!link) return null;
    sheetBusy.value = { ...sheetBusy.value, [id]: true };
    try {
      const result = await applySheet(link, await fetchSheetRows(link));
      patchLink(id, { lastSyncAt: Date.now(), lastError: '' });
      return result;
    } catch (e) {
      patchLink(id, { lastError: e instanceof Error ? e.message : 'Could not read the sheet' });
      return null;
    } finally {
      const { [id]: _done, ...rest } = sheetBusy.value;
      sheetBusy.value = rest;
      inFlight.delete(id);
    }
  })();
  inFlight.set(id, p);
  return p;
}

/** Every enabled sheet older than the "check every" interval (or all of them with [force]). */
export async function refreshSheets(force = false): Promise<void> {
  const s = getSettings();
  if (!force && s.sheetRefreshMinutes === 0) return; // "Only when I tap Update"
  const due = s.linkedSheets.filter((l) => l.enabled && (force || Date.now() - l.lastSyncAt >= s.sheetRefreshMinutes * MINUTE));
  for (const l of due) await refreshSheet(l.id);
}

let started = false;
/**
 * While Nexus is open and in front: on start, when it comes back to the front, and a check every
 * minute that only reads a sheet once its interval (Settings) has passed. Nothing runs in a
 * background tab or with the interval set to "Only when I tap Update", so it costs no battery then.
 */
export function startSheetAutoRefresh(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const tick = () => {
    if (document.visibilityState === 'visible' && navigator.onLine && getSettings().linkedSheets.length) void refreshSheets();
  };
  tick();
  window.setInterval(tick, MINUTE);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('online', tick);
}
