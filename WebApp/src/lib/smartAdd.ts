import { addDaysIso, dateToIso, isoToDate } from '../calendar/deadline';
import type { Priority } from '../types';

/**
 * Smart add: dates, times and priorities typed into a task title ("call CA tomorrow 5pm !1").
 * Pure and conservative: only unambiguous phrases are read, so ordinary titles ("May Tan
 * meeting", "buy 1/2 kg sugar") stay exactly as typed. Identical rules on Android (SmartAdd.kt).
 *
 * Recognised (case-insensitive, whole words):
 *  - date: today, tonight, tomorrow/tmrw, weekday names (full names anywhere; short forms
 *    like "fri" only after on/by/next/this or when nothing but other tokens follows),
 *    "in 3 days" / "in 2 weeks", "25 oct" / "oct 25" / "25th october", "25/10" and
 *    "25/10/2026" (day first; a bare day/month needs a preposition or the tail rule), ISO days.
 *    "may" as a month needs the same care as short weekdays ("3 may be enough" is not a date).
 *  - time: 5pm, 5:30 pm, 17:00 (two-digit 24h), "at 9" / "at 9:30" (1–7 read as evening,
 *    8–12 as morning), noon/midday, "in 2 hours" / "in 30 min".
 *  - priority: !1–!4, !high / !med / !low / !none, p1–p4.
 *
 * A date sets the deadline; a time sets a one-time reminder on that day (today if it is still
 * ahead, else tomorrow). One token of each kind (the leftmost). A time that has already passed
 * on an explicit day is left in the title untouched.
 */
export type SmartKind = 'date' | 'time' | 'priority';
export type SmartChip = { kind: SmartKind; text: string };
export type SmartParse = {
  /** Title with the recognised phrases removed (the input itself when nothing was recognised). */
  title: string;
  dueDate: string | null;
  reminderTime: number | null;
  priority: Priority | null;
  chips: SmartChip[];
};

type Span = { start: number; end: number };
type Clock = { hour: number; minute: number };
/** What a time rule read: a clock time on some day, or an exact moment ("in 2 hours"). */
type TimeHit = { clock: Clock } | { at: number };

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6
};
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12
};
/** Short weekday names and "may" are ordinary words too: they need a preposition or the tail rule. */
const NEEDS_CONTEXT = new Set(['sun', 'mon', 'tue', 'tues', 'wed', 'weds', 'thu', 'thur', 'thurs', 'fri', 'sat', 'may']);
const PRIORITY_WORDS: Record<string, Priority> = {
  '1': 'HIGH', '2': 'MEDIUM', '3': 'LOW', '4': 'NONE',
  high: 'HIGH', med: 'MEDIUM', medium: 'MEDIUM', low: 'LOW', none: 'NONE'
};

const B0 = '(?<![\\w])';
const B1 = '(?![\\w])';
const PREP = '(?:(?:on|by|due|due on|due by)\\s+)?';
const RE_PRIORITY = new RegExp(`(?<!\\S)!([1-4]|high|med|medium|low|none)${B1}|${B0}p([1-4])${B1}`, 'gi');
const RE_CLOCK = new RegExp(`${B0}(?:(at)\\s+)?(\\d{1,2})(?::(\\d{2}))?(?:\\s?(am|pm|a\\.m\\.|p\\.m\\.))?${B1}`, 'gi');
const RE_NOON = new RegExp(`${B0}(?:at\\s+)?(?:noon|midday)${B1}`, 'gi');
const RE_IN_TIME = new RegExp(`${B0}in\\s+(\\d+|an?)\\s+(min|mins|minute|minutes|hr|hrs|hour|hours)${B1}`, 'gi');
const RE_DAY_WORD = new RegExp(`${B0}${PREP}(today|tonight|tomorrow|tmrw)${B1}`, 'gi');
const RE_IN_DAYS = new RegExp(`${B0}in\\s+(\\d+|an?)\\s+(day|days|week|weeks)${B1}`, 'gi');
const RE_D_MON = new RegExp(`${B0}${PREP}(\\d{1,2})(?:st|nd|rd|th)?\\s+([a-z]+)\\.?(?:\\s+(\\d{4}))?${B1}`, 'gi');
const RE_MON_D = new RegExp(`${B0}${PREP}([a-z]+)\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:,?\\s+(\\d{4}))?${B1}`, 'gi');
const RE_NUMERIC = new RegExp(`${B0}${PREP}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?(?![\\w/.:])`, 'gi');
const RE_ISO = new RegExp(`${B0}${PREP}(\\d{4})-(\\d{2})-(\\d{2})${B1}`, 'gi');
const RE_WEEKDAY = new RegExp(`${B0}(?:(?:on|by|next|this|due|due on|due by)\\s+)?([a-z]+)${B1}`, 'gi');

