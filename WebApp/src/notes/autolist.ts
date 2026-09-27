import type { BlockType, NoteBlock } from './codec';
import { shiftSpans, sliceSpans } from './span-utils';

/**
 * List auto-detection for the notes editor. Pure functions, mirrored 1:1 in Android's
 * NotesAutoList.kt (same regexes, same cases in the unit tests).
 */

export type ListType = 'NUMBERED' | 'BULLET' | 'CHECKBOX';

export interface ListPrefix {
  type: ListType;
  /** Only for CHECKBOX. */
  checked?: boolean;
  /** The line without its prefix (and without the single space after it). */
  rest: string;
}

// `[ ] `, `[x] `, `[] `, `- [ ] `, `* [x] `
const CHECKBOX_RE = /^\s*(?:[-*+•]\s)?\[( |x|X)?\]\s/;
// `1. `, `12) `
const NUMBERED_RE = /^\s*\d+[.)]\s/;
// `- `, `* `, `+ `, `• `
const BULLET_RE = /^\s*[-*+•]\s/;

/** The list prefix a line starts with, or null when it is plain text. */
export function detectPrefix(line: string): ListPrefix | null {
  const cb = CHECKBOX_RE.exec(line);
  if (cb) return { type: 'CHECKBOX', checked: (cb[1] ?? '').toLowerCase() === 'x', rest: line.slice(cb[0].length) };
  const num = NUMBERED_RE.exec(line);
  if (num) return { type: 'NUMBERED', rest: line.slice(num[0].length) };
  const bul = BULLET_RE.exec(line);
  if (bul) return { type: 'BULLET', rest: line.slice(bul[0].length) };
  return null;
}

/** Pasted text is a list when it has ≥ 2 non-blank lines and ≥ 60 % of them carry a prefix. */
export function looksLikeList(lines: string[]): boolean {
  const filled = lines.filter((l) => l.trim().length > 0);
  if (filled.length < 2) return false;
  const prefixed = filled.filter((l) => detectPrefix(l) !== null).length;
  return prefixed / filled.length >= 0.6;
}

function newId(): string {
  return crypto.randomUUID();
}

/** A block in the style of [like] (indent, bold, underline, scale). */
function styled(like: NoteBlock, type: BlockType, text: string, checked = false): NoteBlock {
  return {
    id: newId(),
    type,
    text,
    checked,
    indent: like.indent,
    bold: like.bold,
    underline: like.underline,
    localScale: like.localScale,
    spans: [],
    sortKey: -1
  };
}

/**
 * Turns line [lineIndex] of a multi-line TEXT block into a list item of [newType]: text before it
 * stays TEXT (keeping the block's id), the item follows, text after it becomes a new TEXT block.
 * Empty parts are dropped; when nothing precedes the item, the item keeps the original id.
 * The item is the only block of [newType] in the result.
 */
export function splitTextBlockAt(
  block: NoteBlock,
  lineIndex: number,
  newType: ListType,
  checked = false
): NoteBlock[] {
  const lines = block.text.split('\n');
  const idx = Math.max(0, Math.min(lineIndex, lines.length - 1));
  const beforeText = lines.slice(0, idx).join('\n');
  const line = lines[idx] ?? '';
  const afterText = lines.slice(idx + 1).join('\n');
  const lineStart = beforeText.length + (idx > 0 ? 1 : 0);
  const p = detectPrefix(line);
  const prefixLen = p ? line.length - p.rest.length : 0;
  const itemText = p ? p.rest : line;
  const itemStart = lineStart + prefixLen;
  const itemEnd = lineStart + line.length;

  const out: NoteBlock[] = [];
  if (beforeText.length) {
    out.push({ ...block, text: beforeText, spans: sliceSpans(block.spans, 0, beforeText.length) });
  }
  const item: NoteBlock = {
    ...styled(block, newType, itemText, checked),
    id: beforeText.length ? newId() : block.id,
    spans: sliceSpans(block.spans, itemStart, itemEnd)
  };
  out.push(item);
  if (afterText.length) {
    out.push({
      ...styled(block, 'TEXT', afterText),
      spans: sliceSpans(block.spans, itemEnd + 1, block.text.length)
    });
  }
  return out;
}

export interface Conversion {
  blocks: NoteBlock[];
  /** The new list item, to focus with the caret at 0. */
  focusId: string;
}

/**
 * The in-place conversion rule: the caret is at [caret] in a TEXT block and the line it is on now
 * starts with a prefix + space, with the caret right after that space (the user just typed it).
 * Returns the replacement blocks, or null when nothing should happen.
 */
export function convertAtCaret(block: NoteBlock, caret: number): Conversion | null {
  if (block.type !== 'TEXT') return null;
  const text = block.text;
  const pos = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const nl = text.indexOf('\n', pos);
  const lineEnd = nl < 0 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);
  const p = detectPrefix(line);
  if (!p) return null;
  const prefixLen = line.length - p.rest.length;
  if (pos - lineStart !== prefixLen) return null;
  const lineIndex = lineStart === 0 ? 0 : text.slice(0, lineStart - 1).split('\n').length;
  const blocks = splitTextBlockAt(block, lineIndex, p.type, p.checked ?? false);
  const item = blocks.find((b) => b.type === p.type);
  return item ? { blocks, focusId: item.id } : null;
}

/** ⏎ in a list item: the text after the caret moves to a new item of the same type. */
export function splitListItemAt(block: NoteBlock, caret: number): [NoteBlock, NoteBlock] {
  const pos = Math.max(0, Math.min(caret, block.text.length));
  const head: NoteBlock = { ...block, text: block.text.slice(0, pos), spans: sliceSpans(block.spans, 0, pos) };
  const tail: NoteBlock = {
    ...styled(block, block.type, block.text.slice(pos)),
    spans: sliceSpans(block.spans, pos, block.text.length)
  };
  return [head, tail];
}

/** ⌫ at caret 0: [cur] joins the end of [prev]; the caret belongs at prev.text.length. */
export function mergeBlocks(prev: NoteBlock, cur: NoteBlock): { block: NoteBlock; caret: number } {
  const join = prev.text.length;
  const text = prev.type === 'TEXT' ? cur.text : cur.text.replace(/\n/g, ' ');
  return {
    block: { ...prev, text: prev.text + text, spans: [...prev.spans, ...shiftSpans(cur.spans, join)] },
    caret: join
  };
}

/** Pasted lines → blocks (one per line; the type per line, TEXT for a line without a prefix). */
export function blocksFromLines(lines: string[], like: NoteBlock): NoteBlock[] {
  return lines
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const p = detectPrefix(l);
      if (!p) return styled(like, 'TEXT', l.replace(/\s+$/, ''));
      return styled(like, p.type, p.rest.replace(/\s+$/, ''), p.checked ?? false);
    });
}
