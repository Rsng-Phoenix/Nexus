import { signal } from '@preact/signals';
import * as db from '../db/tasks';
import { getSettings, isSignedIn, patchSettings, type LinkedSheet, type SheetMapping } from '../settings/store';
import { alertAt, dateToIso } from '../calendar/deadline';
import { parseDueAlerts } from '../calendar/due';
import { addSnooze } from '../reminders/notify';
import { deleteTasks, importTasks } from '../state/store';
import { getAccessToken } from '../sync/auth';
import type { Task } from '../types';
import type { Cell } from './cell';
import { csvRowsToCells, parseCsv } from './csv';
import { markSheetRemoved, markSheetUpdated } from './linkedSheetsSync';
import { pickerAvailable } from './picker';
import { buildImportPlan, type ImportItem } from './plan';
import { readRowsViaApi, SheetNeedsPickError } from './sheetsApi';

/**
 * A Google Sheet that keeps its tasks up to date ("Link a Google Sheet"). Nexus reads the sheet's
 * CSV export straight from Google (the sheet must be shared "Anyone with the link can view";
 * nothing goes through a Nexus server), turns rows into tasks with the column choices made in the
 * import wizard, and re-reads it every few minutes. A sheet whose export is refused (private to an
 * organisation) is read through the Sheets API with the signed-in account instead, once the user
 * has chosen it in Google Drive (sheetsApi.ts, picker.ts):
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

export const SHEET_PRIVATE_MESSAGE = 'Nexus can’t read this sheet. In Google Sheets choose Share → General access → “Anyone with the link” (Viewer).';
/** Shown (with the "Choose in Google Drive" button) when the signed-in account may not read the sheet yet. */
export const SHEET_PICK_MESSAGE = 'This sheet is private to your organisation. Choose it once in Google Drive so Nexus can read it.';

export class SheetError extends Error {
  /** The sheet's sharing (or the account's access) is the problem, not the network or the link. */
  readonly privateSheet: boolean;
  /** Choosing the sheet in the Google Picker would fix it (picker.ts). */
  readonly needsPick: boolean;
  constructor(message: string, o: { privateSheet?: boolean; needsPick?: boolean } = {}) {
    super(message);
    this.privateSheet = o.privateSheet ?? false;
    this.needsPick = o.needsPick ?? false;
  }
}

