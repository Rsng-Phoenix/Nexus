import { deterministicUuid } from '../import/hash';
import { DEFAULT_DUE_ALERT_TIME, isIsoDate, parseDueAlerts } from './due';

/**
 * iCalendar (RFC 5545) export and import, identical to Android's IcsCodec (spec 3.7 §3).
 *
 * Export: one all-day VEVENT per task with a dueDate (UID "<taskUuid>@nexus", VALARM per
 * dueAlerts offset) and one 15-minute timed VEVENT per exact reminder (UID "<taskUuid>-r@nexus").
 * Deleted and tutorial tasks are left out. Lines are CRLF, folded at 75 UTF-8 octets without
 * splitting a character, text escaped (\\ \; \, \n).
 *
 * Import: unfolds, unescapes, reads VEVENTs (all-day, UTC 'Z', floating, TZID best-effort via
 * Intl incl. common Windows zone names), skips STATUS:CANCELLED and overridden instances
 * (RECURRENCE-ID) of a series that is present, and resolves basic RRULEs to their next occurrence.
 */
export const ICS_MAX_BYTES = 5 * 1024 * 1024;
export const ICS_MAX_EVENTS = 10_000;
export const ICS_UUID_PREFIX = 'ics-';
export const TUTORIAL_UUID_PREFIX = 'nexus-tutorial-';
export const PRODID = '-//Nexus//Priority Matrix//EN';
/** Length of the timed VEVENT exported for an exact reminder. */
const REMINDER_EVENT_MINUTES = 15;
const FOLD_OCTETS = 75;
const DAY_MS = 86_400_000;
const MAX_RRULE_STEPS = 100_000;
const MAX_YEAR = 2200;

export class IcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcsError';
  }
}

/** The fields of a task the exporter reads (a Task with the 3.7 deadline fields satisfies it). */
export type IcsExportTask = {
  taskUuid: string;
  description: string;
  notes: string;
  dueDate?: string;
  dueAlerts?: string;
  dueAlertTime?: number;
  reminderTime: number | null;
  reminderDateOnly: boolean;
  reminderEndDate?: number;
  deletedAt: number;
};

export type IcsExportOptions = {
  now: number;
  calName?: string;
  /** Notes codec → plain text for DESCRIPTION. Defaults to the notes string unchanged. */
  notesToText?: (notes: string) => string;
};

export type IcsDateTime = {
  /** Calendar day: the literal date for all-day values, else the device-local day of `time`. */
  date: string;
  /** Epoch ms for timed values. */
  time?: number;
  allDay: boolean;
  /** The property value as written, e.g. "20261005" or "20261005T090000Z" (no parameters). */
  raw: string;
  tzid?: string;
};

export type IcsFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export type IcsRrule = {
  freq: IcsFreq;
  interval: number;
  count?: number;
  /** Raw UNTIL value ("20261231" or "20261231T235959Z"). */
  until?: string;
  /** BYDAY entries as written, e.g. ["MO", "WE"] or ["2TU", "-1FR"]. */
  byDay?: string[];
  wkst?: string;
};

export type IcsEvent = {
  uid: string;
  summary: string;
  description: string;
  location?: string;
  start: IcsDateTime;
  end?: IcsDateTime;
  rrule?: IcsRrule;
  status?: string;
  recurrenceId?: string;
  /** Video-call link (Google Meet, Zoom, Teams…) found in the event, for a Join button. */
  meetingUrl?: string;
};

const MEETING_HOSTS = [
  'meet.google.com',
  'zoom.us',
  'zoom.com',
  'teams.microsoft.com',
  'teams.live.com',
  'webex.com',
  'whereby.com',
  'meet.jit.si',
  'gotomeeting.com',
  'gotomeet.me',
  'chime.aws'
];
const ZOHO_HOSTS = ['zoho.com', 'zoho.in', 'zoho.eu'];
const hostIs = (host: string, d: string) => host === d || host.endsWith(`.${d}`);