function atTime(dayIso: string, c: Clock): number {
  const d = isoToDate(dayIso);
  d.setHours(c.hour, c.minute, 0, 0);
  return d.getTime();
}

function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(y, m - 1, d);
  return t.getMonth() === m - 1 && t.getDate() === d;
}

/** Day/month without a year: the next such day, today included. */
function nextOccurrence(todayIso: string, m: number, d: number, year?: number): string | null {
  const y = year ?? Number(todayIso.slice(0, 4));
  if (!validDay(y, m, d)) return year == null && validDay(y + 1, m, d) ? dateToIso(new Date(y + 1, m - 1, d)) : null;
  const iso = dateToIso(new Date(y, m - 1, d));
  if (year == null && iso < todayIso) return validDay(y + 1, m, d) ? dateToIso(new Date(y + 1, m - 1, d)) : null;
  return iso;
}

const count = (s: string) => (s === 'a' || s === 'an' ? 1 : Number(s));
const hasPrep = (text: string) => /^(on|by|next|this|due)\b/i.test(text);

/** True when nothing but whitespace and other recognised tokens follows [end]. */
function tailIsTokens(input: string, end: number, spans: Span[]): boolean {
  let rest = '';
  for (let i = end; i < input.length; i++) rest += spans.some((s) => i >= s.start && i < s.end) ? ' ' : input[i];
  return rest.trim() === '';
}

type Hit<T> = { value: T; span: Span };

/**
 * Leftmost valid match across [rules]. Each rule's [read] returns null to reject a match, in which
 * case scanning resumes one character on, so a rejected "on 5" can't hide the "5/10" inside it.
 */
function leftmost<T>(input: string, rules: Array<[RegExp, (m: RegExpExecArray, span: Span) => T | null]>): Hit<T> | null {
  let best: Hit<T> | null = null;
  for (const [re, read] of rules) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input))) {
      re.lastIndex = m.index + 1;
      if (best && m.index >= best.span.start) break;
      const span = { start: m.index, end: m.index + m[0].length };
      const value = read(m, span);
      if (value == null) continue;
      best = { value, span };
      break;
    }
  }
  return best;
}

