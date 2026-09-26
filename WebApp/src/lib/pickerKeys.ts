import type { Priority } from '../types';
import { PRIORITIES } from '../types';

/**
 * Keyboard rules of the 2×2 priority picker (the keyboard quick add on the matrix and the
 * widget's composer share them). Pure: a key plus the current highlight gives an action.
 *
 *   ┌───────┬────────┐   arrows move within the grid (no wrap), Tab / ⇧Tab cycle,
 *   │ High  │ Medium │   1–4 pick a cell directly, ⏎ / space confirm the highlight,
 *   ├───────┼────────┤   any other printable key confirms the highlight and keeps the
 *   │ Low   │ None   │   keystroke as the first letter of the title.
 *   └───────┴────────┘
 */

export type PickerKey = Pick<KeyboardEvent, 'key'> & Partial<Pick<KeyboardEvent, 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'repeat' | 'isComposing'>>;

export type PickerAction =
  /** Highlight moved (or stayed, at an edge). The key was consumed either way. */
  | { type: 'move'; priority: Priority }
  /** A cell was confirmed; [text] is the keystroke to start the title with. */
  | { type: 'choose'; priority: Priority; text: string };

const ARROWS: Record<string, (i: number) => number> = {
  ArrowLeft: (i) => (i % 2 ? i - 1 : i),
  ArrowRight: (i) => (i % 2 ? i : i + 1),
  ArrowUp: (i) => (i > 1 ? i - 2 : i),
  ArrowDown: (i) => (i > 1 ? i : i + 2)
};

/** What a key does with [sel] highlighted; null when the picker leaves the key alone. */
export function pickerKey(e: PickerKey, sel: Priority): PickerAction | null {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return null;
  const i = PRIORITIES.indexOf(sel);
  if (e.key in ARROWS) return { type: 'move', priority: PRIORITIES[ARROWS[e.key](i)] };
  if (e.key === 'Tab') return { type: 'move', priority: PRIORITIES[(i + (e.shiftKey ? 3 : 1)) % 4] };
  if (e.key === 'Enter' || e.key === ' ') return { type: 'choose', priority: sel, text: '' };
  if (/^[1-4]$/.test(e.key)) return { type: 'choose', priority: PRIORITIES[Number(e.key) - 1], text: '' };
  if (e.key.length === 1 && !e.isComposing) return { type: 'choose', priority: sel, text: e.key };
  return null;
}
