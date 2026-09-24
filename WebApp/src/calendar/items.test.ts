import { describe, expect, it } from 'vitest';
import { newTask } from '../task-utils';
import type { Task } from '../types';
import { parseIcs } from './ics';
import { buildCalendar, monthGrid } from './items';

const task = (p: Partial<Task>): Task => ({ ...newTask('T', 'HIGH'), id: Math.random(), ...p });
const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();

describe('calendar items', () => {
  it('places deadlines, exact reminders and reminder ranges on their days', () => {
    const tasks = [
      task({ description: 'due', dueDate: '2026-10-05' }),
      task({ description: 'exact', reminderTime: at(2026, 10, 5, 15) }),
      task({ description: 'range', reminderTime: at(2026, 10, 4, 9), reminderDateOnly: true, reminderEndDate: at(2026, 10, 6, 9) }),
      task({ description: 'deleted', dueDate: '2026-10-05', deletedAt: 1 })
    ];
    const m = buildCalendar(tasks, [], '2026-10-01', '2026-10-31', at(2026, 10, 1));
    expect(m.get('2026-10-05')!.map((i) => (i.type === 'event' ? i.event.summary : i.task.description))).toEqual(['due', 'range', 'exact']);
    expect(m.get('2026-10-04')!.length).toBe(1);
    expect(m.get('2026-10-06')!.length).toBe(1);
    expect(m.get('2026-10-07')).toBeUndefined();
  });

  it('expands recurring linked-calendar events inside the range', () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:w1', 'SUMMARY:Standup', 'DTSTART;VALUE=DATE:20261005', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const cal = { id: 'c', name: 'Work', url: 'https://calendar.google.com/x.ics', color: '#3B9EFF', enabled: true };
    const m = buildCalendar([], [{ calendar: cal, events: parseIcs(ics) }], '2026-10-01', '2026-10-31');
    expect([...m.keys()].sort()).toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
    const off = buildCalendar([], [{ calendar: { ...cal, enabled: false }, events: parseIcs(ics) }], '2026-10-01', '2026-10-31');
    expect(off.size).toBe(0);
  });

  it('builds a 6-week grid starting on the chosen weekday', () => {
    const mon = monthGrid(2026, 9, 1); // October 2026 starts on a Thursday
    expect(mon[0]).toBe('2026-09-28');
    expect(mon.length).toBe(42);
    expect(monthGrid(2026, 9, 0)[0]).toBe('2026-09-27');
  });
});
