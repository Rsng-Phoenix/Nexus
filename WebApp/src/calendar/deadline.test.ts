import { describe, expect, it } from 'vitest';
import { newTask } from '../task-utils';
import type { Task } from '../types';
import { addDaysIso, alertAt, daysBetween, dueAlertText, dueChipLabel, isOverdue, upcomingDueFires } from './deadline';

const task = (p: Partial<Task>): Task => ({ ...newTask('Pay GST', 'HIGH'), id: 1, ...p });
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe('deadlines', () => {
  it('alerts ring at the alert time on due day + offset', () => {
    expect(alertAt('2026-10-05', -1, 540)).toBe(at(2026, 10, 4, 9));
    expect(alertAt('2026-10-05', 0, 1050)).toBe(at(2026, 10, 5, 17, 30));
    expect(alertAt('2026-03-01', -1, 540)).toBe(at(2026, 2, 28, 9));
  });

  it('lists upcoming fires only for open tasks, inside the horizon', () => {
    const t = task({ dueDate: '2026-10-05', dueAlerts: '-2,-1,0,1', dueAlertTime: 540 });
    const from = at(2026, 10, 3, 12);
    expect(upcomingDueFires(t, from, 7 * 86_400_000).map((f) => f.offset)).toEqual([-1, 0, 1]);
    expect(upcomingDueFires({ ...t, isCompleted: true }, from, 7 * 86_400_000)).toEqual([]);
    expect(upcomingDueFires({ ...t, dueAlerts: '' }, from, 7 * 86_400_000)).toEqual([]);
    expect(upcomingDueFires({ ...t, dueDate: 'garbage' }, from, 7 * 86_400_000)).toEqual([]);
  });

  it('words alerts like Android', () => {
    expect(dueAlertText('2026-10-05', -3)).toBe('Due in 3 days · Mon 5 Oct');
    expect(dueAlertText('2026-10-05', -1)).toBe('Due tomorrow');
    expect(dueAlertText('2026-10-05', 0)).toBe('Due today');
    expect(dueAlertText('2026-10-05', 1)).toBe('Overdue by 1 day');
    expect(dueAlertText('2026-10-05', 2)).toBe('Overdue by 2 days');
  });

  it('chip labels and overdue', () => {
    const now = at(2026, 10, 3, 10);
    expect(dueChipLabel(task({ dueDate: '2026-10-03' }), now)).toBe('Due today');
    expect(dueChipLabel(task({ dueDate: '2026-10-04' }), now)).toBe('Due tomorrow');
    expect(dueChipLabel(task({ dueDate: '2026-10-09' }), now)).toBe('Due Fri 9 Oct');
    expect(dueChipLabel(task({ dueDate: '2027-01-09' }), now)).toBe('Due Sat 9 Jan 2027');
    expect(dueChipLabel(task({ dueDate: '2026-10-01' }), now)).toBe('Overdue · 2 days');
    expect(isOverdue(task({ dueDate: '2026-10-01' }), now)).toBe(true);
    expect(isOverdue(task({ dueDate: '2026-10-01', isCompleted: true }), now)).toBe(false);
  });

  it('day arithmetic across month and DST boundaries', () => {
    expect(addDaysIso('2026-10-31', 1)).toBe('2026-11-01');
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-11-02', '2026-10-31')).toBe(-2);
  });
});
