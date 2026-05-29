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