export function parseSmartAdd(input: string, now: Date | number = Date.now(), ignore: Iterable<SmartKind> = []): SmartParse {
  const skip = new Set(ignore);
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const nowDate = new Date(nowMs);
  const todayIso = dateToIso(nowDate);
  const none: SmartParse = { title: input.trim(), dueDate: null, reminderTime: null, priority: null, chips: [] };
  const spans: Span[] = [];
  const chips: Array<SmartChip & { start: number }> = [];

  // ── Priority ──
  let priority: Priority | null = null;
  if (!skip.has('priority')) {
    const hit = leftmost<Priority>(input, [[RE_PRIORITY, (m) => PRIORITY_WORDS[(m[1] ?? m[2]).toLowerCase()]]]);
    if (hit) {
      priority = hit.value;
      spans.push(hit.span);
      chips.push({ kind: 'priority', text: input.slice(hit.span.start, hit.span.end), start: hit.span.start });
    }
  }

  // ── Time ──
  let time: Hit<TimeHit> | null = null;
  if (!skip.has('time')) {
    time = leftmost<TimeHit>(input, [
      [
        RE_CLOCK,
        (m) => {
          const at = !!m[1];
          const h = Number(m[2]);
          const minute = m[3] == null ? 0 : Number(m[3]);
          const ampm = m[4]?.toLowerCase().replace(/\./g, '');
          if (minute > 59) return null;
          let hour: number;
          if (ampm) {
            if (h < 1 || h > 12) return null;
            hour = (h % 12) + (ampm === 'pm' ? 12 : 0);
          } else if (at) {
            if (h > 23) return null;
            hour = h >= 1 && h <= 7 ? h + 12 : h; // "at 5" is the evening, "at 9" the morning
          } else if (m[3] != null && m[2].length === 2) {
            if (h > 23) return null; // 17:00, 09:30 — a bare "9:30" is left alone
            hour = h;
          } else return null;
          return { clock: { hour, minute } };
        }
      ],
      [RE_NOON, () => ({ clock: { hour: 12, minute: 0 } })],
      [RE_IN_TIME, (m) => ({ at: nowMs + count(m[1].toLowerCase()) * (/^h/i.test(m[2]) ? 3_600_000 : 60_000) })]
    ]);
    if (time) spans.push(time.span);
  }

  // ── Date ──
  let date: Hit<string> | null = null;
  if (!skip.has('date')) {
    const timeSpan = time?.span;
    const overlapsTime = (s: Span) => !!timeSpan && s.start < timeSpan.end && s.end > timeSpan.start; // "at 5 oct" stays a time
    const needsContext = (word: string, m: RegExpExecArray, s: Span) => NEEDS_CONTEXT.has(word) && !hasPrep(m[0]) && !tailIsTokens(input, s.end, spans);
    const monthDay = (mon: string, day: string, year: string | undefined, m: RegExpExecArray, s: Span) => {
      mon = mon.toLowerCase();
      if (!(mon in MONTHS) || needsContext(mon, m, s)) return null;
      return nextOccurrence(todayIso, MONTHS[mon], Number(day), year ? Number(year) : undefined);
    };
    date = leftmost<string>(input, [
      [RE_DAY_WORD, (m, s) => (overlapsTime(s) ? null : /^(tomorrow|tmrw)$/i.test(m[1]) ? addDaysIso(todayIso, 1) : todayIso)],
      [RE_IN_DAYS, (m, s) => (overlapsTime(s) ? null : addDaysIso(todayIso, count(m[1].toLowerCase()) * (/^w/i.test(m[2]) ? 7 : 1)))],
      [RE_D_MON, (m, s) => (overlapsTime(s) ? null : monthDay(m[2], m[1], m[3], m, s))],
      [RE_MON_D, (m, s) => (overlapsTime(s) ? null : monthDay(m[1], m[2], m[3], m, s))],
      [
        RE_NUMERIC,
        (m, s) => {
          if (overlapsTime(s)) return null;
          // Day first, like the rest of the app; month first only when day first is impossible.
          let d = Number(m[1]);
          let mo = Number(m[2]);
          const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
          if (year == null && !hasPrep(m[0]) && !tailIsTokens(input, s.end, spans)) return null; // "1/2 kg"
          if (mo > 12 && d <= 12) [d, mo] = [mo, d];
          return nextOccurrence(todayIso, mo, d, year);
        }
      ],
      [
        RE_ISO,
        (m, s) => {
          if (overlapsTime(s)) return null;
          const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
          return validDay(y, mo, d) ? dateToIso(new Date(y, mo - 1, d)) : null;
        }
      ],
      [
        RE_WEEKDAY,
        (m, s) => {
          const w = m[1].toLowerCase();
          if (overlapsTime(s) || !(w in WEEKDAYS) || needsContext(w, m, s)) return null;
          const ahead = ((WEEKDAYS[w] - nowDate.getDay() + 7) % 7) || 7; // the next one, never today
          return addDaysIso(todayIso, ahead);
        }
      ]
    ]);
    if (date) spans.push(date.span);
  }
  const dueDate = date?.value ?? null;

  // ── Reminder: the time on its day. ──
  let reminderTime: number | null = null;
  const hit = time?.value;
  if (hit && 'at' in hit) {
    reminderTime = Math.floor(hit.at / 60_000) * 60_000;
  } else if (time && hit) {
    const clock = hit.clock;
    if (dueDate) {
      const at = atTime(dueDate, clock);
      if (at > nowMs) reminderTime = at;
      else {
        // Already passed on that day: leave the words in the title rather than guess.
        spans.splice(spans.indexOf(time.span), 1);
        time = null;
      }
    } else {
      const at = atTime(todayIso, clock);
      reminderTime = at > nowMs ? at : atTime(addDaysIso(todayIso, 1), clock);
    }
  }
  if (time) chips.push({ kind: 'time', text: input.slice(time.span.start, time.span.end), start: time.span.start });
  if (date) chips.push({ kind: 'date', text: input.slice(date.span.start, date.span.end), start: date.span.start });

  if (!spans.length) return none;
  const title = stripSpans(input, spans);
  if (!title) return none; // "tomorrow" on its own is just a task called tomorrow
  chips.sort((a, b) => a.start - b.start);
  return { title, dueDate, reminderTime, priority, chips: chips.map(({ kind, text }) => ({ kind, text })) };
}

function stripSpans(input: string, spans: Span[]): string {
  let out = '';
  for (let i = 0; i < input.length; i++) out += spans.some((s) => i >= s.start && i < s.end) ? ' ' : input[i];
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,;:\-–·]+|[\s,;:\-–·]+$/g, '')
    .trim();
}
