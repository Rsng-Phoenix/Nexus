import type { LinkedCalendar } from '../settings/store';
import type { Task } from '../types';
import { addDaysIso, dateToIso, hasDeadline, isOverdue } from './deadline';
import { nextOccurrence, type IcsEvent } from './ics';

/**
 * What the calendar shows on each day (spec 3.7 §3): deadlines, reminder days (date-only and
 * recurring ranges count every day they cover) and events from linked calendars.
 */
export type CalItem =
  | { type: 'due'; key: string; task: Task; late: boolean }
  | { type: 'reminder'; key: string; task: Task; time: number | null }
  | { type: 'event'; key: string; event: IcsEvent; calendar: LinkedCalendar; time: number | null };

export type LinkedEvents = { calendar: LinkedCalendar; events: IcsEvent[] };

const MAX_SPAN_DAYS = 62;
const MAX_OCCURRENCES = 400;

const dayOf = (ms: number) => dateToIso(new Date(ms));
const inRange = (iso: string, from: string, to: string) => iso >= from && iso <= to;
const visible = (t: Task) => t.deletedAt === 0 && !(t.archivedAt > 0) && !t.taskUuid.startsWith('nexus-tutorial-');

function push(map: Map<string, CalItem[]>, iso: string, item: CalItem) {
  const list = map.get(iso);
  if (list) list.push(item);
  else map.set(iso, [item]);
}

/** Items per ISO day for [fromIso, toIso] inclusive, each day sorted for display. */
export function buildCalendar(tasks: Task[], linked: LinkedEvents[], fromIso: string, toIso: string, now = Date.now()): Map<string, CalItem[]> {
  const map = new Map<string, CalItem[]>();
  for (const t of tasks) {
    if (!visible(t)) continue;
    if (hasDeadline(t) && inRange(t.dueDate, fromIso, toIso)) {
      push(map, t.dueDate, { type: 'due', key: `d:${t.taskUuid}`, task: t, late: isOverdue(t, now) });
    }
    if (t.reminderTime != null) {
      const recurring = t.reminderDateOnly || t.reminderEndDate > 0;
      const start = dayOf(t.reminderTime);
      if (!recurring) {
        if (inRange(start, fromIso, toIso)) push(map, start, { type: 'reminder', key: `r:${t.taskUuid}`, task: t, time: t.reminderTime });
      } else {
        const last = t.reminderEndDate > 0 ? dayOf(t.reminderEndDate) : start;
        let d = start < fromIso ? fromIso : start;
        for (let i = 0; d <= last && d <= toIso && i < MAX_SPAN_DAYS; i++, d = addDaysIso(d, 1)) {
          push(map, d, { type: 'reminder', key: `r:${t.taskUuid}:${d}`, task: t, time: null });
        }
      }
    }
  }
  const from = new Date(`${fromIso}T00:00:00`);
  for (const { calendar, events } of linked) {
    if (!calendar.enabled) continue;
    for (const ev of events) {
      // A one-off multi-day event that started before the grid still covers days inside it.
      if (!ev.rrule && ev.start.allDay && ev.end?.allDay && ev.start.date < fromIso) {
        const endIso = addDaysIso(ev.end.date, -1);
        let d = fromIso;
        for (let k = 0; d <= endIso && d <= toIso && k < MAX_SPAN_DAYS; k++, d = addDaysIso(d, 1)) {
          push(map, d, { type: 'event', key: `e:${calendar.id}:${ev.uid}:${ev.start.raw}:${d}`, event: ev, calendar, time: null });
        }
        continue;
      }
      let cursor = from;
      for (let i = 0; i < MAX_OCCURRENCES; i++) {
        const occ = nextOccurrence(ev, cursor);
        if (!occ || occ.date > toIso) break;
        // Multi-day all-day events appear on every day they cover.
        const endIso = occ.allDay && ev.end?.allDay && ev.rrule == null ? addDaysIso(ev.end.date, -1) : occ.date;
        let d = occ.date;
        for (let k = 0; d <= endIso && k < MAX_SPAN_DAYS; k++, d = addDaysIso(d, 1)) {
          if (inRange(d, fromIso, toIso)) {
            push(map, d, { type: 'event', key: `e:${calendar.id}:${ev.uid}:${occ.raw}:${d}`, event: ev, calendar, time: occ.allDay ? null : occ.time ?? null });
          }
        }
        cursor = occ.allDay ? new Date(`${addDaysIso(occ.date, 1)}T00:00:00`) : new Date((occ.time ?? 0) + 1);
        if (!ev.rrule) break;
      }
    }
  }
  // Open before done; deadlines (late first), then all-day items, then timed items by time.
  const sortKey = (i: CalItem): [number, number, number] => {
    const done = i.type !== 'event' && (i.task.isCompleted || i.task.isWontDo) ? 1 : 0;
    if (i.type === 'due') return [done, i.late ? 0 : 1, 0];
    return i.time == null ? [done, 2, 0] : [done, 3, i.time];
  };
  for (const list of map.values()) {
    list.sort((a, b) => {
      const x = sortKey(a);
      const y = sortKey(b);
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  }
  return map;
}

/** The 6×7 grid of ISO days shown for [year, month] (month 0-based), weeks starting on [weekStart] (0 = Sunday). */
export function monthGrid(year: number, month: number, weekStart: 0 | 1): string[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const start = new Date(year, month, 1 - lead);
  const out: string[] = [];
  for (let i = 0; i < 42; i++) out.push(dateToIso(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
  return out;
}
