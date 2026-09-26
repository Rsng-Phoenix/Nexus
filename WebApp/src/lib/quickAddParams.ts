import type { Priority } from '../types';

/**
 * Pure helpers of the Quick Add page (view/QuickAddWindow.tsx): what the address pre-fills,
 * where the panel flies in from, and how tall it may grow. Kept here so they can be tested.
 */

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';

export type QuickAddParams = {
  /** First line → title; the rest → notes (Services "Add to Nexus" sends whole paragraphs). */
  text: string;
  notes: string;
  priority: Priority | null;
  from: Corner;
};

const PRIORITY_NAMES: Record<string, Priority> = {
  '1': 'HIGH', high: 'HIGH', h: 'HIGH',
  '2': 'MEDIUM', medium: 'MEDIUM', med: 'MEDIUM', m: 'MEDIUM',
  '3': 'LOW', low: 'LOW', l: 'LOW',
  '4': 'NONE', none: 'NONE', n: 'NONE'
};

/** `?priority=high|2|HIGH…` → a priority, or null when absent or unknown. */
export function parsePriorityParam(v: string | null | undefined): Priority | null {
  if (!v) return null;
  return PRIORITY_NAMES[v.trim().toLowerCase()] ?? null;
}

/** `?from=` names the corner the panel appears from (the Desk's hot corner); anything else is the centre. */
export function parseCorner(v: string | null | undefined): Corner {
  const s = (v ?? '').trim().toLowerCase().replace(/[_ ]/g, '-');
  return s === 'top-left' || s === 'top-right' || s === 'bottom-left' || s === 'bottom-right' ? s : 'center';
}

/** The entrance vector (fractions of the card's own size) for a corner: where it flies in from. */
export function cornerVector(c: Corner): { fx: number; fy: number } {
  switch (c) {
    case 'top-left': return { fx: -0.06, fy: -0.1 };
    case 'top-right': return { fx: 0.06, fy: -0.1 };
    case 'bottom-left': return { fx: -0.06, fy: 0.1 };
    case 'bottom-right': return { fx: 0.06, fy: 0.1 };
    default: return { fx: 0, fy: -0.06 };
  }
}

export function parseQuickAddParams(search: string | URLSearchParams): QuickAddParams {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const raw = (q.get('text') ?? '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const text = (lines.shift() ?? '').trim();
  const notes = lines.join('\n').trim();
  return { text, notes, priority: parsePriorityParam(q.get('priority')), from: parseCorner(q.get('from')) };
}

/** Panel height the Desk is asked for: the card plus its margins, never below the one-line minimum nor above the screen's share. */
export function clampPanelHeight(cardHeight: number, o: { min: number; max: number; margin: number }): number {
  const h = Math.ceil(cardHeight + o.margin * 2);
  return Math.max(o.min, Math.min(o.max, h));
}

/**
 * Clipboard ghost hint (§2.6): a short single line that isn't already a task title is offered as
 * "⌘V to use: …", never inserted. Returns the trimmed line or null.
 */
export function clipboardHint(clip: string | null | undefined, existingTitles: Iterable<string>, maxLen: number): string | null {
  if (!clip) return null;
  const s = clip.trim();
  if (!s || s.length >= maxLen || /[\r\n]/.test(s)) return null;
  const low = s.toLowerCase();
  for (const t of existingTitles) if (t.trim().toLowerCase() === low) return null;
  return s;
}
