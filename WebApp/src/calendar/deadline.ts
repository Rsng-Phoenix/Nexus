import type { Task } from '../types';
import { isIsoDate, parseDueAlerts } from './due';

/**
 * Deadlines (spec 3.7 §1): a task's `dueDate` is a calendar day; each offset in `dueAlerts`
 * rings at `dueAlertTime` on (dueDate + offset days), in local time. Same rules as Android DueDates.kt.
 */

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local-midnight Date for an ISO day. */
export function isoToDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysIso(iso: string, days: number): string {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + days);
  return dateToIso(d);
}

/** Whole calendar days from [a] to [b] (DST-safe). */
export function daysBetween(aIso: string, bIso: string): number {
  const a = isoToDate(aIso);
  const b = isoToDate(bIso);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
}

export const todayIso = (now = Date.now()) => dateToIso(new Date(now));

export function hasDeadline(t: Pick<Task, 'dueDate'>): boolean {
  return isIsoDate(t.dueDate ?? '');
}

const isOpen = (t: Task) => !t.isCompleted && !t.isWontDo && !(t.archivedAt > 0) && t.deletedAt === 0;

/** When the alert for [offset] rings. */
export function alertAt(dueDate: string, offset: number, alertTime: number): number {
  const d = isoToDate(dueDate);
  d.setDate(d.getDate() + offset);
  d.setHours(Math.floor(alertTime / 60), alertTime % 60, 0, 0);
  return d.getTime();
}

export type DueFire = { fireAt: number; offset: number };

/** Every deadline alert ringing in [from, from + horizonMs). Nothing for finished tasks. */
export function upcomingDueFires(t: Task, from: number, horizonMs: number): DueFire[] {
  if (!hasDeadline(t) || !isOpen(t)) return [];
  return parseDueAlerts(t.dueAlerts)
    .map((offset) => ({ offset, fireAt: alertAt(t.dueDate, offset, t.dueAlertTime) }))
    .filter((f) => f.fireAt >= from && f.fireAt < from + horizonMs);
}

function shortDay(iso: string): string {
  const d = isoToDate(iso);
  return `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`;
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** Notification line for an alert [offset] days from the deadline. */
export function dueAlertText(dueDate: string, offset: number): string {
  if (offset < -1) return `Due in ${days(-offset)} · ${shortDay(dueDate)}`;
  if (offset === -1) return 'Due tomorrow';
  if (offset === 0) return 'Due today';
  return `Overdue by ${days(offset)}`;
}

/** Chip on task rows and the detail sheet: "Due today", "Due Fri 3 Oct", "Overdue · 2 days". */
export function dueChipLabel(t: Pick<Task, 'dueDate'>, now = Date.now()): string | null {
  if (!hasDeadline(t)) return null;
  const diff = daysBetween(todayIso(now), t.dueDate);
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  if (diff < 0) return `Overdue · ${days(-diff)}`;
  const d = isoToDate(t.dueDate);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `Due ${shortDay(t.dueDate)}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}

export function isOverdue(t: Task, now = Date.now()): boolean {
  return hasDeadline(t) && isOpen(t) && daysBetween(todayIso(now), t.dueDate) < 0;
}

/** Offset chips offered in the deadline picker and the Excel import (days relative to the due day). */
export const DUE_OFFSET_CHOICES: { offset: number; label: string }[] = [
  { offset: -7, label: '1 week before' },
  { offset: -3, label: '3 days before' },
  { offset: -2, label: '2 days before' },
  { offset: -1, label: '1 day before' },
  { offset: 0, label: 'Same day' },
  { offset: 1, label: '1 day after' },
  { offset: 2, label: '2 days after' }
];

export function offsetLabel(offset: number): string {
  const known = DUE_OFFSET_CHOICES.find((c) => c.offset === offset);
  if (known) return known.label;
  return offset < 0 ? `${days(-offset)} before` : `${days(offset)} after`;
}

export function formatAlertTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** Compact badge for task rows: "Today", "Tmrw", "Fri", "3 Oct", "2d late" (full text in the tooltip). */
export function dueShortLabel(t: Pick<Task, 'dueDate'>, now = Date.now()): string | null {
  if (!hasDeadline(t)) return null;
  const diff = daysBetween(todayIso(now), t.dueDate);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tmrw';
  if (diff < 0) return `${-diff}d late`;
  const d = isoToDate(t.dueDate);
  if (diff < 7) return WEEKDAY[d.getDay()];
  return `${d.getDate()} ${MONTH[d.getMonth()]}`;
}