/** A https link to a known video-call service, or null (look-alike hosts are rejected). */
export function meetingLink(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim().replace(/[)>.,;'"\]]+$/, ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (MEETING_HOSTS.some((d) => hostIs(host, d))) return u.toString();
  if (ZOHO_HOSTS.some((d) => hostIs(host, d)) && /meeting/i.test(u.hostname + u.pathname)) return u.toString();
  return null;
}

/** The event's meeting link: Google's conference field, then URL, LOCATION, then the description text. */
export function findMeetingUrl(fields: { conference?: string; url?: string; location?: string; description?: string }): string | undefined {
  for (const v of [fields.conference, fields.url]) {
    const hit = v && meetingLink(v);
    if (hit) return hit;
  }
  for (const text of [fields.location, fields.description]) {
    for (const m of (text ?? '').matchAll(/https:\/\/[^\s<>"]+/gi)) {
      const hit = meetingLink(m[0]);
      if (hit) return hit;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- shared helpers

const pad2 = (n: number) => String(n).padStart(2, '0');
const pad4 = (n: number) => String(n).padStart(4, '0');

function isoOfUtcDay(dayNum: number): string {
  const t = new Date(dayNum * DAY_MS);
  return `${pad4(t.getUTCFullYear())}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function dayNumOf(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function localIsoDate(ms: number): string {
  const t = new Date(ms);
  return `${pad4(t.getFullYear())}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
}

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// ---------------------------------------------------------------- export

export function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function utf8Len(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** Folds one content line to ≤ 75 octets per physical line, never inside a UTF-8 sequence. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = FOLD_OCTETS;
  for (const ch of line) {
    const b = utf8Len(ch.codePointAt(0) ?? 0);
    if (bytes + b > limit) {
      parts.push(cur);
      cur = '';
      bytes = 0;
      limit = FOLD_OCTETS - 1; // continuation lines start with one space
    }
    cur += ch;
    bytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

function utcStamp(ms: number): string {
  const t = new Date(ms);
  return (
    `${pad4(t.getUTCFullYear())}${pad2(t.getUTCMonth() + 1)}${pad2(t.getUTCDate())}` +
    `T${pad2(t.getUTCHours())}${pad2(t.getUTCMinutes())}${pad2(t.getUTCSeconds())}Z`
  );
}

function icsDate(iso: string): string {
  return iso.replace(/-/g, '');
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return isoOfUtcDay(dayNumOf(y, m, d) + days);
}

/**
 * RFC 5545 duration for a signed number of minutes, e.g. 540 → "PT9H", -900 → "-PT15H",
 * -2340 → "-P1DT15H", 2490 → "P1DT17H30M", 0 → "PT0M".
 */
export function formatDuration(minutes: number): string {
  if (minutes === 0) return 'PT0M';
  const sign = minutes < 0 ? '-' : '';
  let rest = Math.abs(Math.round(minutes));
  const days = Math.floor(rest / 1440);
  rest -= days * 1440;
  const h = Math.floor(rest / 60);
  const m = rest - h * 60;
  let out = `${sign}P${days ? `${days}D` : ''}`;
  if (h || m) out += `T${h ? `${h}H` : ''}${m ? `${m}M` : ''}`;
  return out;
}

/**
 * VALARM trigger for deadline offset `k` days at `alertTime` minutes after local midnight,
 * relative to the all-day event's start (local midnight of dueDate): k·1440 + alertTime minutes.
 */
export function dueAlarmTrigger(offsetDays: number, alertTime: number): string {
  return formatDuration(offsetDays * 1440 + alertTime);
}

function isExportable(t: IcsExportTask): boolean {
  return t.deletedAt <= 0 && !t.taskUuid.startsWith(TUTORIAL_UUID_PREFIX);
}

function hasExactReminder(t: IcsExportTask): boolean {
  return t.reminderTime != null && !t.reminderDateOnly && !((t.reminderEndDate ?? 0) > 0);
}

export function exportIcs(tasks: IcsExportTask[], opts: IcsExportOptions): string {
  const toText = opts.notesToText ?? ((n: string) => n);
  const stamp = utcStamp(opts.now);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(opts.calName ?? 'Nexus')}`
  ];
  for (const t of tasks) {
    if (!isExportable(t)) continue;
    const summary = escapeText(t.description);
    const notes = toText(t.notes ?? '').trim();
    const dueDate = t.dueDate ?? '';
    if (isIsoDate(dueDate)) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${t.taskUuid}@nexus`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(dueDate)}`,
        `DTEND;VALUE=DATE:${icsDate(addDaysIso(dueDate, 1))}`,
        `SUMMARY:${summary}`
      );
      if (notes) lines.push(`DESCRIPTION:${escapeText(notes)}`);
      lines.push('TRANSP:TRANSPARENT');
      const alertTime = t.dueAlertTime ?? DEFAULT_DUE_ALERT_TIME;
      for (const k of parseDueAlerts(t.dueAlerts)) {
        lines.push(
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `DESCRIPTION:${summary}`,
          `TRIGGER:${dueAlarmTrigger(k, alertTime)}`,
          'END:VALARM'
        );
      }
      lines.push('END:VEVENT');
    }
    if (hasExactReminder(t)) {
      const at = t.reminderTime as number;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${t.taskUuid}-r@nexus`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${utcStamp(at)}`,
        `DTEND:${utcStamp(at + REMINDER_EVENT_MINUTES * 60_000)}`,
        `SUMMARY:${summary}`
      );
      if (notes) lines.push(`DESCRIPTION:${escapeText(notes)}`);
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${summary}`,
        'TRIGGER:PT0M',
        'END:VALARM',
        'END:VEVENT'
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- time zones

/** Windows zone names (Outlook / Exchange TZIDs) → IANA. */
const WINDOWS_ZONES: Record<string, string> = {
  'India Standard Time': 'Asia/Kolkata',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Arabian Standard Time': 'Asia/Dubai',
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC'
};

type Zone = { iana: string } | { fixedMinutes: number };

const zoneCache = new Map<string, Zone | null>();
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat | null {
  let f = formatterCache.get(tz);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return null;
  }
  formatterCache.set(tz, f);
  return f;
}

/** IANA / Windows / "(UTC+05:30) …" / Mozilla-prefixed TZIDs → a zone; null = treat as floating. */
export function resolveTzid(tzid: string): Zone | null {
  const key = tzid.trim().replace(/^"|"$/g, '');
  if (zoneCache.has(key)) return zoneCache.get(key) ?? null;
  let zone: Zone | null = null;
  const win = WINDOWS_ZONES[key];
  const fixed = /^\(?(?:UTC|GMT)\s*([+-])(\d{1,2}):?(\d{2})\)?/i.exec(key);
  // "/mozilla.org/20050126_1/America/New_York" → try "America/Argentina/…", "America/New_York", …
  const segs = key.split('/').filter(Boolean);
  const tails = [3, 2, 1].filter((n) => segs.length > n).map((n) => segs.slice(-n).join('/'));
  for (const cand of [win, key, ...tails]) {
    if (cand && formatterFor(cand)) {
      zone = { iana: cand };
      break;
    }
  }
  if (!zone && fixed) {
    const mins = Number(fixed[2]) * 60 + Number(fixed[3]);
    zone = { fixedMinutes: fixed[1] === '-' ? -mins : mins };
  }
  zoneCache.set(key, zone);
  return zone;
}

/** Offset (ms) of `tz` from UTC at instant `ms`. */
function zoneOffsetMs(tz: string, ms: number): number {
  const f = formatterFor(tz);
  if (!f) return 0;
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

type Wall = { y: number; m: number; d: number; h: number; mi: number; s: number };

function wallInZone(zone: Zone, w: Wall): number {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  if ('fixedMinutes' in zone) return guess - zone.fixedMinutes * 60_000;
  const o1 = zoneOffsetMs(zone.iana, guess);
  const t = guess - o1;
  const o2 = zoneOffsetMs(zone.iana, t);
  return o1 === o2 ? t : guess - o2;
}

// ---------------------------------------------------------------- import

type ContentLine = { name: string; params: Record<string, string>; value: string };

export function unfoldLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

export function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function parseContentLine(line: string): ContentLine | null {
  const n = line.length;
  let i = 0;
  while (i < n && line[i] !== ';' && line[i] !== ':') i++;
  if (i >= n) return null;
  const name = line.slice(0, i).trim().toUpperCase();
  const params: Record<string, string> = {};
  while (line[i] === ';') {
    i++;
    const eq = line.indexOf('=', i);
    if (eq < 0) return null;
    const key = line.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let val = '';
    while (i < n && line[i] !== ';' && line[i] !== ':') {
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) return null;
        val += line.slice(i + 1, close);
        i = close + 1;
      } else {
        val += line[i++];
      }
    }
    params[key] = val;
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

const RE_DATE_VALUE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i;

type TimeKind = { kind: 'date' } | { kind: 'utc' } | { kind: 'floating' } | { kind: 'zone'; zone: Zone; tzid: string };

function formatWallRaw(w: Wall, kind: TimeKind): string {
  const date = `${pad4(w.y)}${pad2(w.m)}${pad2(w.d)}`;
  if (kind.kind === 'date') return date;
  return `${date}T${pad2(w.h)}${pad2(w.mi)}${pad2(w.s)}${kind.kind === 'utc' ? 'Z' : ''}`;
}

function makeDateTime(w: Wall, kind: TimeKind, raw?: string): IcsDateTime {
  const r = raw ?? formatWallRaw(w, kind);
  if (kind.kind === 'date') {
    return { date: `${pad4(w.y)}-${pad2(w.m)}-${pad2(w.d)}`, allDay: true, raw: r };
  }
  let time: number;
  if (kind.kind === 'utc') time = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  else if (kind.kind === 'zone') time = wallInZone(kind.zone, w);
  else time = new Date(w.y, w.m - 1, w.d, w.h, w.mi, w.s).getTime();
  const out: IcsDateTime = { date: localIsoDate(time), time, allDay: false, raw: r };
  if (kind.kind === 'zone') out.tzid = kind.tzid;
  return out;
}

function parseWall(value: string): { wall: Wall; timed: boolean; utc: boolean } | null {
  const m = RE_DATE_VALUE.exec(value.trim());
  if (!m) return null;
  const wall: Wall = {
    y: Number(m[1]),
    m: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4] ?? 0),
    mi: Number(m[5] ?? 0),
    s: Number(m[6] ?? 0)
  };
  if (!validYmd(wall.y, wall.m, wall.d) || wall.h > 23 || wall.mi > 59 || wall.s > 60) return null;
  return { wall, timed: m[4] !== undefined, utc: Boolean(m[7]) };
}

function timeKindOf(params: Record<string, string>, timed: boolean, utc: boolean): TimeKind {
  if (!timed || (params.VALUE ?? '').toUpperCase() === 'DATE') return { kind: 'date' };
  if (utc) return { kind: 'utc' };
  const tzid = params.TZID;
  if (tzid) {
    const zone = resolveTzid(tzid);
    if (zone) return { kind: 'zone', zone, tzid };
  }
  return { kind: 'floating' };
}

export function parseIcsDateTime(value: string, params: Record<string, string> = {}): IcsDateTime | null {
  const p = parseWall(value);
  if (!p) return null;
  return makeDateTime(p.wall, timeKindOf(params, p.timed, p.utc), value.trim());
}

const FREQS = new Set<IcsFreq>(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

export function parseRrule(value: string): IcsRrule | undefined {
  const parts: Record<string, string> = {};
  for (const kv of value.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) parts[kv.slice(0, eq).trim().toUpperCase()] = kv.slice(eq + 1).trim();
  }
  const freq = (parts.FREQ ?? '').toUpperCase() as IcsFreq;
  if (!FREQS.has(freq)) return undefined;
  const interval = Number(parts.INTERVAL ?? 1);
  const rule: IcsRrule = { freq, interval: Number.isInteger(interval) && interval > 0 ? interval : 1 };
  const count = Number(parts.COUNT);
  if (parts.COUNT && Number.isInteger(count) && count > 0) rule.count = count;
  if (parts.UNTIL) rule.until = parts.UNTIL;
  if (parts.BYDAY) rule.byDay = parts.BYDAY.toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.WKST) rule.wkst = parts.WKST.toUpperCase();
  return rule;
}

export function parseIcs(text: string): IcsEvent[] {
  if (text.length > ICS_MAX_BYTES) throw new IcsError('Calendar file is too large (limit 5 MB)');
  const events: IcsEvent[] = [];
  const stack: string[] = [];
  let props: ContentLine[] | null = null;

  for (const line of unfoldLines(text)) {
    if (!line.trim()) continue;
    const cl = parseContentLine(line);
    if (!cl) continue;
    if (cl.name === 'BEGIN') {
      const comp = cl.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT' && stack.length <= 2) props = [];
      continue;
    }
    if (cl.name === 'END') {
      const comp = stack.pop();
      if (comp === 'VEVENT' && props) {
        const ev = eventFromProps(props);
        props = null;
        if (ev) events.push(ev);
        if (events.length >= ICS_MAX_EVENTS) break;
      }
      continue;
    }
    if (props && stack[stack.length - 1] === 'VEVENT') props.push(cl);
  }

  const masters = new Set(events.filter((e) => e.rrule && !e.recurrenceId).map((e) => e.uid));
  return events.filter((e) => !(e.recurrenceId && masters.has(e.uid)));
}

function eventFromProps(props: ContentLine[]): IcsEvent | null {
  const get = (name: string) => props.find((p) => p.name === name);
  const dtstart = get('DTSTART');
  if (!dtstart) return null;
  const start = parseIcsDateTime(dtstart.value, dtstart.params);
  if (!start) return null;
  const status = get('STATUS')?.value.trim().toUpperCase();
  if (status === 'CANCELLED') return null;
  const summary = unescapeText(get('SUMMARY')?.value ?? '').trim();
  // UID is mandatory in RFC 5545; a few exporters omit it, then the summary stands in.
  const uid = (get('UID')?.value ?? '').trim() || summary;
  const ev: IcsEvent = {
    uid,
    summary,
    description: unescapeText(get('DESCRIPTION')?.value ?? '').trim(),
    start
  };
  const location = unescapeText(get('LOCATION')?.value ?? '').trim();
  if (location) ev.location = location;
  const meetingUrl = findMeetingUrl({
    conference: get('X-GOOGLE-CONFERENCE')?.value,
    url: get('URL')?.value,
    location,
    description: ev.description
  });
  if (meetingUrl) ev.meetingUrl = meetingUrl;
  const dtend = get('DTEND');
  const end = dtend ? parseIcsDateTime(dtend.value, dtend.params) : null;
  if (end) ev.end = end;
  const rruleProp = get('RRULE');
  const rrule = rruleProp ? parseRrule(rruleProp.value) : undefined;
  if (rrule) ev.rrule = rrule;
  if (status) ev.status = status;
  const recurrenceId = get('RECURRENCE-ID')?.value.trim();
  if (recurrenceId) ev.recurrenceId = recurrenceId;
  return ev;
}

/**
 * Deterministic task uuid for an imported event, identical on Android:
 * "ics-" + first 24 hex of SHA-256(UTF-8(UID + "\u001f" + DTSTART raw value)), where the raw
 * value is the DTSTART text after ':' as written (e.g. "20261005" or "20261005T090000Z"; no
 * parameters). Recurring events use the series' own DTSTART, so a series is one task.
 */
export async function icsEventToTaskUuid(ev: IcsEvent): Promise<string> {
  return deterministicUuid(ICS_UUID_PREFIX, [ev.uid, ev.start.raw]);
}

// ---------------------------------------------------------------- recurrence

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** 0 = Sunday … 6 = Saturday, for a UTC day number. */
function weekdayOf(dayNum: number): number {
  return (((dayNum + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

function wallFromDayNum(dayNum: number, base: Wall): Wall {
  const t = new Date(dayNum * DAY_MS);
  return { ...base, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

type ByDay = { ord: number; wd: number };

function parseByDay(list: string[] | undefined): ByDay[] {
  const out: ByDay[] = [];
  for (const s of list ?? []) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s);
    if (m) out.push({ ord: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS.indexOf(m[2]) });
  }
  return out;
}

/** Candidate day numbers of a series in ascending order, starting at DTSTART's day. */
function* candidateDays(rule: IcsRrule, start: Wall): Generator<number> {
  const startDay = dayNumOf(start.y, start.m, start.d);
  const byDay = parseByDay(rule.byDay);
  const step = rule.interval;
  switch (rule.freq) {
    case 'DAILY':
      for (let k = 0; ; k++) yield startDay + k * step;
    case 'WEEKLY': {
      if (!byDay.length) {
        for (let k = 0; ; k++) yield startDay + k * 7 * step;
      }
      const wkst = Math.max(0, WEEKDAYS.indexOf(rule.wkst ?? 'MO'));
      const offsets = [...new Set(byDay.map((b) => (b.wd - wkst + 7) % 7))].sort((a, b) => a - b);
      const weekStart = startDay - ((weekdayOf(startDay) - wkst + 7) % 7);
      for (let w = 0; ; w++) {
        for (const off of offsets) yield weekStart + w * 7 * step + off;
      }
    }
    case 'MONTHLY':
      for (let k = 0; ; k++) {
        const mIdx = start.m - 1 + k * step;
        const y = start.y + Math.floor(mIdx / 12);
        const mo = (mIdx % 12) + 1;
        if (y > MAX_YEAR) return;
        if (!byDay.length) {
          if (validYmd(y, mo, start.d)) yield dayNumOf(y, mo, start.d);
          continue;
        }
        const first = dayNumOf(y, mo, 1);
        const len = dayNumOf(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1, 1) - first;
        const days = new Set<number>();
        for (const b of byDay) {
          const matches: number[] = [];
          for (let i = 0; i < len; i++) if (weekdayOf(first + i) === b.wd) matches.push(first + i);
          if (b.ord === 0) matches.forEach((d) => days.add(d));
          else {
            const pick = b.ord > 0 ? matches[b.ord - 1] : matches[matches.length + b.ord];
            if (pick !== undefined) days.add(pick);
          }
        }
        yield* [...days].sort((a, b) => a - b);
      }
    case 'YEARLY':
      for (let k = 0; ; k++) {
        const y = start.y + k * step;
        if (y > MAX_YEAR) return;
        if (validYmd(y, start.m, start.d)) yield dayNumOf(y, start.m, start.d);
      }
  }
}

/** UNTIL as a comparable: an ISO day for DATE values, an instant for DATE-TIME values. */
function untilLimit(until: string | undefined): { date?: string; time?: number } | null {
  if (!until) return null;
  const p = parseWall(until);
  if (!p) return null;
  if (!p.timed) return { date: `${pad4(p.wall.y)}-${pad2(p.wall.m)}-${pad2(p.wall.d)}` };
  return { time: makeDateTime(p.wall, p.utc ? { kind: 'utc' } : { kind: 'floating' }).time };
}

function beyondUntil(occ: IcsDateTime, wallDate: string, lim: { date?: string; time?: number } | null): boolean {
  if (!lim) return false;
  if (lim.date !== undefined) return wallDate > lim.date;
  if (occ.time !== undefined) return occ.time > (lim.time as number);
  return occ.date > localIsoDate(lim.time as number);
}

/**
 * The first occurrence starting at or after `from` (all-day events: on or after `from`'s local
 * day), or null when the event / series is over. DTSTART always counts as the first instance.
 * Supports FREQ DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (weekly days;
 * monthly "2TU"/"-1FR"). EXDATE, BYMONTHDAY, BYSETPOS and other BY* parts are not applied.
 */
export function nextOccurrence(ev: IcsEvent, from: Date): IcsDateTime | null {
  const fromMs = from.getTime();
  const fromDay = localIsoDate(fromMs);
  const notBefore = (o: IcsDateTime) => (o.allDay ? o.date >= fromDay : (o.time as number) >= fromMs);
  const rule = ev.rrule;
  if (!rule) return notBefore(ev.start) ? ev.start : null;

  const p = parseWall(ev.start.raw);
  if (!p) return notBefore(ev.start) ? ev.start : null;
  const kind: TimeKind = ev.start.allDay
    ? { kind: 'date' }
    : p.utc
      ? { kind: 'utc' }
      : ev.start.tzid && resolveTzid(ev.start.tzid)
        ? { kind: 'zone', zone: resolveTzid(ev.start.tzid) as Zone, tzid: ev.start.tzid }
        : { kind: 'floating' };
  const startDay = dayNumOf(p.wall.y, p.wall.m, p.wall.d);
  const lim = untilLimit(rule.until);

  let count = 0;
  let steps = 0;
  let last = -Infinity;
  const consider = (dayNum: number): IcsDateTime | null | undefined => {
    count++;
    if (rule.count !== undefined && count > rule.count) return null;
    const wall = wallFromDayNum(dayNum, p.wall);
    const occ = dayNum === startDay ? ev.start : makeDateTime(wall, kind);
    if (beyondUntil(occ, isoOfUtcDay(dayNum), lim)) return null;
    return notBefore(occ) ? occ : undefined;
  };

  const first = consider(startDay);
  if (first !== undefined) return first;
  for (const day of candidateDays(rule, p.wall)) {
    if (++steps > MAX_RRULE_STEPS) return null;
    if (day <= startDay || day <= last) continue;
    last = day;
    if (new Date(day * DAY_MS).getUTCFullYear() > MAX_YEAR) return null;
    const r = consider(day);
    if (r !== undefined) return r;
  }
  return null;
}
