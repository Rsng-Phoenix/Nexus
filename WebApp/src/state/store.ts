import { computed, signal } from '@preact/signals';
import * as db from '../db/tasks';
import { haptic } from '../lib/haptics';
import { getSettings } from '../settings/store';
import { scheduleSync } from '../sync/manager';
import { TUTORIAL_UUID_PREFIX } from '../sync/backup';
import { markCompleted, markWontDo, newTask } from '../task-utils';
import type { Priority, Task } from '../types';
import { PRIORITIES } from '../types';
import { addDaysIso, todayIso } from '../calendar/deadline';
import { isImported, onMatrix } from '../import/folder';
import { announce } from './broadcast';

/** Every row in IndexedDB, tombstones included. The single source of truth for the UI. */
export const allTasks = signal<Task[]>([]);

const isDone = (t: Task) => t.isCompleted || t.isWontDo;
const isArchived = (t: Task) => t.archivedAt > 0;
export const isDemo = (t: Task) => t.taskUuid.startsWith(TUTORIAL_UUID_PREFIX);

/** Android TaskDisplayOrder: open first, pinned-and-open on top, won't-do before done, then position. */
export function displayOrder(a: Task, b: Task): number {
  const pinnedOpen = (t: Task) => t.isPinned && !isDone(t);
  return (
    Number(isDone(a)) - Number(isDone(b)) ||
    Number(pinnedOpen(b)) - Number(pinnedOpen(a)) ||
    Number(a.isWontDo) - Number(b.isWontDo) ||
    a.position - b.position
  );
}

export const activeTasks = computed(() =>
  allTasks.value.filter((t) => t.deletedAt === 0 && !isArchived(t))
);

/** Local calendar day, re-read each minute and on return to the tab (imports step out at midnight). */
export const today = signal(todayIso());
export const tomorrow = computed(() => addDaysIso(today.value, 1));
if (typeof window !== 'undefined') {
  const tick = () => {
    const d = todayIso();
    if (d !== today.peek()) today.value = d;
  };
  window.setInterval(tick, 60_000);
  document.addEventListener('visibilitychange', tick);
}

/** The matrix: every task you typed, plus imported ones due today (the rest wait in the Imported folder). */
export const byPriority = computed(() => {
  const m = {} as Record<Priority, Task[]>;
  for (const p of PRIORITIES) m[p] = [];
  const day = today.value;
  for (const t of activeTasks.value) if (onMatrix(t, day)) m[t.priority].push(t);
  for (const p of PRIORITIES) m[p].sort(displayOrder);
  return m;
});

/** Each quadrant's Imported folder: imported tasks that aren't on the matrix today. */
export const importedByPriority = computed(() => {
  const m = {} as Record<Priority, Task[]>;
  for (const p of PRIORITIES) m[p] = [];
  const day = today.value;
  for (const t of activeTasks.value) if (isImported(t) && !onMatrix(t, day)) m[t.priority].push(t);
  return m;
});

export const archivedTasks = computed(() =>
  allTasks.value
    .filter((t) => t.deletedAt === 0 && isArchived(t) && !isDemo(t))
    .sort((a, b) => b.archivedAt - a.archivedAt)
);

export const recentlyDeleted = computed(() => {
  const since = Date.now() - getSettings().trashDays * 86_400_000;
  return allTasks.value
    .filter((t) => t.deletedAt > since && !isDemo(t))
    .sort((a, b) => b.deletedAt - a.deletedAt);
});

export async function reload(): Promise<void> {
  allTasks.value = await db.getAllTasksIncludingDeleted();
  // Rows can change outside the store (sync, account switch): reminders re-derive.
  afterWriteHooks.forEach((f) => f());
}

/** Optimistic write: the UI updates this frame, IndexedDB and Drive follow. */
function applyLocal(rows: Task[]): void {
  const byId = new Map(rows.map((r) => [r.id, r]));
  allTasks.value = allTasks.value.map((t) => byId.get(t.id) ?? t);
}