/** The sheet's public CSV export (no cookies, no account): the way every shared-with-the-link sheet is read. */
export async function fetchPublicSheetRows(r: SheetRef): Promise<Cell[][]> {
  let res: Response;
  try {
    res = await fetch(sheetCsvUrl(r), { credentials: 'omit', cache: 'no-store' });
  } catch {
    // A private sheet sends the browser to Google's sign-in page, which the browser blocks: it looks
    // like a network error, so when online the likely cause is the sheet's sharing.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new SheetError("You're offline. Nexus will read the sheet when you're back online.");
    throw new SheetError(SHEET_PRIVATE_MESSAGE, { privateSheet: true });
  }
  if (res.status === 404) throw new SheetError('That sheet was not found. Was it deleted, or is the link incomplete?');
  if (res.status === 400) throw new SheetError('Google couldn’t export that tab. Open the tab you want in Google Sheets and copy the link again.');
  const type = res.headers.get('content-type') ?? '';
  // A private sheet answers with Google's sign-in page instead of the data.
  if (res.status === 401 || res.status === 403 || type.includes('text/html')) {
    throw new SheetError(SHEET_PRIVATE_MESSAGE, { privateSheet: true });
  }
  if (!res.ok) throw new SheetError(`Google Sheets answered ${res.status}. Try again in a minute.`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new SheetError('This sheet is over 5 MB. Link a smaller tab.');
  return csvRowsToCells(parseCsv(text).rows);
}

/**
 * Reads the sheet's rows (first 5,000, as a file import): the public export first; when that is
 * refused and you're signed in, the Sheets API with your account (sheets you chose in Google Drive,
 * or that are shared with you). Neither path costs anything when the sheet is public.
 */
export async function fetchSheetRows(r: SheetRef): Promise<Cell[][]> {
  try {
    return await fetchPublicSheetRows(r);
  } catch (e) {
    if (!(e instanceof SheetError) || !e.privateSheet || !isSignedIn()) throw e;
    const token = await getAccessToken({ interactive: false });
    if (!token) throw e;
    try {
      return await readRowsViaApi(token, r.sheetId, r.gid);
    } catch (a) {
      // Without the Picker configured the only way in is the sharing setting: say that instead.
      if (a instanceof SheetNeedsPickError) throw new SheetError(pickerAvailable() ? SHEET_PICK_MESSAGE : SHEET_PRIVATE_MESSAGE, { privateSheet: true, needsPick: true });
      throw new SheetError(a instanceof Error ? a.message : e.message, { privateSheet: true });
    }
  }
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

/** Late alerts ring this long after the read (so the schedule is published first), one second apart. */
const LATE_DELAY_MS = 15_000;
/** At most this many late alerts per read (a first read of a big sheet mustn't flood you). */
const MAX_LATE = 10;

/**
 * New or changed rows whose alert time has already passed while their day isn't over yet — e.g.
 * a shipment for today added at 9:20 when alerts ring at 9:00. Each gets one alert right away,
 * so a sheet read late (phone asleep, laptop closed) never swallows a reminder. Alerts that are
 * still ahead ring at their normal time as usual.
 */
export function lateAlerts(items: ImportItem[], now: number): { ref: string; fireAt: number }[] {
  const out: { ref: string; fireAt: number }[] = [];
  for (const i of items) {
    if (out.length >= MAX_LATE) break;
    if (now >= alertAt(i.dueDate, 1, 0)) continue; // the deadline day is over
    const missed = parseDueAlerts(i.dueAlerts).some((o) => alertAt(i.dueDate, o, i.dueAlertTime) <= now);
    if (missed) out.push({ ref: i.taskUuid, fireAt: now + LATE_DELAY_MS + out.length * 1000 });
  }
  return out;
}

/** Brings one linked sheet's tasks up to date (see the rules at the top). */
export async function applySheet(link: Pick<LinkedSheet, 'id' | 'sheetId' | 'gid' | 'mapping'>, rows: Cell[][]): Promise<SheetResult> {
  const all = await db.getAllTasksIncludingDeleted();
  const byUuid = new Map(all.map((t) => [t.taskUuid, t]));
  const plan = await planSheet(link, link.mapping, rows, all);
  const snap = await loadSnap(link.id);

  const changed = plan.items.filter((i) => !byUuid.has(i.taskUuid) || snap.rows[i.taskUuid] !== rowHash(i));
  const r = changed.length ? await importTasks(changed.map(toRow)) : { added: 0, updated: 0 };

  // Rows that arrived after their alert time: one alert now (not for tasks you finished or deleted).
  const s = getSettings();
  if (s.sheetLateAlerts && s.notifyDeadlines !== false && changed.length) {
    const live = changed.filter((i) => {
      const cur = byUuid.get(i.taskUuid);
      return !cur || (cur.deletedAt === 0 && !cur.isCompleted && !cur.isWontDo);
    });
    const late = lateAlerts(live, Date.now());
    for (const l of late) await addSnooze({ ref: l.ref, kind: 'due', fireAt: l.fireAt });
    if (late.length) void import('../reminders/push').then((m) => m.scheduleAll(300));
  }

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
  await markSheetUpdated(link); // so the link reaches your other devices (linkedSheetsSync.ts)
  return { link, result };
}

/** Forgets what a linked sheet's last read looked like (after the link itself is gone). */
export async function dropSheetSnapshot(id: string): Promise<void> {
  await db.deleteMeta(SNAP(id));
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
  const link = getSettings().linkedSheets.find((l) => l.id === id);
  patchSettings({ linkedSheets: getSettings().linkedSheets.filter((l) => l.id !== id) });
  await dropSheetSnapshot(id);
  if (link) await markSheetRemoved(link); // the removal reaches your other devices (linkedSheetsSync.ts)
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
