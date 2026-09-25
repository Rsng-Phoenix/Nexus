import { ICS_UUID_PREFIX } from '../calendar/ics';
import { fullDay } from '../share/doc';
import type { Task } from '../types';
import { IMPORT_UUID_PREFIX } from './plan';

/**
 * Imported tasks (Google Sheets, Excel/CSV files, calendar files) can number in the hundreds:
 * they live in an "Imported" folder inside their quadrant, and only step onto the matrix on
 * their own day. Their reminders are untouched: a task in the folder still rings on time.
 * Identical on Android (ImportFolder.kt).
 */
export function isImported(t: Pick<Task, 'taskUuid'>): boolean {
  return t.taskUuid.startsWith(IMPORT_UUID_PREFIX) || t.taskUuid.startsWith(ICS_UUID_PREFIX);
}

/** Shown on the matrix: everything you typed, plus imported tasks due today (or pinned by you). */
export function onMatrix(t: Task, today: string): boolean {
  if (!isImported(t)) return true;
  if (t.dueDate === today) return true; // stays visible the rest of the day, even once ticked
  return t.isPinned && !t.isCompleted && !t.isWontDo;
}

export type FolderGroup = { key: string; label: string; tone: 'late' | 'next' | 'plain' | 'done'; tasks: Task[] };

/**
 * The folder's sections, in reading order: Tomorrow, each later day, No date, then the past:
 * Missed (open, date passed) and Done, which the folder shows collapsed. Days are written out
 * in full so nothing reads "tomorrow" by mistake.
 */
export function folderGroups(tasks: Task[], today: string, tomorrow: string): FolderGroup[] {
  const missed: Task[] = [];
  const undated: Task[] = [];
  const done: Task[] = [];
  const byDay = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.isCompleted || t.isWontDo) done.push(t);
    else if (!t.dueDate) undated.push(t);
    else if (t.dueDate < today) missed.push(t);
    else byDay.set(t.dueDate, [...(byDay.get(t.dueDate) ?? []), t]);
  }
  const byTitle = (a: Task, b: Task) => a.description.localeCompare(b.description);
  const out: FolderGroup[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const label = day === today ? 'Today' : day === tomorrow ? `Tomorrow · ${fullDay(day)}` : fullDay(day);
    out.push({ key: day, label, tone: day <= tomorrow ? 'next' : 'plain', tasks: byDay.get(day)!.sort(byTitle) });
  }
  if (undated.length) out.push({ key: 'undated', label: 'No date', tone: 'plain', tasks: undated.sort(byTitle) });
  if (missed.length) {
    missed.sort((a, b) => b.dueDate.localeCompare(a.dueDate) || byTitle(a, b));
    out.push({ key: 'missed', label: 'Missed', tone: 'late', tasks: missed });
  }
  if (done.length) {
    done.sort((a, b) => (b.completedAt || b.skippedAt) - (a.completedAt || a.skippedAt));
    out.push({ key: 'done', label: 'Done', tone: 'done', tasks: done });
  }
  return out;
}

/** "12 upcoming" for the folder row. */
export function folderSummary(tasks: Task[], today: string): { open: number; missed: number; text: string } {
  let open = 0;
  let missed = 0;
  for (const t of tasks) {
    if (t.isCompleted || t.isWontDo) continue;
    open++;
    if (t.dueDate && t.dueDate < today) missed++;
  }
  // Past ones don't need attention on the matrix: the row counts what's coming, missed only
  // when nothing else is left (the folder itself lists them).
  const upcoming = open - missed;
  const text = upcoming ? `${upcoming} upcoming` : missed ? `${missed} missed` : 'all done';
  return { open, missed, text };
}
