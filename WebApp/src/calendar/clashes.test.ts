import { describe, expect, it } from 'vitest';
import type { LinkedCalendar } from '../settings/store';
import { busyBlocks, calendarOwnerEmail, findClashes, upcomingClashes } from './clashes';
import { parseIcs } from './ics';

const utc = (d: number, h: number, mi = 0) => Date.UTC(2026, 9, d, h, mi);
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const ev = (uid: string, title: string, start: number, end: number, ...extra: string[]) =>
  ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, ...extra, 'END:VEVENT'];
const calendar = (id: string, url: string, ...events: string[][]) => ({
  calendar: { id, name: id, url, color: '#000', enabled: true } as LinkedCalendar,
  events: parseIcs(['BEGIN:VCALENDAR', ...events.flat(), 'END:VCALENDAR'].join('\r\n'))
});

const GOOGLE_URL = 'https://calendar.google.com/calendar/ical/me%40healthfab.in/private-abc/basic.ics';
const ZOHO_URL = 'https://calendar.zoho.in/ical/zz';
const from = utc(5, 0);
const to = utc(12, 0);

describe('clash radar', () => {
  it('finds a Zoho call on top of a Google standup', () => {
    const linked = [
      calendar('g', GOOGLE_URL, ev('a', 'Standup', utc(6, 9), utc(6, 9, 30))),
      calendar('z', ZOHO_URL, ev('b', 'Client call', utc(6, 9, 15), utc(6, 10)))
    ];
    const clashes = findClashes(busyBlocks(linked, from, to), 1);
    expect(clashes.length).toBe(1);
    expect([clashes[0].a.title, clashes[0].b.title]).toEqual(['Standup', 'Client call']);
    expect(clashes[0].overlapEnd - clashes[0].overlapStart).toBe(15 * 60_000);
  });

  it('back-to-back meetings do not clash, and the minimum overlap is respected', () => {
    const linked = [calendar('g', GOOGLE_URL, ev('a', 'A', utc(6, 9), utc(6, 10)), ev('b', 'B', utc(6, 10), utc(6, 11)), ev('c', 'C', utc(6, 10, 55), utc(6, 12)))];
    const blocks = busyBlocks(linked, from, to);
    expect(findClashes(blocks, 1).map((c) => c.b.title)).toEqual(['C']);
    expect(findClashes(blocks, 10)).toEqual([]);
  });

  it('the same invite in two calendars is one meeting, not a clash', () => {
    const linked = [
      calendar('g', GOOGLE_URL, ev('inv-1', 'Review', utc(6, 9), utc(6, 10))),
      calendar('z', ZOHO_URL, ev('inv-1', 'Review', utc(6, 9), utc(6, 10)), ev('zz', 'review ', utc(7, 9), utc(7, 10))),
      calendar('o', 'https://outlook.office365.com/x.ics', ev('other-uid', 'Review!', utc(7, 9), utc(7, 10)))
    ];
    const blocks = busyBlocks(linked, from, to);
    expect(blocks.length).toBe(2);
    expect(blocks[0].alsoIn).toEqual(['Zoho · z']);
    expect(findClashes(blocks, 1)).toEqual([]);
  });

  it('ignores free, declined, all-day and zero-length events', () => {
    const linked = [
      calendar('g', GOOGLE_URL,
        ev('a', 'Focus', utc(6, 9), utc(6, 12)),
        ev('b', 'Lunch', utc(6, 9), utc(6, 10), 'TRANSP:TRANSPARENT'),
        ev('c', 'Declined', utc(6, 9), utc(6, 10), 'ATTENDEE;PARTSTAT=DECLINED:mailto:me@healthfab.in'),
        ['BEGIN:VEVENT', 'UID:d', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261006', 'END:VEVENT'],
        ['BEGIN:VEVENT', 'UID:e', 'SUMMARY:Ping', `DTSTART:${stamp(utc(6, 10))}`, 'END:VEVENT']
      )
    ];
    expect(busyBlocks(linked, from, to).map((b) => b.title)).toEqual(['Focus']);
  });

  it('a moved instance of a series clashes at its new time, not the old one', () => {
    const series = ['BEGIN:VEVENT', 'UID:s', 'SUMMARY:Standup', `DTSTART:${stamp(utc(5, 9))}`, `DTEND:${stamp(utc(5, 9, 30))}`, 'RRULE:FREQ=DAILY;COUNT=5', 'END:VEVENT'];
    const moved = ['BEGIN:VEVENT', 'UID:s', `RECURRENCE-ID:${stamp(utc(6, 9))}`, 'SUMMARY:Standup', `DTSTART:${stamp(utc(6, 15))}`, `DTEND:${stamp(utc(6, 15, 30))}`, 'END:VEVENT'];
    const linked = [calendar('g', GOOGLE_URL, series, moved), calendar('z', ZOHO_URL, ev('x', 'Call at 9', utc(6, 9), utc(6, 10)), ev('y', 'Call at 3', utc(6, 15), utc(6, 16)))];
    const clashes = findClashes(busyBlocks(linked, from, to), 1);
    expect(clashes.map((c) => `${c.a.title}+${c.b.title}@${new Date(c.overlapStart).getUTCHours()}`)).toEqual(['Standup+Call at 3@15']);
  });

  it('ignored clashes stay hidden; past ones drop off', () => {
    const linked = [calendar('g', GOOGLE_URL, ev('a', 'A', utc(6, 9), utc(6, 10)), ev('b', 'B', utc(6, 9), utc(6, 10)), ev('c', 'C', utc(8, 9), utc(8, 10)), ev('d', 'D', utc(8, 9), utc(8, 10)))];
    const all = upcomingClashes(linked, 1, [], from, 7);
    expect(all.length).toBe(2);
    expect(upcomingClashes(linked, 1, [all[0].id], from, 7).length).toBe(1);
    expect(upcomingClashes(linked, 1, [], utc(7, 0), 7).length).toBe(1);
  });

  it('reads the owner from a Google secret address only', () => {
    expect(calendarOwnerEmail(GOOGLE_URL)).toBe('me@healthfab.in');
    expect(calendarOwnerEmail(ZOHO_URL)).toBeNull();
  });
});
