import '../styles/notes.css';
import {
  applyAutoArrange,
  collapseEmptyDuplicates,
  ensureWritableTail,
  fromStorage,
  imageBlock,
  imageIdOf,
  listRunIndices,
  numberedIndexInRun,
  toStorage,
  type NoteBlock,
  type BlockType
} from '../notes/codec';
import {
  blocksFromLines,
  convertAtCaret,
  detectPrefix,
  looksLikeList,
  mergeBlocks,
  splitListItemAt
} from '../notes/autolist';
import { encodeImage, imageFilesOf, ImageTooLargeError } from '../notes/images';
import {
  adjustScale,
  adjustSpansForEdit,
  getSelectionFromEl,
  restoreSelection,
  sliceSpans,
  toggleBold,
  toggleUnderline,
  type Sel
} from '../notes/span-utils';
import { getImage, putImage, type ImageRecord } from '../db/tasks';
import { getSettings } from '../settings/store';
import { showSnack } from '../state/toasts';
import { ensureImage } from '../sync/images';

function styleAt(block: NoteBlock, index: number) {
  const span = block.spans.find((s) => index >= s.start && index < s.end);
  return {
    bold: span?.bold ?? block.bold,
    underline: span?.underline ?? block.underline,
    scale: span?.localScale ?? block.localScale
  };
}

