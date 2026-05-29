import { vibrateTap } from './lib/haptics';
import { formatReminderLabel } from './reminder-label';
import type { Priority, Task } from './types';

function clearReminder(t: Task, history: string): Task {
  return {
    ...t,
    reminderTime: null,
    reminderDateOnly: false,
    reminderIntervalMinutes: 0,
    reminderEndDate: 0,
    reminderHistoryLabel: history
  };
}

export function sortTasks(list: Task[]): Task[] {
  return [...list].sort(
    (a, b) =>
      Number(b.isPinned) - Number(a.isPinned) ||
      Number(a.isCompleted) - Number(b.isCompleted) ||
      Number(a.isWontDo) - Number(b.isWontDo) ||
      a.position - b.position
  );
}

export function tasksForPriority(tasks: Task[], p: Priority): Task[] {
  return sortTasks(tasks.filter((t) => t.priority === p && t.deletedAt === 0));
}

export function newTask(description: string, priority: Priority): Omit<Task, 'id'> {
  const now = Date.now();
  return {
    taskUuid: crypto.randomUUID(),
    description,
    priority,
    position: 0,
    isCompleted: false,
    isWontDo: false,
    isPinned: false,
    reminderTime: null,
    reminderDateOnly: false,
    reminderIntervalMinutes: 0,
    reminderEndDate: 0,
    reminderHistoryLabel: '',
    notes: '',
    createdAt: now,
    updatedAt: now,
    deletedAt: 0,
    completedAt: 0,
    skippedAt: 0
  };
}

export function markCompleted(t: Task): Task {
  const now = Date.now();
  const hist =
    formatReminderLabel(
      t.reminderTime,
      t.reminderDateOnly,
      t.reminderIntervalMinutes,
      t.reminderEndDate
    ) ?? '';
  let next: Task = {
    ...t,
    isCompleted: true,
    isWontDo: false,
    completedAt: now,
    skippedAt: 0,
    updatedAt: now
  };
  if (t.reminderTime != null) next = clearReminder(next, hist);
  return next;
}

export function markWontDo(t: Task): Task {
  const now = Date.now();
  const hist =
    formatReminderLabel(
      t.reminderTime,
      t.reminderDateOnly,
      t.reminderIntervalMinutes,
      t.reminderEndDate
    ) ?? '';
  let next: Task = {
    ...t,
    isWontDo: true,
    isCompleted: false,
    skippedAt: now,
    completedAt: 0,
    updatedAt: now
  };
  if (t.reminderTime != null) next = clearReminder(next, hist);
  return next;
}

export function reorderIncomplete(
  tasks: Task[],
  priority: Priority,
  from: number,
  to: number
): Task[] {
  const all = sortTasks(tasks.filter((t) => t.priority === priority));
  const incomplete = all.filter((t) => !t.isCompleted && !t.isWontDo);
  if (
    from < 0 ||
    to < 0 ||
    from >= incomplete.length ||
    to >= incomplete.length
  )
    return tasks;
  const moved = incomplete.splice(from, 1)[0];
  incomplete.splice(to, 0, moved);
  const updates = new Map<number, Task>();
  incomplete.forEach((task, i) => {
    updates.set(task.id, { ...task, position: i, updatedAt: Date.now() });
  });
  return tasks.map((t) => updates.get(t.id) ?? t);
}

export function hapticPulse(el?: HTMLElement): void {
  vibrateTap();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const target = el ?? document.body;
  target.classList.add('nx-haptic');
  setTimeout(() => target.classList.remove('nx-haptic'), 180);
}
