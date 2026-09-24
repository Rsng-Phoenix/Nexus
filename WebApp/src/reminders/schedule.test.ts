import { describe, expect, it } from 'vitest';
import { newTask } from '../task-utils';
import type { Task } from '../types';
import { nextReminderFire, upcomingFires } from './schedule';

// Same cases as Android ReminderScheduleTest.kt.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const W = { startHour: 8, endHour: 22 };
const task = (time: number, o: Partial<Task> = {}): Task =>
  ({ ...newTask('t', 'HIGH'), id: 1, reminderTime: time, ...o }) as Task;

describe('nextReminderFire', () => {
  it('exact reminder in the future fires at its time', () => {
    expect(nextReminderFire(task(at(5, 15)), at(5, 9), W)).toBe(at(5, 15));
  });
  it('recently missed exact reminder fires now', () => {
    const now = at(5, 16);
    expect(nextReminderFire(task(at(5, 15)), now, W)).toBe(now + 1000);
  });
  it('long-past exact reminder is dropped', () => {
    expect(nextReminderFire(task(at(5, 15)), at(7, 9), W)).toBeNull();
  });
  it('all day repeats on interval inside the window', () => {
    const t = task(at(5, 8), { reminderDateOnly: true, reminderIntervalMinutes: 120 });
    expect(nextReminderFire(t, at(5, 7), W)).toBe(at(5, 8));
    expect(nextReminderFire(t, at(5, 8), W)).toBe(at(5, 10));
    expect(nextReminderFire(t, at(5, 13, 5), W)).toBe(at(5, 14));
    expect(nextReminderFire(t, at(5, 21), W)).toBe(at(5, 22));
    expect(nextReminderFire(t, at(5, 22), W)).toBeNull();
  });
  it('date range rolls to the next morning and ends', () => {
    const t = task(at(5, 8), { reminderDateOnly: true, reminderIntervalMinutes: 60, reminderEndDate: at(7, 0) });
    expect(nextReminderFire(t, at(5, 22, 30), W)).toBe(at(6, 8));
    expect(nextReminderFire(t, at(7, 22, 1), W)).toBeNull();
  });
  it('respects a user-chosen window', () => {
    const t = task(at(5, 6), { reminderDateOnly: true, reminderIntervalMinutes: 180 });
    expect(nextReminderFire(t, at(5, 9), { startHour: 6, endHour: 12 })).toBe(at(5, 12));
  });
});

describe('upcomingFires', () => {
  it('an exact reminder rings exactly once', () => {
    expect(upcomingFires(task(at(5, 15)), at(5, 9), 7 * 24 * 3600_000, W)).toEqual([at(5, 15)]);
    const missed = upcomingFires(task(at(5, 15)), at(5, 16), 7 * 24 * 3600_000, W);
    expect(missed.length).toBe(1);
  });
  it('lists every ring inside the horizon', () => {
    const t = task(at(5, 8), { reminderDateOnly: true, reminderIntervalMinutes: 240 });
    expect(upcomingFires(t, at(5, 7), 24 * 3600_000, W)).toEqual([at(5, 8), at(5, 12), at(5, 16), at(5, 20)]);
  });
});
