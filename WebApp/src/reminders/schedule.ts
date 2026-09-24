import type { Task } from '../types';

/**
 * Port of Android ReminderScheduler.nextReminderFire so both apps ring at the same moments.
 * Recurring (all-day / date-range) reminders ring inside the user's daily window.
 */
export type ReminderWindow = { startHour: number; endHour: number };

/** An exact reminder missed while the device was off still rings if it is at most this late. */
const MISSED_GRACE_MS = 12 * 60 * 60 * 1000;
const DAY_PLUS = 26 * 60 * 60 * 1000; // next calendar day, DST-safe

export const isRecurring = (t: Task) => t.reminderDateOnly || t.reminderEndDate > 0;

function dayAt(ms: number, hour: number): number {
  const d = new Date(ms);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function nextReminderFire(t: Task, after: number, w: ReminderWindow): number | null {
  const start = t.reminderTime;
  if (start == null) return null;
  if (!isRecurring(t)) {
    if (start > after) return start;
    return after - start <= MISSED_GRACE_MS ? after + 1000 : null;
  }
  const interval = (t.reminderIntervalMinutes > 0 ? t.reminderIntervalMinutes : 120) * 60_000;
  const lastDay = t.reminderEndDate > 0 ? t.reminderEndDate : start;
  const lastWindowEnd = dayAt(lastDay, w.endHour);
  let day = dayAt(Math.max(start, after), 0);
  while (dayAt(day, w.endHour) <= lastWindowEnd) {
    const windowStart = Math.max(dayAt(day, w.startHour), start);
    const windowEnd = dayAt(day, w.endHour);
    let slot = windowStart;
    if (slot <= after) slot += (Math.floor((after - slot) / interval) + 1) * interval;
    if (slot <= windowEnd) return slot;
    day = dayAt(day + DAY_PLUS, 0);
  }
  return null;
}

/** Every ring in [from, from + horizon), capped, for handing to the push relay. */
export function upcomingFires(t: Task, from: number, horizonMs: number, w: ReminderWindow, max = 60): number[] {
  // An exact reminder rings once (its "missed, ring now" fallback must not repeat every second).
  if (!isRecurring(t)) {
    const once = nextReminderFire(t, from - 1, w);
    return once != null && once < from + horizonMs ? [once] : [];
  }
  const out: number[] = [];
  let after = from - 1;
  while (out.length < max) {
    const next = nextReminderFire(t, after, w);
    if (next == null || next >= from + horizonMs) break;
    out.push(next);
    after = next;
  }
  return out;
}
