import { signal } from '@preact/signals';
import { haptic } from '../lib/haptics';
import { clampFocus, type Dir, type Focus, moveFocus } from '../lib/keynav';
import * as nav from '../state/nav';
import { byPriority, deleteTasks, importedByPriority, moveToPriority, restoreTasks, setChecked, togglePin } from '../state/store';
import { offerUndo } from '../state/toasts';
import { PRIORITIES, type Priority, type Task } from '../types';
import { tour } from './tour-state';

/**
 * Keyboard focus on the matrix: ↑↓ / J K walk a quadrant's rows, ←→ / H L jump between
 * quadrants, and the highlighted row takes Enter / E (open), Space / X (done), P (pin),
 * Backspace (delete, with Undo) and ⌥1–4 (move). Rendered by Matrix.tsx as `.focused`.
 */
export const matrixFocus = signal<Focus | null>(null);

type Row = { kind: 'task'; task: Task } | { kind: 'folder' };

/** Rows per quadrant: its tasks, plus the Imported folder row when there is one. */
function rowCounts(): Record<Priority, number> {
  const m = {} as Record<Priority, number>;
  for (const p of PRIORITIES) m[p] = byPriority.value[p].length + (importedByPriority.value[p].length ? 1 : 0);
  return m;
}

function rowAt(f: Focus): Row | null {
  const tasks = byPriority.value[f.priority];
  if (f.index < tasks.length) return { kind: 'task', task: tasks[f.index] };
  if (f.index === tasks.length && importedByPriority.value[f.priority].length) return { kind: 'folder' };
  return null;
}

const DIRS: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  k: 'up', K: 'up', j: 'down', J: 'down', h: 'left', H: 'left', l: 'right', L: 'right'
};

function openRow(f: Focus, row: Row): void {
  if (row.kind === 'folder') {
    if (!tour.allows('EXPAND', f.priority)) return;
    nav.open({ kind: 'full', priority: f.priority, folder: true });
  } else {
    if (!tour.allows('OPEN')) return;
    nav.open({ kind: 'detail', taskId: row.task.id });
  }
}

/** Handles one matrix key press (no modifiers). Returns true when it was one of ours. */
export function handleMatrixKey(e: KeyboardEvent): boolean {
  const dir = DIRS[e.key];
  if (dir) {
    e.preventDefault();
    matrixFocus.value = moveFocus(matrixFocus.value, dir, rowCounts());
    return true;
  }
  const f = clampFocus(matrixFocus.value, rowCounts());
  if (!f) return false;
  const row = rowAt(f);
  if (!row) return false;
  switch (e.key) {
    case 'Escape':
      matrixFocus.value = null;
      return true;
    case 'Enter':
    case 'e':
    case 'E':
      e.preventDefault();
      openRow(f, row);
      return true;
  }
  if (row.kind !== 'task') return false;
  const t = row.task;
  switch (e.key) {
    case ' ':
    case 'x':
    case 'X':
      e.preventDefault();
      void setChecked(t, !t.isCompleted);
      return true;
    case 'p':
    case 'P':
      void togglePin(t);
      return true;
    case 'Backspace':
    case 'Delete': {
      e.preventDefault();
      haptic('DELETE');
      const ids = [t.id];
      void deleteTasks(ids);
      offerUndo('Task deleted', () => void restoreTasks(ids));
      return true;
    }
  }
  return false;
}

/** ⌥1–4: move the highlighted task and follow it. */
export function moveFocusedTo(p: Priority): boolean {
  const f = clampFocus(matrixFocus.value, rowCounts());
  const row = f && rowAt(f);
  if (!row || row.kind !== 'task' || row.task.priority === p) return false;
  haptic('DRAG_DROP');
  void moveToPriority(row.task, p);
  // The store applies the move at once, so the task already sits in its new quadrant.
  matrixFocus.value = { priority: p, index: Math.max(0, byPriority.value[p].findIndex((t) => t.id === row.task.id)) };
  return true;
}