async function persist(rows: Task[]): Promise<void> {
  applyLocal(rows);
  for (const r of rows) await db.updateTask(r);
  afterWrite();
}

let afterWriteHooks: Array<() => void> = [];
/** Reminders, widgets etc. re-derive from tasks after any write. */
export function onTasksWritten(fn: () => void): void {
  afterWriteHooks.push(fn);
}
function afterWrite(): void {
  scheduleSync();
  afterWriteHooks.forEach((f) => f());
  // Other Nexus windows on this device (a second tab, the mini window, the Desk's windows)
  // reload at once instead of waiting for the next sync (each boot mode listens in main.tsx).
  announce('tasks');
}

const now = () => Date.now();

// ─── Actions (mirror Android TaskViewModel) ────────────────────────────────────

export async function addTask(description: string, priority: Priority, notes = '', extra: Partial<Task> = {}): Promise<Task> {
  const row = { ...newTask(description.trim(), priority), notes, position: 2147483647, ...extra };
  const saved = await db.insertTask(row);
  allTasks.value = [...allTasks.value, saved];
  afterWrite();
  return saved;
}

export function updateTask(t: Task): Promise<void> {
  return persist([{ ...t, updatedAt: now() }]);
}

export function setChecked(t: Task, checked: boolean): Promise<void> {
  if (checked) haptic('CHECK');
  const next = checked
    ? markCompleted(t)
    : { ...t, isCompleted: false, completedAt: 0, updatedAt: now() };
  return persist([next]);
}

export function toggleWontDo(t: Task): Promise<void> {
  const next = t.isWontDo
    ? { ...t, isWontDo: false, skippedAt: 0, updatedAt: now() }
    : markWontDo(t);
  return persist([next]);
}

export function togglePin(t: Task): Promise<void> {
  return persist([{ ...t, isPinned: !t.isPinned, updatedAt: now() }]);
}

export function moveToPriority(t: Task, p: Priority): Promise<void> {
  if (p === t.priority) return Promise.resolve();
  return persist([{ ...t, priority: p, position: 2147483647, updatedAt: now() }]);
}