function renderBlockText(block: NoteBlock, baseSize: number): string {
  if (!block.text) return '';
  let html = '';
  let i = 0;
  while (i < block.text.length) {
    const s = styleAt(block, i);
    let j = i + 1;
    while (j < block.text.length) {
      const n = styleAt(block, j);
      if (n.bold !== s.bold || n.underline !== s.underline || n.scale !== s.scale) break;
      j++;
    }
    const chunk = escapeHtml(block.text.slice(i, j));
    const cls: string[] = [];
    if (s.bold) cls.push('bold');
    if (s.underline) cls.push('underline');
    if (block.checked && block.type === 'CHECKBOX') cls.push('checked');
    const style =
      s.scale !== 1 ? ` style="font-size:${baseSize * s.scale}px"` : '';
    html += `<span class="nx-note-text ${cls.join(' ')}"${style}>${chunk}</span>`;
    i = j;
  }
  return html;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function blockNeedsRichHtml(block: NoteBlock): boolean {
  return (
    block.spans.length > 0 ||
    block.bold ||
    block.underline ||
    block.localScale !== 1
  );
}

function setEditContent(el: HTMLElement, block: NoteBlock, baseSize: number): void {
  if (blockNeedsRichHtml(block)) {
    el.innerHTML = renderBlockText(block, baseSize) || '<br>';
  } else {
    el.textContent = block.text;
  }
  ensureTail(el);
}

/**
 * Text of an editable line. Line breaks inside a text block are real "\n" characters in text
 * nodes (so selection offsets match the stored text); a trailing <br> only makes a final empty
 * line visible and is not part of the text.
 */
function readEditText(el: HTMLElement): string {
  let out = '';
  const nodes: Node[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  nodes.forEach((n, i) => {
    if (n.nodeType === Node.TEXT_NODE) out += (n as Text).data;
    else if (n.nodeName === 'BR') {
      if (i < nodes.length - 1) out += '\n';
    } else if ((n.nodeName === 'DIV' || n.nodeName === 'P') && out && !out.endsWith('\n')) {
      out += '\n'; // a browser-made line (e.g. dropped HTML)
    }
  });
  return out.replace(/​/g, '');
}

/** Keep a trailing <br> when the text ends with a line break, so the empty last line shows. */
function ensureTail(el: HTMLElement): void {
  const last = el.lastChild;
  const needs = readEditText(el).endsWith('\n');
  const hasTail = last?.nodeName === 'BR';
  if (needs && !hasTail) el.appendChild(document.createElement('br'));
}

/** Insert plain text at the caret (replacing any selection) inside [el]. */
function insertAtCaret(el: HTMLElement, text: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return;
  range.deleteContents();
  // An empty line holds only a placeholder <br>; replace it.
  if (el.childNodes.length === 1 && el.firstChild?.nodeName === 'BR') el.textContent = '';
  const node = document.createTextNode(text);
  if (el.childNodes.length === 0) el.appendChild(node);
  else range.insertNode(node);
  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
  el.normalize();
  ensureTail(el);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A block of [type] carrying the style (indent, bold, underline, scale) of [like]. */
function blockLike(like: NoteBlock, type: BlockType, text = ''): NoteBlock {
  return {
    id: crypto.randomUUID(),
    type,
    text,
    checked: false,
    indent: like.indent,
    bold: like.bold,
    underline: like.underline,
    localScale: like.localScale,
    spans: [],
    sortKey: -1
  };
}

/** [text] with the selection [sel] removed, spans adjusted. */
function deleteRange(block: NoteBlock, sel: Sel): NoteBlock {
  if (sel.start === sel.end) return block;
  const text = block.text.slice(0, sel.start) + block.text.slice(sel.end);
  return { ...block, text, spans: adjustSpansForEdit(block.text, text, block.spans) };
}

// ---- Images -----------------------------------------------------------------------------------

const objectUrls = new Map<string, string>();

function urlFor(rec: ImageRecord): string {
  let url = objectUrls.get(rec.id);
  if (!url) {
    url = URL.createObjectURL(rec.blob);
    objectUrls.set(rec.id, url);
  }
  return url;
}

/**
 * Draws image [id] into [el]: a shimmer first, then the picture from the local cache, fetching it
 * from Drive when this device has not seen it yet. Click opens the full size in a new tab.
 * Read-only renderers (e.g. the widget's TaskPeek) call this for their IMAGE blocks.
 */
export function renderImageBlock(el: HTMLElement, id: string): void {
  el.classList.add('nx-note-img');
  el.classList.remove('nx-note-img--missing');
  el.innerHTML = '';
  const shimmer = document.createElement('div');
  shimmer.className = 'nx-note-img__shimmer';
  el.appendChild(shimmer);
  void (async () => {
    const rec = (await getImage(id).catch(() => undefined)) ?? (await ensureImage(id));
    el.innerHTML = '';
    if (!rec) {
      el.classList.add('nx-note-img--missing');
      el.textContent = 'Image unavailable';
      return;
    }
    const img = document.createElement('img');
    img.alt = 'Note image';
    img.decoding = 'async';
    if (rec.w > 0 && rec.h > 0) {
      img.width = rec.w;
      img.height = rec.h;
    }
    img.src = urlFor(rec);
    img.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(img.src, '_blank', 'noopener');
    });
    el.appendChild(img);
  })();
}

/**
 * Encodes and stores a picked/pasted image; the id for an IMAGE block, or null after telling the
 * user why it was refused.
 */
export async function addImageFromFile(file: Blob): Promise<string | null> {
  try {
    const enc = await encodeImage(file);
    const have = await getImage(enc.id).catch(() => undefined);
    if (!have) await putImage({ id: enc.id, blob: enc.blob, w: enc.w, h: enc.h, addedAt: Date.now(), uploaded: false });
    return enc.id;
  } catch (e) {
    showSnack(e instanceof ImageTooLargeError ? 'Image is too large (over 4 MB after resizing)' : 'Could not add that image');
    return null;
  }
}

/** Where new IMAGE blocks go relative to block [idx]: before an empty TEXT line, after anything else. */
export function imageInsertIndex(blocks: NoteBlock[], idx: number): number {
  const at = blocks[idx];
  if (!at) return blocks.length;
  return at.type === 'TEXT' && !at.text ? idx : idx + 1;
}

// ---- Editor -----------------------------------------------------------------------------------

/** Caret after focusing a block: at the end, left alone, or at a character offset. */
type CaretPos = 'end' | 'keep' | number;

export function renderNotesEditor(
  container: HTMLElement,
  rawNotes: string,
  onChange: (storage: string) => void
): {
  focusEnd: () => void;
  getBlocks: () => NoteBlock[];
  setBlocks: (b: NoteBlock[]) => void;
  insertImages: (files: Blob[]) => Promise<void>;
} {
  let blocks = fromStorage(rawNotes);
  let composer = { bold: false, underline: false, scale: 1 };
  let editingId: string | null = null;

  const scale = getSettings().fontScale;
  const baseSize = 14 * scale;

  const flushStorage = (): void => {
    let b = blocks;
    if (getSettings().autoArrange) b = applyAutoArrange(b);
    b = collapseEmptyDuplicates(b);
    b = ensureWritableTail(b);
    blocks = b;
    onChange(toStorage(b));
  };

  const indexOf = (id: string) => blocks.findIndex((b) => b.id === id);

  const focusBlock = (id: string, caret: CaretPos = 'end'): void => {
    requestAnimationFrame(() => {
      const row = container.querySelector(`[data-block="${id}"] [data-focus]`) as HTMLElement | null;
      if (!row) return;
      row.focus();
      if (caret === 'keep' || !row.isContentEditable) return;
      if (caret === 'end') {
        const sel = window.getSelection();
        const range = document.createRange();
        // Before the trailing <br> (if any), so typing continues the last line.
        if (row.lastChild?.nodeName === 'BR') range.setStartBefore(row.lastChild);
        else {
          range.selectNodeContents(row);
          range.collapse(false);
        }
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
        return;
      }
      if (caret === 0 && !readEditText(row)) return; // empty line: focus alone puts the caret there
      restoreSelection(row, { start: caret, end: caret });
    });
  };

  const newBlock = (type: BlockType): NoteBlock => ({
    id: crypto.randomUUID(),
    type,
    text: '',
    checked: false,
    indent: 0,
    bold: composer.bold,
    underline: composer.underline,
    localScale: composer.scale,
    spans: [],
    sortKey: -1
  });

  /** Replace blocks[index .. index + remove) with [add], redraw and focus. */
  const replaceAt = (index: number, remove: number, add: NoteBlock[], focusId: string, caret: CaretPos): void => {
    blocks.splice(index, remove, ...add);
    editingId = null;
    flushStorage();
    draw();
    focusBlock(focusId, caret);
  };

  const insertAfter = (index: number, type: BlockType): void => {
    const current = blocks[index];
    if (current?.type === type && !current.text) {
      focusBlock(current.id);
      return;
    }
    const next = blocks[index + 1];
    if (next?.type === type && !next.text) {
      focusBlock(next.id);
      return;
    }
    const inserted = newBlock(type);
    replaceAt(index + 1, 0, [inserted], inserted.id, 'end');
  };

  /** A list item becomes a plain line, keeping its text (Notion / Apple Notes rule). */
  const revertToText = (index: number, caret: CaretPos): void => {
    const b = blocks[index];
    replaceAt(index, 1, [{ ...b, type: 'TEXT', checked: false, indent: 0, sortKey: -1 }], b.id, caret);
  };

  /** ⌫ on an empty line (or on an image block): delete it and land on the previous line. */
  const removeBlock = (index: number): void => {
    const block = blocks[index];
    if (block.type !== 'TEXT' && block.type !== 'IMAGE' && !block.text) {
      if (block.indent > 0) {
        replaceAt(index, 1, [{ ...block, indent: block.indent - 1 }], block.id, 'end');
        return;
      }
      revertToText(index, 'end');
      return;
    }
    if (blocks.length > 1) {
      const prev = blocks[index - 1] ?? blocks[index + 1];
      blocks.splice(index, 1);
      editingId = null;
      flushStorage();
      draw();
      const target = blocks.find((b) => b.id === prev.id) ?? blocks[Math.min(index, blocks.length - 1)];
      focusBlock(target.id, target.type === 'IMAGE' ? 'keep' : index > 0 ? 'end' : 0);
    } else {
      const single = newBlock('TEXT');
      blocks = [single];
      editingId = null;
      flushStorage();
      draw();
      focusBlock(single.id);
    }
  };

  const insertImages = async (files: Blob[], anchorId?: string): Promise<void> => {
    const ids: string[] = [];
    for (const f of files) {
      const id = await addImageFromFile(f);
      if (id) ids.push(id);
    }
    if (!ids.length) return;
    const anchor = anchorId ? indexOf(anchorId) : -1;
    const at = anchor >= 0 ? imageInsertIndex(blocks, anchor) : blocks.length;
    const added = ids.map((id) => imageBlock(id));
    blocks.splice(at, 0, ...added);
    editingId = null;
    flushStorage();
    draw();
    // Continue typing on the line after the picture(s).
    const after = blocks[indexOf(added[added.length - 1].id) + 1];
    if (after) focusBlock(after.id, after.type === 'IMAGE' ? 'keep' : 0);
  };

  const notesHasContent = (): boolean =>
    blocks.some((b) => b.text.trim().length > 0 || b.type !== 'TEXT');

  const drawImageRow = (row: HTMLElement, block: NoteBlock): void => {
    row.classList.add('nx-note-line--image');
    const wrap = document.createElement('div');
    wrap.className = 'nx-note-img-wrap';
    wrap.tabIndex = 0;
    wrap.dataset.focus = '1';
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', 'Image');
    const pic = document.createElement('div');
    renderImageBlock(pic, imageIdOf(block) ?? '');
    wrap.appendChild(pic);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'nx-note-img-x';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Remove image');
    x.addEventListener('mousedown', (e) => e.preventDefault());
    x.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = indexOf(block.id);
      if (idx >= 0) removeBlock(idx);
    });
    wrap.appendChild(x);
    wrap.addEventListener('focus', () => {
      activeId = block.id;
      editingId = block.id;
      row.classList.add('nx-note-line--focus');
    });
    wrap.addEventListener('blur', () => {
      if (editingId === block.id) editingId = null;
      row.classList.remove('nx-note-line--focus');
    });
    wrap.addEventListener('keydown', (e) => {
      const idx = indexOf(block.id);
      if (idx < 0) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        removeBlock(idx);
      } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
        const next = blocks[idx + 1];
        if (next) {
          e.preventDefault();
          focusBlock(next.id, next.type === 'IMAGE' ? 'keep' : 0);
        }
      } else if (e.key === 'ArrowUp') {
        const prev = blocks[idx - 1];
        if (prev) {
          e.preventDefault();
          focusBlock(prev.id, prev.type === 'IMAGE' ? 'keep' : 'end');
        }
      }
    });
    row.appendChild(wrap);
  };

  const draw = (): void => {
    const keepFocus = editingId;
    const hasContent = notesHasContent();
    container.innerHTML = '';
    blocks.forEach((block, index) => {
      const row = document.createElement('div');
      row.className = 'nx-note-line';
      row.dataset.block = block.id;
      row.style.paddingLeft = `${block.indent * 18}px`;

      if (block.type === 'IMAGE') {
        drawImageRow(row, block);
        container.appendChild(row);
        return;
      }

      if (block.type === 'CHECKBOX') {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'nx-note-cb';
        cb.checked = block.checked;
        cb.addEventListener('change', () => {
          const liveIdx = indexOf(block.id);
          if (liveIdx < 0) return;
          const live = blocks[liveIdx];
          if (!live.text.trim()) {
            cb.checked = live.checked;
            return;
          }
          const run = listRunIndices(blocks, liveIdx, 'CHECKBOX');
          const pos = run.indexOf(liveIdx);
          blocks[liveIdx] = {
            ...live,
            checked: cb.checked,
            sortKey: cb.checked ? pos : -1
          };
          flushStorage();
          draw();
        });
        row.appendChild(cb);
      } else if (block.type === 'BULLET') {
        const m = document.createElement('span');
        m.className = 'nx-list-marker';
        m.textContent = '•';
        row.appendChild(m);
      } else if (block.type === 'NUMBERED') {
        const n = numberedIndexInRun(blocks, index);
        const m = document.createElement('span');
        m.className = 'nx-list-marker nx-list-num';
        m.textContent = `${n}.`;
        row.appendChild(m);
      }

      const el = document.createElement('div');
      el.className = 'nx-note-edit';
      el.contentEditable = 'true';
      el.dataset.focus = '1';
      el.setAttribute('role', 'textbox');
      el.setAttribute('tabindex', '0');
      const showPh =
        block.type === 'TEXT' && !block.text.trim() && !hasContent;
      if (showPh) {
        el.dataset.placeholder = 'Add description…';
        el.dataset.ph = '1';
      } else {
        delete el.dataset.placeholder;
        delete el.dataset.ph;
      }
      setEditContent(el, block, baseSize);

      el.addEventListener('focus', () => {
        activeId = block.id;
        editingId = block.id;
        row.classList.add('nx-note-line--focus');
      });
      el.addEventListener('blur', () => {
        if (editingId === block.id) editingId = null;
        row.classList.remove('nx-note-line--focus');
      });
      el.addEventListener('input', () => {
        const liveIdx = indexOf(block.id);
        if (liveIdx < 0) return;
        let live = blocks[liveIdx];
        const raw = readEditText(el);
        // Text blocks keep their line breaks (same as Android); list items are single lines.
        const text = live.type === 'TEXT' ? raw : raw.replace(/\n/g, '');
        live = { ...live, text, spans: adjustSpansForEdit(live.text, text, live.spans) };
        if (!live.text && live.type !== 'TEXT') {
          live = {
            ...live,
            localScale: composer.scale,
            bold: composer.bold,
            underline: composer.underline
          };
        }
        blocks[liveIdx] = live;
        if (live.type === 'TEXT') {
          // "- ", "1. ", "[ ] " just typed at the start of the caret's line → that line is a list item.
          const caret = getSelectionFromEl(el)?.start;
          const conv = caret == null ? null : convertAtCaret(live, caret);
          if (conv) {
            replaceAt(liveIdx, 1, conv.blocks, conv.focusId, 0);
            return;
          }
        }
        onChange(toStorage(blocks));
      });
      el.addEventListener('keydown', (e) => {
        const liveIdx = indexOf(block.id);
        if (liveIdx < 0) return;
        const live = blocks[liveIdx];
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          if (live.type === 'TEXT') {
            // Enter and Shift+Enter both start a new line inside the description.
            insertAtCaret(el, '\n');
            return;
          }
          if (!live.text) {
            // ⏎ on an empty item leaves the list.
            revertToText(liveIdx, 'end');
            return;
          }
          // Split at the caret: what follows it moves to the new item.
          const sel = getSelectionFromEl(el) ?? { start: live.text.length, end: live.text.length };
          const [head, tail] = splitListItemAt(deleteRange(live, sel), Math.min(sel.start, sel.end));
          replaceAt(liveIdx, 1, [head, tail], tail.id, 0);
          return;
        }
        if (e.key === 'Backspace') {
          if (!live.text) {
            e.preventDefault();
            removeBlock(liveIdx);
            return;
          }
          const sel = getSelectionFromEl(el);
          if (!sel || sel.start !== 0 || sel.end !== 0) return;
          if (live.type !== 'TEXT') {
            // ⌫ at the start of an item: outdent, then become plain text (keeping the text).
            e.preventDefault();
            if (live.indent > 0) replaceAt(liveIdx, 1, [{ ...live, indent: live.indent - 1 }], live.id, 0);
            else revertToText(liveIdx, 0);
            return;
          }
          const prev = blocks[liveIdx - 1];
          if (!prev) return;
          e.preventDefault();
          if (prev.type === 'IMAGE') {
            // Select the picture first; ⌫ again removes it.
            focusBlock(prev.id, 'keep');
            return;
          }
          if (prev.type !== 'TEXT' && live.text.includes('\n')) {
            // Only the first line joins the item; the rest stays a text block.
            const nl = live.text.indexOf('\n');
            const first = { ...live, text: live.text.slice(0, nl), spans: sliceSpans(live.spans, 0, nl) };
            const rest = {
              ...blockLike(live, 'TEXT', live.text.slice(nl + 1)),
              spans: sliceSpans(live.spans, nl + 1, live.text.length)
            };
            const m = mergeBlocks(prev, first);
            replaceAt(liveIdx - 1, 2, [m.block, rest], m.block.id, m.caret);
            return;
          }
          const m = mergeBlocks(prev, live);
          replaceAt(liveIdx - 1, 2, [m.block], m.block.id, m.caret);
          return;
        }
        if (e.key === 'Tab' && live.type !== 'TEXT') {
          e.preventDefault();
          const delta = e.shiftKey ? -1 : 1;
          const nextIndent = Math.max(0, live.indent + delta);
          if (nextIndent !== live.indent) {
            blocks[liveIdx] = { ...live, indent: nextIndent };
            flushStorage();
            draw();
            focusBlock(block.id);
          }
        }
      });
      el.addEventListener('paste', (e) => {
        const images = imageFilesOf(e.clipboardData);
        if (images.length) {
          e.preventDefault();
          void insertImages(images, block.id);
          return;
        }
        const text = e.clipboardData?.getData('text/plain');
        if (text == null) return;
        e.preventDefault(); // never paste foreign HTML/styles into a note
        const clean = text.replace(/\r\n?/g, '\n');
        const liveIdx = indexOf(block.id);
        const live = blocks[liveIdx];
        if (!live) return;
        const lines = clean.split('\n');
        if (!clean.includes('\n')) {
          insertAtCaret(el, clean);
          return;
        }
        if (live.type === 'TEXT') {
          if (!looksLikeList(lines)) {
            insertAtCaret(el, clean);
            return;
          }
          // A pasted list becomes real items, splitting the description at the caret.
          const sel = getSelectionFromEl(el) ?? { start: live.text.length, end: live.text.length };
          const s = Math.min(sel.start, sel.end);
          const en = Math.max(sel.start, sel.end);
          const before = live.text.slice(0, s);
          const after = live.text.slice(en);
          const added = blocksFromLines(lines, live);
          const parts: NoteBlock[] = [];
          if (before) parts.push({ ...live, text: before, spans: sliceSpans(live.spans, 0, s) });
          parts.push(...added);
          if (after) parts.push({ ...blockLike(live, 'TEXT', after), spans: sliceSpans(live.spans, en, live.text.length) });
          const last = added[added.length - 1] ?? parts[parts.length - 1];
          replaceAt(liveIdx, 1, parts, last.id, 'end');
          return;
        }
        // Several lines into a list: one item per line (any prefixes they carry are dropped).
        const [first, ...rest] = lines;
        insertAtCaret(el, detectPrefix(first)?.rest ?? first);
        const at = indexOf(block.id);
        const added = rest
          .filter((l) => l.trim())
          .map((l) => ({ ...newBlock(live.type), indent: live.indent, text: (detectPrefix(l)?.rest ?? l).trim() }));
        if (!added.length) return;
        replaceAt(at + 1, 0, added, added[added.length - 1].id, 'end');
      });
      row.appendChild(el);
      container.appendChild(row);
    });
    if (keepFocus) focusBlock(keepFocus, 'keep');
  };

  let activeId: string | null = blocks[0]?.id ?? null;
  draw();

  /** The line nearest to [y] (or the last line). */
  const lineNear = (y?: number): HTMLElement | undefined => {
    const lines = Array.from(container.querySelectorAll<HTMLElement>('.nx-note-line'));
    const hit =
      y == null
        ? undefined
        : lines.find((l) => {
            const r = l.getBoundingClientRect();
            return y >= r.top && y <= r.bottom;
          });
    return hit ?? lines[lines.length - 1];
  };

  /** Put the caret at the end of the line nearest to [y] (or the last line). */
  const focusNear = (y?: number): void => {
    const id = lineNear(y)?.dataset.block;
    if (id) focusBlock(id, blocks[indexOf(id)]?.type === 'IMAGE' ? 'keep' : 'end');
  };

  // Tapping anywhere in the description (not just on the first line) starts typing.
  container.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const edit = t.closest('.nx-note-edit');
    if (edit) {
      (edit as HTMLElement).focus();
      return;
    }
    if (t.closest('input, button, .nx-note-img-wrap')) return;
    focusNear(e.clientY);
  });

  // Dropping a picture (from Finder, a browser tab…) adds an IMAGE block near the drop point.
  container.addEventListener('dragover', (e) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    container.classList.add('nx-note-drop');
  });
  container.addEventListener('dragleave', () => container.classList.remove('nx-note-drop'));
  container.addEventListener('drop', (e) => {
    container.classList.remove('nx-note-drop');
    const files = imageFilesOf(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    void insertImages(files, lineNear(e.clientY)?.dataset.block);
  });

  return {
    focusEnd: () => focusNear(),
    getBlocks: () => blocks,
    setBlocks: (b) => {
      blocks = b;
      flushStorage();
      const focus = editingId;
      draw();
      if (focus) focusBlock(focus, 'keep');
    },
    insertImages: (files) => insertImages(files, activeId ?? undefined)
  };
}

