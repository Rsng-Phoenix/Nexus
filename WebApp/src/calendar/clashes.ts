import type { LinkedCalendar } from '../settings/store';
import { addDaysIso, dateToIso } from './deadline';
import { eventLengthMs, type IcsEvent } from './ics';
import { buildCalendar, type LinkedEvents } from './items';
import { calendarSourceLabel } from './linked';

/**
 * Clash radar: meetings from different (or the same) linked calendars that overlap in time.
 * Nexus is the only place that sees Google, Zoho, iCloud and Outlook together, so it is the only
 * one that can spot a Zoho client call landing on top of a Google standup.
 */

/** One timed meeting occupying [start, end). The same meeting found in several calendars is one Busy. */
export type Busy = {
  key: string;
  start: number;
  end: number;
  title: string;
  event: IcsEvent;
  calendar: LinkedCalendar;
  /** Other calendars that hold the same meeting (an invite copied into Google and Zoho). */
  alsoIn: string[];
};

export type Clash = { id: string; a: Busy; b: Busy; overlapStart: number; overlapEnd: number };

/** How far ahead the radar looks. */
export const CLASH_HORIZON_DAYS = 14;
const MAX_CLASHES = 200;

/** The account an iCal link belongs to, when the link says (Google's secret address does). */
export function calendarOwnerEmail(url: string): string | null {
  const m = /\/calendar\/ical\/([^/]+)\/(?:private|public)/i.exec(url);
  if (!m) return null;
  try {
    const email = decodeURIComponent(m[1]).toLowerCase();
    return email.includes('@') ? email : null;
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Timed meetings in [fromMs, toMs) that actually take time: not "free", not declined by the calendar's owner, not zero-length. */
export function busyBlocks(linked: LinkedEvents[], fromMs: number, toMs: number): Busy[] {
  const fromIso = dateToIso(new Date(fromMs));
  const toIso = addDaysIso(dateToIso(new Date(toMs)), 1);
  const days = buildCalendar([], linked, addDaysIso(fromIso, -1), toIso, fromMs);
  const seen = new Map<string, Busy>();
  const out: Busy[] = [];
  for (const items of days.values()) {
    for (const i of items) {
      if (i.type !== 'event' || i.time == null) continue;
      const ev = i.event;
      const len = eventLengthMs(ev);
      if (ev.free || len <= 0) continue;
      const owner = calendarOwnerEmail(i.calendar.url);
      if (owner && ev.declined?.includes(owner)) continue;
      const start = i.time;
      const end = start + len;
      if (end <= fromMs || start >= toMs) continue;
      // An invite accepted in two services is one meeting, not a clash: same UID, or same time and title.
      const byUid = `u|${ev.uid}|${start}`;
      const byTitle = `t|${norm(ev.summary)}|${start}|${end}`;
      const dup = seen.get(byUid) ?? (norm(ev.summary) ? seen.get(byTitle) : undefined);
      if (dup) {
        if (dup.calendar.id !== i.calendar.id) {
          const label = calendarSourceLabel(i.calendar);
          if (!dup.alsoIn.includes(label) && label !== calendarSourceLabel(dup.calendar)) dup.alsoIn.push(label);
        }
        continue;
      }
      const b: Busy = { key: `${i.calendar.id}|${ev.uid}|${start}`, start, end, title: ev.summary || '(No title)', event: ev, calendar: i.calendar, alsoIn: [] };
      seen.set(byUid, b);
      if (norm(ev.summary)) seen.set(byTitle, b);
      out.push(b);
    }
  }
  return out.sort((x, y) => x.start - y.start || x.end - y.end);
}

/** Stable id for a pair, so "Ignore" survives refreshes. */
export function clashId(a: Busy, b: Busy): string {
  return [a.key, b.key].sort().join('~');
}

/** Every pair overlapping by at least [minOverlapMin] minutes, earliest first. */
export function findClashes(blocks: Busy[], minOverlapMin: number, ignored: readonly string[] = []): Clash[] {
  const min = Math.max(1, minOverlapMin) * 60_000;
  const skip = new Set(ignored);
  const out: Clash[] = [];
  for (let i = 0; i < blocks.length && out.length < MAX_CLASHES; i++) {
    const a = blocks[i];
    for (let j = i + 1; j < blocks.length && blocks[j].start < a.end; j++) {
      const b = blocks[j];
      const overlapStart = Math.max(a.start, b.start);
      const overlapEnd = Math.min(a.end, b.end);
      if (overlapEnd - overlapStart < min) continue;
      const id = clashId(a, b);
      if (skip.has(id)) continue;
      out.push({ id, a, b, overlapStart, overlapEnd });
    }
  }
  return out;
}

/** Clashes from now until [days] ahead, using the user's settings. */
export function upcomingClashes(linked: LinkedEvents[], minOverlapMin: number, ignored: readonly string[], now = Date.now(), days = CLASH_HORIZON_DAYS): Clash[] {
  return findClashes(busyBlocks(linked, now, now + days * 86_400_000), minOverlapMin, ignored).filter((c) => c.overlapEnd > now);
}

/** Clash ids per ISO day (by the day the overlap starts). */
export function clashesByDay(clashes: Clash[]): Map<string, Clash[]> {
  const m = new Map<string, Clash[]>();
  for (const c of clashes) {
    const d = dateToIso(new Date(c.overlapStart));
    const l = m.get(d);
    if (l) l.push(c);
    else m.set(d, [c]);
  }
  return m;
}

/** "Standup (Google)" — how the other side of a clash is named in a notification. */
export function clashPartner(c: Clash, meKey: string): Busy {
  return c.a.key === meKey ? c.b : c.a;
}