export function deleteTasks(ids: number[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  const ts = now();
  const set = new Set(ids);
  return persist(allTasks.value.filter((t) => set.has(t.id)).map((t) => ({ ...t, deletedAt: ts, updatedAt: ts })));
}

export function restoreTasks(ids: number[]): Promise<void> {
  const ts = now();
  const set = new Set(ids);
  return persist(allTasks.value.filter((t) => set.has(t.id)).map((t) => ({ ...t, deletedAt: 0, updatedAt: ts })));
}

export function archiveTasks(ids: number[]): Promise<void> {
  const ts = now();
  const set = new Set(ids);
  return persist(
    allTasks.value.filter((t) => set.has(t.id)).map((t) => ({ ...t, archivedAt: ts, isPinned: false, updatedAt: ts }))
  );
}

export function unarchiveTasks(ids: number[]): Promise<void> {
  const ts = now();
  const set = new Set(ids);
  return persist(allTasks.value.filter((t) => set.has(t.id)).map((t) => ({ ...t, archivedAt: 0, updatedAt: ts })));
}

/** Commits a reordered quadrant once, on drop (never per frame). */
export function applyOrder(orderedIds: number[]): Promise<void> {
  const ts = now();
  const index = new Map(orderedIds.map((id, i) => [id, i]));
  const rows = allTasks.value
    .filter((t) => index.has(t.id) && t.position !== index.get(t.id))
    .map((t) => ({ ...t, position: index.get(t.id)!, updatedAt: ts }));
  return rows.length ? persist(rows) : Promise.resolve();
}

export async function purgeExpired(): Promise<void> {
  await db.purgeExpired(getSettings().retentionDays);
  await reload();
}

export async function insertTutorialDemos(): Promise<void> {
  await cleanupTutorialDemos();
  const ts = now();
  const demos: Array<Omit<Task, 'id'>> = [
    { ...newTask('Plan sprint goals', 'HIGH'), taskUuid: `${TUTORIAL_UUID_PREFIX}1`, position: 0 },
    { ...newTask('Review designs', 'MEDIUM'), taskUuid: `${TUTORIAL_UUID_PREFIX}2`, position: 0 },
    {
      ...newTask('Demo completed task', 'HIGH'),
      taskUuid: `${TUTORIAL_UUID_PREFIX}3`,
      position: 1,
      isCompleted: true,
      completedAt: ts
    }
  ];
  for (const d of demos) await db.insertTask(d);
  await reload();
}

export async function cleanupTutorialDemos(): Promise<void> {
  await db.deleteTutorialDemos();
  await reload();
}

export type ImportRow = Pick<Task, 'taskUuid' | 'description' | 'notes' | 'priority'> & Partial<Task>;
export type ImportResult = { added: number; updated: number; skipped: number; undo: () => Promise<void> };

/**
 * Adds imported tasks by their deterministic uuid: new ones are inserted, ones already here are
 * updated in place (re-importing never duplicates), and ones the user deleted are left deleted.
 * One transaction for the whole batch; `undo` puts everything back as it was.
 */
export async function importTasks(rows: ImportRow[]): Promise<ImportResult> {
  const all = await db.getAllTasksIncludingDeleted();
  const byUuid = new Map(all.map((t) => [t.taskUuid, t]));
  // Rows removed by undoing an earlier import may come back; rows the user deleted may not.
  const undone = new Set<string>(JSON.parse((await db.getMeta('import_undone')) || '[]') as string[]);
  const ts = now();
  const inserts: Array<Omit<Task, 'id'>> = [];
  const updates: Task[] = [];
  const before: Task[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    // The same uuid twice in one batch would violate the unique index and abort everything.
    if (seen.has(r.taskUuid)) {
      skipped++;
      continue;
    }
    seen.add(r.taskUuid);
    const cur = byUuid.get(r.taskUuid);
    if (!cur) {
      inserts.push({ ...newTask(r.description, r.priority), ...r, position: 2147483647, createdAt: ts, updatedAt: ts });
      continue;
    }
    if (cur.deletedAt > 0 && !undone.has(cur.taskUuid)) {
      skipped++; // deleted on purpose: an import must not bring it back
      continue;
    }
    if (cur.deletedAt > 0) {
      undone.delete(cur.taskUuid);
      before.push(cur);
      updates.push({ ...cur, ...r, id: cur.id, deletedAt: 0, updatedAt: ts });
      continue;
    }
    const next = { ...cur, ...r, id: cur.id, position: cur.position, updatedAt: ts };
    const changed = (['description', 'notes', 'priority', 'dueDate', 'dueAlerts', 'dueAlertTime', 'reminderTime'] as const).some(
      (k) => k in r && next[k] !== cur[k]
    );
    if (!changed) {
      skipped++;
      continue;
    }
    before.push(cur);
    updates.push(next);
  }
  await db.putMany([...inserts, ...updates]);
  await db.setMeta('import_undone', JSON.stringify([...undone].slice(-10_000)));
  await reload();
  afterWrite();
  // Rows this import created or brought back: an undo removes them, and a later import may revive them.
  const addedUuids = new Set([...inserts.map((i) => i.taskUuid), ...before.filter((b) => b.deletedAt > 0).map((b) => b.taskUuid)]);
  return {
    added: inserts.length,
    updated: updates.length,
    skipped,
    undo: async () => {
      const t2 = now();
      const current = await db.getAllTasksIncludingDeleted();
      const removed = current.filter((t) => addedUuids.has(t.taskUuid)).map((t) => ({ ...t, deletedAt: t2, updatedAt: t2 }));
      await db.putMany([...removed, ...before.map((b) => ({ ...b, updatedAt: t2 }))]);
      const list = new Set<string>(JSON.parse((await db.getMeta('import_undone')) || '[]') as string[]);
      addedUuids.forEach((u) => list.add(u));
      await db.setMeta('import_undone', JSON.stringify([...list].slice(-10_000)));
      await reload();
      afterWrite();
    }
  };
}
