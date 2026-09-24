import { describe, expect, it } from 'vitest';
import type { LinkedCalendar } from '../settings/store';
import { parseIcs } from './ics';
import { meetingLabel, meetingRef, upcomingMeetings } from './meetings';

const cal = (p: Partial<LinkedCalendar> = {}): LinkedCalendar => ({ id: 'c1', name: 'Work', url: 'https://calendar.google.com/x.ics', color: '#fff', enabled: true, ...p });
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const ev = (uid: string, start: number, extra = '') =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${stamp(start)}\r\nSUMMARY:${uid}\r\n${extra}END:VEVENT\r\n`;
const ics = (...evs: string[]) => parseIcs(`BEGIN:VCALENDAR\r\n${evs.join('')}END:VCALENDAR\r\n`);

const NOW = Date.UTC(2026, 9, 5, 8, 0);
const MIN = 60_000;

describe('meeting heads-ups', () => {
  it('rings [lead] minutes before timed events, with the Join link and source', () => {
    const events = ics(ev('standup', NOW + 30 * MIN, 'DESCRIPTION:https://meet.google.com/abc-defg-hij\r\n'));
    const [m] = upcomingMeetings([{ calendar: cal(), events }], 10, NOW);
    expect(m.fireAt).toBe(NOW + 20 * MIN);
    expect(m.info).toMatchObject({ title: 'standup', url: 'https://meet.google.com/abc-defg-hij', source: 'Google · Work', at: NOW + 30 * MIN });
    expect(m.ref).toMatch(/^meet:[a-z0-9]+$/);
    expect(m.ref.length).toBeLessThan(40);
  });
  it('skips past heads-ups, all-day events, hidden calendars and anything past the horizon', () => {
    const events = ics(
      ev('soon', NOW + 5 * MIN),
      ev('later', NOW + 3 * 86_400_000),
      'BEGIN:VEVENT\r\nUID:allday\r\nDTSTART;VALUE=DATE:20261005\r\nSUMMARY:holiday\r\nEND:VEVENT\r\n'
    );
    expect(upcomingMeetings([{ calendar: cal(), events }], 10, NOW)).toEqual([]);
    expect(upcomingMeetings([{ calendar: cal({ enabled: false }), events: ics(ev('x', NOW + 60 * MIN)) }], 10, NOW)).toEqual([]);
  });
  it('respects a pause: nothing before it ends', () => {
    const events = ics(ev('a', NOW + 30 * MIN), ev('b', NOW + 120 * MIN));
    const got = upcomingMeetings([{ calendar: cal(), events }], 0, NOW, NOW + 60 * MIN);
    expect(got.map((m) => m.info.title)).toEqual(['b']);
  });
  it('gives each occurrence its own stable id', () => {
    expect(meetingRef('c1', 'u', 1)).toBe(meetingRef('c1', 'u', 1));
    expect(meetingRef('c1', 'u', 1)).not.toBe(meetingRef('c1', 'u', 2));
    expect(meetingRef('c1', 'u', 1)).not.toBe(meetingRef('c2', 'u', 1));
  });
  it('labels the time left', () => {
    expect(meetingLabel({ title: 't', at: NOW + 10 * MIN, source: 's' }, NOW)).toMatch(/^In 10 min · /);
    expect(meetingLabel({ title: 't', at: NOW, source: 's' }, NOW)).toMatch(/^Starting now · /);
  });
});