export function notesToolbar(
  bar: HTMLElement,
  notesRoot: HTMLElement,
  getBlocks: () => NoteBlock[],
  setBlocks: (b: NoteBlock[]) => void,
  onPersist: () => void,
  getActiveEl: () => HTMLElement | null
): void {
  let composer = { bold: false, underline: false, scale: 1 };
  let savedSel: { blockId: string; sel: Sel } | null = null;

  notesRoot.addEventListener('mouseup', () => {
    const el = getActiveEl();
    if (!el) return;
    const id = el.closest('[data-block]')?.getAttribute('data-block');
    const sel = getSelectionFromEl(el);
    if (id && sel) savedSel = { blockId: id, sel };
  });

  const applyFormat = (fn: (b: NoteBlock, sel: Sel | null) => NoteBlock): void => {
    const blocks = getBlocks();
    let el = getActiveEl();
    let blockId = el?.closest('[data-block]')?.getAttribute('data-block') ?? null;
    let sel = el ? getSelectionFromEl(el) : null;
    if ((!sel || sel.start === sel.end) && savedSel) {
      blockId = savedSel.blockId;
      sel = savedSel.sel;
      el = notesRoot.querySelector(
        `[data-block="${blockId}"] .nx-note-edit`
      ) as HTMLElement | null;
    }
    let idx = blockId ? blocks.findIndex((b) => b.id === blockId) : blocks.length - 1;
    if (idx < 0) idx = blocks.length - 1;
    if (blocks[idx].type === 'IMAGE') return; // nothing to format on a picture
    const updated = fn(blocks[idx], sel);
    if (!blocks[idx].text) {
      composer = {
        bold: updated.bold,
        underline: updated.underline,
        scale: updated.localScale
      };
    }
    const next = [...blocks];
    const id = blocks[idx].id;
    const keepSel = sel && sel.start < sel.end ? sel : null;
    next[idx] = updated;
    setBlocks(next);
    onPersist();
    if (keepSel) {
      requestAnimationFrame(() => {
        const row = notesRoot.querySelector(
          `[data-block="${id}"] .nx-note-edit`
        ) as HTMLElement | null;
        if (row) restoreSelection(row, keepSel);
      });
    }
  };

  /** Index of the block the user is on (falls back to the last one). */
  const activeIndex = (blocks: NoteBlock[]): number => {
    const el = getActiveEl() ?? (document.activeElement as HTMLElement | null)?.closest('.nx-note-img-wrap');
    const id = el?.closest('[data-block]')?.getAttribute('data-block');
    let idx = id ? blocks.findIndex((b) => b.id === id) : blocks.length - 1;
    if (idx < 0) idx = blocks.length - 1;
    return idx;
  };

  const insertList = (type: BlockType): void => {
    const blocks = getBlocks();
    const el = getActiveEl();
    const idx = activeIndex(blocks);
    const block = blocks[idx];

    if (block.type === 'IMAGE') {
      const inserted = newEmptyBlock(type);
      const next = [...blocks];
      next.splice(idx + 1, 0, inserted);
      setBlocks(next);
      onPersist();
      return;
    }

    const isList = block.type === 'BULLET' || block.type === 'NUMBERED';
    if (
      (type === 'BULLET' || type === 'NUMBERED') &&
      isList &&
      block.text.trim() &&
      block.type === type
    ) {
      const next = [...blocks];
      next[idx] = { ...block, indent: block.indent + 1 };
      setBlocks(next);
      onPersist();
      return;
    }

    if (!block.text && block.type !== 'TEXT') {
      if (block.type === type) {
        requestAnimationFrame(() => el?.focus());
        return;
      }
      const next = [...blocks];
      next[idx] = {
        ...newEmptyBlock(type),
        id: block.id,
        indent: block.indent,
        localScale: composer.scale,
        bold: composer.bold,
        underline: composer.underline
      };
      setBlocks(next);
      onPersist();
      return;
    }
    if (block.type === 'TEXT' && !block.text) {
      const next = [...blocks];
      next[idx] = {
        ...newEmptyBlock(type),
        id: block.id,
        localScale: composer.scale,
        bold: composer.bold,
        underline: composer.underline
      };
      setBlocks(next);
      onPersist();
      return;
    }
    if (block.type === type && !block.text) return;
    const inserted = newEmptyBlock(type);
    inserted.localScale = composer.scale;
    inserted.bold = composer.bold;
    inserted.underline = composer.underline;
    const next = [...blocks];
    next.splice(idx + 1, 0, inserted);
    setBlocks(next);
    onPersist();
  };

  // "Add image": the picker is a hidden file input; the block goes next to the active line.
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.multiple = true;
  picker.className = 'nx-tool-file';
  picker.addEventListener('change', () => {
    const files = Array.from(picker.files ?? []);
    picker.value = '';
    if (!files.length) return;
    const idx = activeIndex(getBlocks());
    void (async () => {
      const ids: string[] = [];
      for (const f of files) {
        const id = await addImageFromFile(f);
        if (id) ids.push(id);
      }
      if (!ids.length) return;
      const blocks = getBlocks();
      const next = [...blocks];
      next.splice(imageInsertIndex(blocks, Math.min(idx, blocks.length - 1)), 0, ...ids.map((id) => imageBlock(id)));
      setBlocks(next);
      onPersist();
    })();
  });

  const tools: { label: string; title: string; action: () => void }[] = [
    { label: '☐', title: 'Checklist', action: () => insertList('CHECKBOX') },
    { label: '•', title: 'Bullet list', action: () => insertList('BULLET') },
    { label: '1.', title: 'Numbered list', action: () => insertList('NUMBERED') },
    { label: '🖼', title: 'Add image', action: () => picker.click() },
    { label: 'A+', title: 'Larger text', action: () => applyFormat((b, s) => adjustScale(b, s, 0.08)) },
    { label: 'A−', title: 'Smaller text', action: () => applyFormat((b, s) => adjustScale(b, s, -0.08)) },
    { label: 'B', title: 'Bold', action: () => applyFormat((b, s) => toggleBold(b, s)) },
    { label: 'U', title: 'Underline', action: () => applyFormat((b, s) => toggleUnderline(b, s)) }
  ];

  bar.innerHTML = '';
  tools.forEach(({ label, title, action }) => {
    const b = document.createElement('button');
    b.className = 'nx-tool';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.type = 'button';
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      action();
    });
    bar.appendChild(b);
  });
  bar.appendChild(picker);
}

function newEmptyBlock(type: BlockType): NoteBlock {
  return {
    id: crypto.randomUUID(),
    type,
    text: '',
    checked: false,
    indent: 0,
    bold: false,
    underline: false,
    localScale: 1,
    spans: [],
    sortKey: -1
  };
}
