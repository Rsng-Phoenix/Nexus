import type { Priority } from '../types';

/**
 * Keyboard focus on the matrix (pure part; the key handling is in view/keynav.ts).
 * A focus is a quadrant plus an index into its visible rows: the tasks, then the Imported
 * folder row when the quadrant has one. The 2×2 layout is High | Medium over Low | None.
 */
export type Focus = { priority: Priority; index: number };
export type Dir = 'up' | 'down' | 'left' | 'right';

const GRID: Priority[][] = [
  ['HIGH', 'MEDIUM'],
  ['LOW', 'NONE']
];

/** The quadrant next to [p] in [dir] (null at the edge). */
export function neighbour(p: Priority, dir: Dir): Priority | null {
  const r = GRID.findIndex((row) => row.includes(p));
  const c = GRID[r].indexOf(p);
  const [dr, dc] = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] }[dir];
  return GRID[r + dr]?.[c + dc] ?? null;
}

/** Keeps a focus inside the rows that exist now (null when its quadrant is empty). */
export function clampFocus(f: Focus | null, counts: Record<Priority, number>): Focus | null {
  if (!f) return null;
  const n = counts[f.priority];
  if (n <= 0) return null;
  return { priority: f.priority, index: Math.min(Math.max(0, f.index), n - 1) };
}

/**
 * Where an arrow / hjkl press moves the focus. Up and down walk the rows and continue into the
 * quadrant above / below; left and right jump sideways keeping the row when they can. With no
 * focus yet, any key lands on the first row of the first quadrant that has one.
 */
export function moveFocus(cur: Focus | null, dir: Dir, counts: Record<Priority, number>): Focus | null {
  const f = clampFocus(cur, counts);
  if (!f) {
    const first = (['HIGH', 'MEDIUM', 'LOW', 'NONE'] as Priority[]).find((p) => counts[p] > 0);
    return first ? { priority: first, index: 0 } : null;
  }
  const n = counts[f.priority];
  if (dir === 'down' || dir === 'up') {
    const next = f.index + (dir === 'down' ? 1 : -1);
    if (next >= 0 && next < n) return { priority: f.priority, index: next };
    const q = neighbour(f.priority, dir);
    if (!q || counts[q] <= 0) return f;
    return { priority: q, index: dir === 'down' ? 0 : counts[q] - 1 };
  }
  const q = neighbour(f.priority, dir);
  if (!q || counts[q] <= 0) return f;
  return { priority: q, index: Math.min(f.index, counts[q] - 1) };
}
