import type { Task } from '../types';
import { addDaysIso, hasDeadline } from './deadline';

/**
 * "Add to my calendar" links for one task: the calendar's own compose screen opens prefilled,
 * so it needs no extra Google / Microsoft permission and nothing is stored anywhere but there.
 * A deadline becomes an all-day event; a one-off reminder becomes a 30-minute event.
 */
export type CalendarSlot = { allDay: true; date: string } | { allDay: false; start: number; end: number };

const SLOT_MS = 30 * 60_000;

export function calendarSlot(t: Task): CalendarSlot | null {
  if (hasDeadline(t)) return { allDay: true, date: t.dueDate };
  if (t.reminderTime != null && !t.reminderDateOnly && !(t.reminderEndDate > 0)) return { allDay: false, start: t.reminderTime, end: t.reminderTime + SLOT_MS };
  return null;
}

const compact = (iso: string) => iso.replace(/-/g, '');
const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function googleCalendarUrl(title: string, details: string, slot: CalendarSlot): string {
  const dates = slot.allDay ? `${compact(slot.date)}/${compact(addDaysIso(slot.date, 1))}` : `${utc(slot.start)}/${utc(slot.end)}`;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates, details: details.slice(0, 1500) });
  return `https://calendar.google.com/calendar/render?${q}`;
}

export function outlookCalendarUrl(title: string, details: string, slot: CalendarSlot): string {
  const q = new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: title, body: details.slice(0, 1500) });
  if (slot.allDay) {
    q.set('startdt', slot.date);
    q.set('enddt', addDaysIso(slot.date, 1));
    q.set('allday', 'true');
  } else {
    q.set('startdt', new Date(slot.start).toISOString());
    q.set('enddt', new Date(slot.end).toISOString());
  }
  return `https://outlook.live.com/calendar/0/deeplink/compose?${q}`;
}
