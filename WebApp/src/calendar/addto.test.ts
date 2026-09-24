import { describe, expect, it } from 'vitest';
import { newTask } from '../task-utils';
import type { Task } from '../types';
import { calendarSlot, googleCalendarUrl, outlookCalendarUrl } from './addto';

const task = (p: Partial<Task>): Task => ({ ...newTask('Pay rent', 'HIGH'), id: 1, ...p });

describe('add to calendar links', () => {
  it('turns a deadline into an all-day event ending the next day', () => {
    const slot = calendarSlot(task({ dueDate: '2026-12-31' }))!;
    expect(slot).toEqual({ allDay: true, date: '2026-12-31' });
    const u = new URL(googleCalendarUrl('Pay rent', 'notes', slot));
    expect(u.searchParams.get('dates')).toBe('20261231/20270101');
    expect(u.searchParams.get('text')).toBe('Pay rent');
    expect(new URL(outlookCalendarUrl('Pay rent', '', slot)).searchParams.get('allday')).toBe('true');
  });
  it('uses a one-off reminder time when there is no deadline', () => {
    const at = Date.UTC(2026, 9, 5, 9, 30);
    const slot = calendarSlot(task({ reminderTime: at }))!;
    expect(new URL(googleCalendarUrl('x', '', slot)).searchParams.get('dates')).toBe('20261005T093000Z/20261005T100000Z');
  });
  it('has nothing to add for tasks without a date or with repeating reminders', () => {
    expect(calendarSlot(task({}))).toBeNull();
    expect(calendarSlot(task({ reminderTime: 1, reminderDateOnly: true }))).toBeNull();
  });
});
