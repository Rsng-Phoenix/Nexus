import { addDaysIso, dateToIso } from './deadline';
import { buildCalendar, type LinkedEvents } from './items';
import type { MeetInfo } from '../reminders/notify';
import { calendarSourceLabel } from './linked';

export { meetingLabel, type MeetInfo } from '../reminders/notify';

/**
 * Heads-up notifications before meetings from linked calendars (opt-in, Settings →
 * Notifications). Only timed events; all-day events never ring.
 */
export type Meeting = { ref: string; fireAt: number; info: MeetInfo };

/** Meetings are scheduled this far ahead; calendars refresh far more often than that. */
export const MEETING_HORIZON_MS = 48 * 3_600_000;

/** Short, stable id for one occurrence (the relay stores refs of at most 200 characters). */
export function meetingRef(calendarId: string, uid: string, startMs: number): string {
  const s = `${calendarId}\u001f${uid}\u001f${startMs}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `meet:${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

/** Every heads-up that falls in (from, now + horizon], [leadMin] minutes before each meeting. */
export function upcomingMeetings(linked: LinkedEvents[], leadMin: number, now: number, from = now, horizonMs = MEETING_HORIZON_MS): Meeting[] {
  const lead = Math.max(0, leadMin) * 60_000;
  const today = dateToIso(new Date(now));
  const days = buildCalendar([], linked, today, addDaysIso(today, Math.ceil(horizonMs / 86_400_000) + 1), now);
  const out: Meeting[] = [];
  const seen = new Set<string>();
  for (const items of days.values()) {
    for (const i of items) {
      if (i.type !== 'event' || i.time == null) continue;
      const fireAt = i.time - lead;
      if (fireAt <= from || fireAt > now + horizonMs) continue;
      const ref = meetingRef(i.calendar.id, i.event.uid, i.time);
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push({
        ref,
        fireAt,
        info: { title: i.event.summary || 'Meeting', at: i.time, source: calendarSourceLabel(i.calendar), ...(i.event.meetingUrl ? { url: i.event.meetingUrl } : {}) }
      });
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt);
}

