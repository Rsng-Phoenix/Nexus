import type { NoteBlock, NoteSpan } from './codec';

export interface Sel {
  start: number;
  end: number;
}

function selectionRange(sel: Sel | null, len: number): { start: number; end: number } | null {
  if (!sel || sel.start === sel.end || len === 0) return null;
  const start = Math.max(0, Math.min(sel.start, sel.end, len));
  const end = Math.max(0, Math.min(Math.max(sel.start, sel.end), len));
  return start < end ? { start, end } : null;
}

function styleAt(block: NoteBlock, index: number) {
  const span = block.spans.find((s) => index >= s.start && index < s.end);
  return {
    bold: span?.bold ?? block.bold,
    underline: span?.underline ?? block.underline,
    scale: span?.localScale ?? block.localScale
  };
}

function compressSpans(text: string, styles: ReturnType<typeof styleAt>[], defScale: number): NoteSpan[] {
  const spans: NoteSpan[] = [];
  let i = 0;
  while (i < text.length) {
    const s = styles[i];
    let j = i + 1;
    while (j < text.length) {
      const n = styles[j];
      if (n.bold !== s.bold || n.underline !== s.underline || n.scale !== s.scale) break;
      j++;
    }
    if (s.bold || s.underline || s.scale !== defScale) {
      const o: NoteSpan = { start: i, end: j, bold: s.bold, underline: s.underline };
      if (s.scale !== defScale) o.localScale = s.scale;
      spans.push(o);
    }
    i = j;
  }
  return spans;
}

function applyRange(
  block: NoteBlock,
  range: { start: number; end: number },
  mutate: (s: ReturnType<typeof styleAt>) => ReturnType<typeof styleAt>
): NoteBlock {
  const styles = block.text.split('').map((_, i) => styleAt(block, i));
  for (let i = range.start; i < range.end; i++) styles[i] = mutate(styles[i]);
  return {
    ...block,
    bold: false,
    underline: false,
    spans: compressSpans(block.text, styles, block.localScale)
  };
}

export function toggleBold(block: NoteBlock, sel: Sel | null): NoteBlock {
  const range = selectionRange(sel, block.text.length);
  if (!range) return { ...block, bold: !block.bold, spans: [] };
  const allBold = block.text
    .slice(range.start, range.end)
    .split('')
    .every((_, i) => styleAt(block, range.start + i).bold);
  return applyRange(block, range, (s) => ({ ...s, bold: !allBold }));
}

export function toggleUnderline(block: NoteBlock, sel: Sel | null): NoteBlock {
  const range = selectionRange(sel, block.text.length);
  if (!range) return { ...block, underline: !block.underline, spans: [] };
  const all = block.text
    .slice(range.start, range.end)
    .split('')
    .every((_, i) => styleAt(block, range.start + i).underline);
  return applyRange(block, range, (s) => ({ ...s, underline: !all }));
}

export function adjustScale(block: NoteBlock, sel: Sel | null, delta: number): NoteBlock {
  const range = selectionRange(sel, block.text.length);
  if (!range) {
    return {
      ...block,
      localScale: Math.min(1.6, Math.max(0.75, block.localScale + delta)),
      spans: []
    };
  }
  return applyRange(block, range, (s) => ({
    ...s,
    scale: Math.min(1.6, Math.max(0.75, s.scale + delta))
  }));
}

/** Spans of text[start, end) re-based to 0 (splitting a block). */
export function sliceSpans(spans: NoteSpan[], start: number, end: number): NoteSpan[] {
  const out: NoteSpan[] = [];
  for (const s of spans) {
    const a = Math.max(s.start, start);
    const b = Math.min(s.end, end);
    if (a < b) out.push({ ...s, start: a - start, end: b - start });
  }
  return out;
}

export function shiftSpans(spans: NoteSpan[], delta: number): NoteSpan[] {
  return spans.map((s) => ({ ...s, start: s.start + delta, end: s.end + delta }));
}

function clipSpan(span: NoteSpan, length: number): NoteSpan {
  const start = Math.max(0, Math.min(span.start, length));
  const end = Math.max(start, Math.min(span.end, length));
  return { ...span, start, end };
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string, prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Moves the spans of [oldText] to fit [newText] after a single edit (typing, delete, paste).
 * Same algorithm as Android's NoteSpanUtils.adjustSpansForEdit so styles survive edits identically.
 */
export function adjustSpansForEdit(oldText: string, newText: string, spans: NoteSpan[]): NoteSpan[] {
  if (oldText === newText || !spans.length) return spans;
  const prefix = commonPrefixLength(oldText, newText);
  const suffix = commonSuffixLength(oldText, newText, prefix);
  const oldMidLen = oldText.length - prefix - suffix;
  const newMidLen = newText.length - prefix - suffix;
  const delta = newMidLen - oldMidLen;
  if (delta === 0) return spans.map((s) => clipSpan(s, newText.length));
  const out: NoteSpan[] = [];
  for (const span of spans) {
    const c = clipSpan(span, oldText.length);
    if (c.end <= prefix) out.push(c);
    else if (c.start >= oldText.length - suffix) out.push({ ...c, start: c.start + delta, end: c.end + delta });
    else if (c.start >= prefix && c.end <= oldText.length - suffix) {
      if (newMidLen > 0) out.push({ ...c, start: prefix, end: prefix + newMidLen });
    } else if (c.start < prefix && c.end > oldText.length - suffix) {
      // The edit happened inside this span: it grows/shrinks with the text.
      out.push({ ...c, end: c.end + delta });
    } else if (c.start < prefix) {
      out.push({ ...c, end: Math.max(c.start, Math.min(c.end, prefix) + Math.max(0, delta)) });
    } else {
      out.push({ ...c, start: prefix + newMidLen, end: c.end + delta });
    }
  }
  return out.map((s) => clipSpan(s, newText.length)).filter((s) => s.end > s.start);
}

export function getSelectionFromEl(el: HTMLElement): Sel | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, end: start + range.toString().length };
}

export function restoreSelection(el: HTMLElement, sel: Sel): void {
  const range = document.createRange();
  let char = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOff = 0;
  let endOff = 0;
  let n: Text | null;
  while ((n = walker.nextNode() as Text | null)) {
    const len = n.textContent?.length ?? 0;
    if (!startNode && char + len >= sel.start) {
      startNode = n;
      startOff = sel.start - char;
    }
    if (char + len >= sel.end) {
      endNode = n;
      endOff = sel.end - char;
      break;
    }
    char += len;
  }
  if (!startNode || !endNode) return;
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(range);
}
