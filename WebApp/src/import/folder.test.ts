import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import { folderGroups, folderSummary, isImported, onMatrix } from './folder';

const task = (over: Partial<Task>): Task =>
  ({
    id: 1,
    taskUuid: 'xl-abc',
    description: 'Appointment',
    priority: 'HIGH',
    isCompleted: false,
    isWontDo: false,
    isPinned: false,
    dueDate: '',
    completedAt: 0,
    skippedAt: 0,
    ...over
  }) as Task;

const TODAY = '2026-09-25';
const TOMORROW = '2026-09-26';

describe('Imported folder', () => {
  it('knows imported tasks by their uuid', () => {
    expect(isImported(task({ taskUuid: 'xl-1' }))).toBe(true);
    expect(isImported(task({ taskUuid: 'ics-1' }))).toBe(true);
    expect(isImported(task({ taskUuid: '6f1c…' }))).toBe(false);
  });

  it('keeps typed tasks and today’s imports on the matrix, everything else in the folder', () => {
    expect(onMatrix(task({ taskUuid: 'typed', dueDate: '2026-10-01' }), TODAY)).toBe(true);
    expect(onMatrix(task({ dueDate: TODAY }), TODAY)).toBe(true);
    expect(onMatrix(task({ dueDate: TODAY, isCompleted: true }), TODAY)).toBe(true);
    expect(onMatrix(task({ dueDate: TOMORROW }), TODAY)).toBe(false);
    expect(onMatrix(task({ dueDate: '2026-09-20' }), TODAY)).toBe(false);
    expect(onMatrix(task({ dueDate: '' }), TODAY)).toBe(false);
  });

  it('a pinned import stays out until it is done', () => {
    expect(onMatrix(task({ dueDate: TOMORROW, isPinned: true }), TODAY)).toBe(true);
    expect(onMatrix(task({ dueDate: TOMORROW, isPinned: true, isCompleted: true }), TODAY)).toBe(false);
  });

  it('groups: tomorrow, later days, no date, then missed and done', () => {
    const groups = folderGroups(
      [
        task({ id: 1, dueDate: '2026-10-05', description: 'B' }),
        task({ id: 2, dueDate: TOMORROW }),
        task({ id: 3, dueDate: '2026-10-05', description: 'A' }),
        task({ id: 4, dueDate: '2026-09-20' }),
        task({ id: 5, dueDate: '' }),
        task({ id: 6, dueDate: '2026-09-21', isCompleted: true, completedAt: 5 })
      ],
      TODAY,
      TOMORROW
    );
    expect(groups.map((g) => g.label)).toEqual(['Tomorrow · Sat 26 Sep 2026', 'Mon 5 Oct 2026', 'No date', 'Missed', 'Done']);
    expect(groups[1].tasks.map((t) => t.description)).toEqual(['A', 'B']);
    expect(groups[3].tone).toBe('late');
  });

  it('summarises the folder row', () => {
    const tasks = [task({ dueDate: TOMORROW }), task({ dueDate: '2026-09-01' }), task({ dueDate: '', isCompleted: true })];
    expect(folderSummary(tasks, TODAY)).toEqual({ open: 2, missed: 1, text: '1 upcoming' });
    expect(folderSummary([task({ dueDate: '2026-09-01' })], TODAY).text).toBe('1 missed');
    expect(folderSummary([task({ isCompleted: true })], TODAY).text).toBe('all done');
  });
});
