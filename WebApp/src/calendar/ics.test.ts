import { describe, expect, it } from 'vitest';
import {
  findMeetingUrl,
  meetingLink,
  type IcsEvent,
  type IcsExportTask,
  dueAlarmTrigger,
  escapeText,
  exportIcs,
  foldLine,
  formatDuration,
  icsEventToTaskUuid,
  nextOccurrence,
  parseIcs,
  parseIcsDateTime,
  parseRrule,
  unescapeText,
  unfoldLines
} from './ics';

const NOW = Date.UTC(2026, 8, 24, 8, 0, 0);
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const localDay = (ms: number) => {
  const t = new Date(ms);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

const task = (o: Partial<IcsExportTask>): IcsExportTask => ({
  taskUuid: 'u1',
  description: 'Task',
  notes: '',
  dueDate: '',
  dueAlerts: '',
  dueAlertTime: 540,
  reminderTime: null,
  reminderDateOnly: false,
  reminderEndDate: 0,
  deletedAt: 0,
  ...o
});

describe('durations and VALARM triggers', () => {
  it('formats signed durations', () => {
    expect(formatDuration(0)).toBe('PT0M');
    expect(formatDuration(540)).toBe('PT9H');
    expect(formatDuration(-900)).toBe('-PT15H');
    expect(formatDuration(1440)).toBe('P1D');
    expect(formatDuration(-2880)).toBe('-P2D');
    expect(formatDuration(-15)).toBe('-PT15M');
  });

  it('offsets -2,-1,0,1 at 09:00 relative to the all-day start', () => {
    expect([-2, -1, 0, 1].map((k) => dueAlarmTrigger(k, 540))).toEqual(['-P1DT15H', '-PT15H', 'PT9H', 'P1DT9H']);
  });

  it('offsets -2,-1,0,1 at 17:30', () => {
    expect([-2, -1, 0, 1].map((k) => dueAlarmTrigger(k, 1050))).toEqual([
      '-P1DT6H30M',
      '-PT6H30M',
      'PT17H30M',
      'P1DT17H30M'
    ]);
  });

  it('midnight alert time and a week before', () => {
    expect(dueAlarmTrigger(0, 0)).toBe('PT0M');
    expect(dueAlarmTrigger(-7, 540)).toBe('-P6DT15H');
  });
});

describe('escaping and folding', () => {
  it('escapes and unescapes text', () => {
    const raw = 'a,b;c\\d\nnew\r\nline';
    expect(escapeText(raw)).toBe('a\\,b\\;c\\\\d\\nnew\\nline');
    expect(unescapeText(escapeText(raw))).toBe('a,b;c\\d\nnew\nline');
    expect(unescapeText('x\\Ny')).toBe('x\ny');
  });

  it('folds at 75 octets without splitting multi-byte characters', () => {
    const line = 'SUMMARY:' + 'Ünïcödé 日本語テキスト 😀 '.repeat(12);
    const folded = foldLine(line);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(3);
    const enc = new TextEncoder();
    const strict = new TextDecoder('utf-8', { fatal: true });
    physical.forEach((p, i) => {
      const bytes = enc.encode(p);
      expect(bytes.length).toBeLessThanOrEqual(75);
      if (i > 0) expect(p.startsWith(' ')).toBe(true);
      expect(() => strict.decode(bytes)).not.toThrow();
    });
    expect(unfoldLines(folded)).toEqual([line]);
    expect(foldLine('SHORT:x')).toBe('SHORT:x');
    // Exactly 75 ASCII octets stays on one line; 76 folds.
    expect(foldLine('X'.repeat(75))).toBe('X'.repeat(75));
    expect(foldLine('X'.repeat(76))).toBe(`${'X'.repeat(75)}\r\n X`);
  });
});

describe('exportIcs', () => {
  const tasks: IcsExportTask[] = [
    task({ taskUuid: 'due1', description: 'GST, Q2; filing', notes: 'Line 1\nLine 2', dueDate: '2026-10-05', dueAlerts: '-2,-1,0,1', dueAlertTime: 1050 }),
    task({ taskUuid: 'rem1', description: 'Call bank', reminderTime: utc(2026, 10, 6, 4, 30) }),
    task({ taskUuid: 'both', description: 'Both', dueDate: '2026-12-31', dueAlerts: '0', reminderTime: utc(2026, 12, 30, 12) }),
    task({ taskUuid: 'dateOnly', dueDate: '', reminderTime: utc(2026, 10, 6), reminderDateOnly: true }),
    task({ taskUuid: 'range', reminderTime: utc(2026, 10, 6), reminderEndDate: utc(2026, 10, 8) }),
    task({ taskUuid: 'gone', dueDate: '2026-10-05', deletedAt: 5 }),
    task({ taskUuid: 'nexus-tutorial-1', dueDate: '2026-10-05' }),
    task({ taskUuid: 'bad', dueDate: '2026-13-40' })
  ];
  const ics = exportIcs(tasks, { now: NOW, calName: 'My, Nexus', notesToText: (n) => n.toUpperCase() });

  it('writes the calendar header and CRLF everywhere', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Nexus//Priority Matrix//EN\r\nCALSCALE:GREGORIAN\r\n')).toBe(true);
    expect(ics).toContain('X-WR-CALNAME:My\\, Nexus\r\n');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it('writes an all-day deadline event with one VALARM per offset', () => {
    const ev = ics.slice(ics.indexOf('UID:due1@nexus'), ics.indexOf('END:VEVENT', ics.indexOf('UID:due1@nexus')));
    expect(ev).toContain('DTSTAMP:20260924T080000Z\r\n');
    expect(ev).toContain('DTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261006\r\n');
    expect(ev).toContain('SUMMARY:GST\\, Q2\\; filing\r\n');
    expect(ev).toContain('DESCRIPTION:LINE 1\\nLINE 2\r\n');
    const triggers = [...ev.matchAll(/TRIGGER:(\S+)\r\n/g)].map((m) => m[1]);
    expect(triggers).toEqual(['-P1DT6H30M', '-PT6H30M', 'PT17H30M', 'P1DT17H30M']);
  });

  it('writes a 15-minute UTC event for exact reminders only', () => {
    expect(ics).toContain('UID:rem1-r@nexus\r\nDTSTAMP:20260924T080000Z\r\nDTSTART:20261006T043000Z\r\nDTEND:20261006T044500Z\r\n');
    expect(ics).not.toContain('UID:rem1@nexus');
    expect(ics).toContain('UID:both@nexus');
    expect(ics).toContain('DTEND;VALUE=DATE:20270101');
    expect(ics).toContain('UID:both-r@nexus');
    for (const skipped of ['dateOnly', 'range', 'gone', 'nexus-tutorial-1', 'bad']) expect(ics).not.toContain(`UID:${skipped}`);
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(4);
  });

  it('round-trips: parse(export) gives the same uids, dates, times and text', async () => {
    const events = parseIcs(ics);
    expect(events.map((e) => e.uid)).toEqual(['due1@nexus', 'rem1-r@nexus', 'both@nexus', 'both-r@nexus']);
    const [due, rem, both, bothR] = events;
    expect(due.start).toEqual({ date: '2026-10-05', allDay: true, raw: '20261005' });
    expect(due.end?.date).toBe('2026-10-06');
    expect(due.summary).toBe('GST, Q2; filing');
    expect(due.description).toBe('LINE 1\nLINE 2');
    expect(rem.start.time).toBe(utc(2026, 10, 6, 4, 30));
    expect(rem.start.date).toBe(localDay(utc(2026, 10, 6, 4, 30)));
    expect(rem.end?.time).toBe(utc(2026, 10, 6, 4, 45));
    expect(both.start.date).toBe('2026-12-31');
    expect(bothR.start.time).toBe(utc(2026, 12, 30, 12));
    expect(await icsEventToTaskUuid(due)).toMatch(/^ics-[0-9a-f]{24}$/);
  });

  it('folds long summaries and still round-trips them', () => {
    const long = 'Überweisung für die Steuererklärung 2026 — bitte alle Belege prüfen, sortieren und hochladen ✅';
    const out = exportIcs([task({ taskUuid: 'long', description: long, dueDate: '2026-10-05' })], { now: NOW });
    expect(out.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(parseIcs(out)[0].summary).toBe(long);
  });
});

describe('date-time values and time zones', () => {
  it('all-day, UTC and floating values', () => {
    expect(parseIcsDateTime('20261005', { VALUE: 'DATE' })).toEqual({ date: '2026-10-05', allDay: true, raw: '20261005' });
    expect(parseIcsDateTime('20261005')?.allDay).toBe(true);
    expect(parseIcsDateTime('20261005T090000Z')?.time).toBe(utc(2026, 10, 5, 9));
    const floating = parseIcsDateTime('20261005T090000');
    expect(floating?.time).toBe(new Date(2026, 9, 5, 9, 0, 0).getTime());
    expect(floating?.date).toBe('2026-10-05');
    expect(parseIcsDateTime('20261305T090000')).toBeNull();
    expect(parseIcsDateTime('garbage')).toBeNull();
  });

  it('converts IANA, Windows, Mozilla-style and "(UTC+hh:mm)" TZIDs', () => {
    const at = (tzid: string, v = '20261005T090000') => parseIcsDateTime(v, { TZID: tzid })?.time;
    expect(at('Asia/Kolkata')).toBe(utc(2026, 10, 5, 3, 30));
    expect(at('India Standard Time')).toBe(utc(2026, 10, 5, 3, 30));
    expect(at('America/New_York')).toBe(utc(2026, 10, 5, 13)); // EDT
    expect(at('Eastern Standard Time', '20260115T090000')).toBe(utc(2026, 1, 15, 14)); // EST
    expect(at('Pacific Standard Time')).toBe(utc(2026, 10, 5, 16)); // PDT
    expect(at('GMT Standard Time')).toBe(utc(2026, 10, 5, 8)); // BST
    expect(at('W. Europe Standard Time', '20260115T090000')).toBe(utc(2026, 1, 15, 8)); // CET
    expect(at('/mozilla.org/20050126_1/America/New_York')).toBe(utc(2026, 10, 5, 13));
    expect(at('(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi')).toBe(utc(2026, 10, 5, 3, 30));
    expect(parseIcsDateTime('20261005T090000', { TZID: 'Asia/Kolkata' })?.tzid).toBe('Asia/Kolkata');
    // Unknown zones are treated as floating local time.
    expect(at('Mars/Olympus_Mons')).toBe(new Date(2026, 9, 5, 9).getTime());
  });
});

const GOOGLE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:Work',
  'X-WR-TIMEZONE:Asia/Kolkata',
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Kolkata',
  'X-LIC-LOCATION:Asia/Kolkata',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0530',
  'TZOFFSETTO:+0530',
  'TZNAME:IST',
  'DTSTART:19700101T000000',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'DTSTART:20261005T090000Z',
  'DTEND:20261005T100000Z',
  'DTSTAMP:20260924T080000Z',
  'UID:abc123@google.com',
  'DESCRIPTION:Agenda:\\n1. Budget\\n2. Hiring\\, planning and a very long line th',
  '\tat Google folds with a tab or a space',
  'LOCATION:Room 4\\, HQ',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'SUMMARY:Quarterly review',
  'TRANSP:OPAQUE',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:This is an event reminder',
  'TRIGGER:-P0DT0H30M0S',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261002',
  'DTEND;VALUE=DATE:20261003',
  'UID:holiday-1@example.com',
  'SUMMARY:Gandhi Jayanti',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Kolkata:20261012T103000',
  'DTEND;TZID=Asia/Kolkata:20261012T110000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'UID:standup@google.com',
  'SUMMARY:Standup',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Kolkata:20261019T120000',
  'RECURRENCE-ID;TZID=Asia/Kolkata:20261019T103000',
  'UID:standup@google.com',
  'SUMMARY:Standup (moved)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261007T090000Z',
  'UID:cancelled@google.com',
  'STATUS:CANCELLED',
  'SUMMARY:Cancelled',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n');

const OUTLOOK = [
  'BEGIN:VCALENDAR',
  'METHOD:PUBLISH',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'X-WR-CALNAME:Calendar',
  'BEGIN:VTIMEZONE',
  'TZID:India Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T000000',
  'TZOFFSETFROM:+0530',
  'TZOFFSETTO:+0530',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VTIMEZONE',
  'TZID:Pacific Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:-0700',
  'TZOFFSETTO:-0800',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:-0800',
  'TZOFFSETTO:-0700',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'DESCRIPTION:\\n',
  'UID:040000008200E00074C5B7101A82E0080000000010B3F8D5C1D4DC01000000000000000',
  ' 0100000006B4A3F7E2C2E0A4B8F1D2E3C4B5A6978',
  'SUMMARY;LANGUAGE=en-US:Client call',
  'DTSTART;TZID=India Standard Time:20261006T150000',
  'DTEND;TZID=India Standard Time:20261006T153000',
  'CLASS:PUBLIC',
  'PRIORITY:5',
  'DTSTAMP:20260924T063000Z',
  'TRANSP:OPAQUE',
  'STATUS:CONFIRMED',
  'SEQUENCE:0',
  'LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting',
  'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Vendor sync',
  'DTSTART;TZID="Pacific Standard Time":20261006T090000',
  'DTEND;TZID="Pacific Standard Time":20261006T093000',
  'UID:vendor-sync-1',
  'RRULE:FREQ=WEEKLY;UNTIL=20261103T160000Z;INTERVAL=1;BYDAY=TU;WKST=SU',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Offsite',
  'DTSTART;VALUE=DATE:20261009',
  'DTEND;VALUE=DATE:20261010',
  'UID:offsite-1',
  'X-MICROSOFT-CDO-ALLDAYEVENT:TRUE',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

describe('parseIcs samples', () => {
  it('Google Calendar export', async () => {
    const events = parseIcs(GOOGLE);
    expect(events.map((e) => e.summary)).toEqual(['Quarterly review', 'Gandhi Jayanti', 'Standup']);
    const [review, holiday, standup] = events;
    expect(review.start.time).toBe(utc(2026, 10, 5, 9));
    expect(review.description).toBe('Agenda:\n1. Budget\n2. Hiring, planning and a very long line that Google folds with a tab or a space');
    expect(review.location).toBe('Room 4, HQ');
    expect(review.status).toBe('CONFIRMED');
    expect(holiday.start).toEqual({ date: '2026-10-02', allDay: true, raw: '20261002' });
    expect(standup.start.time).toBe(utc(2026, 10, 12, 5));
    expect(standup.rrule).toEqual({ freq: 'WEEKLY', interval: 1, byDay: ['MO'] });
    // The spec's reference uuids (Android must match).
    expect(await icsEventToTaskUuid(review)).toBe('ics-18b283de86463bdfb199e476');
    expect(await icsEventToTaskUuid(holiday)).toBe('ics-ebb2dd86915f7f4d721fe20b');
    // Next standup after 2026-10-20 is Monday 26 Oct 10:30 IST.
    expect(nextOccurrence(standup, new Date(utc(2026, 10, 20)))?.time).toBe(utc(2026, 10, 26, 5));
  });

  it('Outlook export with Windows TZIDs', () => {
    const events = parseIcs(OUTLOOK);
    expect(events.map((e) => e.summary)).toEqual(['Client call', 'Vendor sync', 'Offsite']);
    const [call, vendor, offsite] = events;
    expect(call.uid).toBe('040000008200E00074C5B7101A82E0080000000010B3F8D5C1D4DC010000000000000000100000006B4A3F7E2C2E0A4B8F1D2E3C4B5A6978');
    expect(call.start.time).toBe(utc(2026, 10, 6, 9, 30));
    expect(call.start.tzid).toBe('India Standard Time');
    expect(call.description).toBe('');
    expect(vendor.start.time).toBe(utc(2026, 10, 6, 16));
    expect(vendor.rrule).toEqual({ freq: 'WEEKLY', interval: 1, until: '20261103T160000Z', byDay: ['TU'], wkst: 'SU' });
    expect(nextOccurrence(vendor, new Date(utc(2026, 10, 21)))?.time).toBe(utc(2026, 10, 27, 16));
    // 3 Nov is after the DST change (09:00 PST = 17:00Z), past UNTIL → series over.
    expect(nextOccurrence(vendor, new Date(utc(2026, 10, 28)))).toBeNull();
    expect(offsite.start.date).toBe('2026-10-09');
  });

  it('skips cancelled and overridden instances, keeps orphan overrides', () => {
    const orphan = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'RECURRENCE-ID:20261005T090000Z', 'DTSTART:20261005T100000Z', 'SUMMARY:Moved', 'END:VEVENT', 'END:VCALENDAR'].join('\n');
    expect(parseIcs(orphan).map((e) => e.summary)).toEqual(['Moved']);
    expect(parseIcs(GOOGLE).some((e) => e.summary.includes('moved') || e.summary === 'Cancelled')).toBe(false);
  });

  it('tolerates LF line ends, missing UID and junk lines; skips events without DTSTART', () => {
    const text = 'BEGIN:VCALENDAR\nno colon here\nBEGIN:VEVENT\nSUMMARY:No uid\nDTSTART:20261005\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:No start\nEND:VEVENT\nEND:VCALENDAR\n';
    const events = parseIcs(text);
    expect(events.length).toBe(1);
    expect(events[0].uid).toBe('No uid');
  });

  it('caps size and event count', () => {
    expect(() => parseIcs('x'.repeat(5 * 1024 * 1024 + 1))).toThrow('too large');
    const one = 'BEGIN:VEVENT\r\nUID:e\r\nDTSTART:20261005\r\nEND:VEVENT\r\n';
    const many = `BEGIN:VCALENDAR\r\n${one.repeat(10_050)}END:VCALENDAR\r\n`;
    expect(parseIcs(many).length).toBe(10_000);
  });
});

describe('nextOccurrence', () => {
  const allDay = (date: string, rrule?: string): IcsEvent => ({
    uid: 'r',
    summary: 'r',
    description: '',
    start: parseIcsDateTime(date.replace(/-/g, ''), { VALUE: 'DATE' })!,
    rrule: rrule ? parseRrule(rrule) : undefined
  });
  const timed = (raw: string, rrule?: string, params: Record<string, string> = {}): IcsEvent => ({
    uid: 't',
    summary: 't',
    description: '',
    start: parseIcsDateTime(raw, params)!,
    rrule: rrule ? parseRrule(rrule) : undefined
  });
  const localMidnight = (y: number, m: number, d: number) => new Date(y, m - 1, d);
  const nextDate = (ev: IcsEvent, y: number, m: number, d: number) => nextOccurrence(ev, localMidnight(y, m, d))?.date ?? null;

  it('single events', () => {
    const ev = allDay('2026-10-05');
    expect(nextDate(ev, 2026, 10, 5)).toBe('2026-10-05');
    expect(nextDate(ev, 2026, 10, 6)).toBeNull();
    const t = timed('20261005T090000Z');
    expect(nextOccurrence(t, new Date(utc(2026, 10, 5, 8)))?.time).toBe(utc(2026, 10, 5, 9));
    expect(nextOccurrence(t, new Date(utc(2026, 10, 5, 10)))).toBeNull();
  });

  it('DAILY with INTERVAL and COUNT', () => {
    expect(nextDate(allDay('2026-10-01', 'FREQ=DAILY;INTERVAL=2'), 2026, 10, 4)).toBe('2026-10-05');
    expect(nextDate(allDay('2026-10-01', 'FREQ=DAILY;COUNT=3'), 2026, 10, 3)).toBe('2026-10-03');
    expect(nextDate(allDay('2026-10-01', 'FREQ=DAILY;COUNT=3'), 2026, 10, 4)).toBeNull();
    expect(nextDate(allDay('2020-01-01', 'FREQ=DAILY'), 2026, 10, 4)).toBe('2026-10-04');
    expect(nextDate(allDay('2026-10-10', 'FREQ=DAILY'), 2026, 10, 4)).toBe('2026-10-10');
  });

  it('DAILY timed with UNTIL in UTC', () => {
    const ev = timed('20261001T090000Z', 'FREQ=DAILY;UNTIL=20261003T090000Z');
    expect(nextOccurrence(ev, new Date(utc(2026, 10, 3, 8)))?.time).toBe(utc(2026, 10, 3, 9));
    expect(nextOccurrence(ev, new Date(utc(2026, 10, 3, 10)))).toBeNull();
  });

  it('WEEKLY with BYDAY, INTERVAL and UNTIL', () => {
    const mwf = timed('20261005T090000Z', 'FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(nextOccurrence(mwf, new Date(utc(2026, 10, 6)))?.time).toBe(utc(2026, 10, 7, 9));
    expect(nextOccurrence(mwf, new Date(utc(2026, 10, 9, 10)))?.time).toBe(utc(2026, 10, 12, 9));
    const biweekly = allDay('2026-10-06', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH');
    expect(nextDate(biweekly, 2026, 10, 7)).toBe('2026-10-08');
    expect(nextDate(biweekly, 2026, 10, 9)).toBe('2026-10-20');
    const plain = allDay('2026-10-05', 'FREQ=WEEKLY;UNTIL=20261010');
    expect(nextDate(plain, 2026, 10, 6)).toBeNull();
    expect(nextDate(allDay('2026-10-05', 'FREQ=WEEKLY;COUNT=2'), 2026, 10, 6)).toBe('2026-10-12');
    expect(nextDate(allDay('2026-10-05', 'FREQ=WEEKLY;COUNT=2'), 2026, 10, 13)).toBeNull();
  });

  it('WEEKLY in a TZID keeps wall-clock time across DST', () => {
    const ev = timed('20261019T090000', 'FREQ=WEEKLY', { TZID: 'America/New_York' });
    expect(ev.start.time).toBe(utc(2026, 10, 19, 13));
    expect(nextOccurrence(ev, new Date(utc(2026, 10, 27)))?.time).toBe(utc(2026, 11, 2, 14));
  });

  it('MONTHLY by month day (skipping short months) and by nth weekday', () => {
    expect(nextDate(allDay('2026-01-31', 'FREQ=MONTHLY'), 2026, 2, 1)).toBe('2026-03-31');
    expect(nextDate(allDay('2026-10-13', 'FREQ=MONTHLY;BYDAY=2TU'), 2026, 10, 14)).toBe('2026-11-10');
    expect(nextDate(allDay('2026-10-30', 'FREQ=MONTHLY;BYDAY=-1FR'), 2026, 10, 31)).toBe('2026-11-27');
    expect(nextDate(allDay('2026-10-05', 'FREQ=MONTHLY;INTERVAL=3'), 2026, 10, 6)).toBe('2027-01-05');
    // Impossible rule terminates instead of looping.
    expect(nextDate(allDay('2026-10-05', 'FREQ=MONTHLY;BYDAY=6MO'), 2026, 10, 6)).toBeNull();
  });

  it('YEARLY including 29 February', () => {
    expect(nextDate(allDay('2024-02-29', 'FREQ=YEARLY'), 2026, 1, 1)).toBe('2028-02-29');
    expect(nextDate(allDay('2020-10-05', 'FREQ=YEARLY;INTERVAL=2'), 2026, 10, 6)).toBe('2028-10-05');
    expect(nextDate(allDay('2026-10-05', 'FREQ=YEARLY'), 2026, 1, 1)).toBe('2026-10-05');
  });

  it('unsupported FREQ is treated as a single event', () => {
    expect(parseRrule('FREQ=HOURLY')).toBeUndefined();
    expect(parseRrule('FREQ=DAILY;INTERVAL=0;COUNT=-1')).toEqual({ freq: 'DAILY', interval: 1 });
  });
});


describe('meeting links', () => {
  it('finds Google Meet, Zoom and Teams links wherever the calendar put them', () => {
    expect(findMeetingUrl({ conference: 'https://meet.google.com/abc-defg-hij' })).toBe('https://meet.google.com/abc-defg-hij');
    expect(findMeetingUrl({ description: 'Join Zoom Meeting\nhttps://us02web.zoom.us/j/123456?pwd=x).\nPasscode 1' })).toBe('https://us02web.zoom.us/j/123456?pwd=x');
    expect(findMeetingUrl({ location: 'Microsoft Teams https://teams.microsoft.com/l/meetup-join/19%3a' })).toBe('https://teams.microsoft.com/l/meetup-join/19%3a');
    expect(findMeetingUrl({ description: 'Agenda: https://docs.google.com/x then https://meet.google.com/xyz' })).toBe('https://meet.google.com/xyz');
  });
  it('ignores look-alike hosts, plain http and ordinary links', () => {
    expect(meetingLink('https://meet.google.com.evil.io/x')).toBeNull();
    expect(meetingLink('https://evilzoom.us/j/1')).toBeNull();
    expect(meetingLink('http://meet.google.com/abc')).toBeNull();
    expect(findMeetingUrl({ description: 'Notes https://example.com/meeting' })).toBeUndefined();
    expect(meetingLink('https://meeting.zoho.in/meeting/join?key=1')).toBe('https://meeting.zoho.in/meeting/join?key=1');
  });
  it('is read from a real event', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261001T090000Z\r\nSUMMARY:Standup\r\nDESCRIPTION:Join: https://meet.google.com/aaa-bbbb-ccc\\nThanks\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    expect(parseIcs(ics)[0].meetingUrl).toBe('https://meet.google.com/aaa-bbbb-ccc');
  });
});
