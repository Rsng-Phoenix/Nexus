import {
  applyAutoArrange,
  collapseEmptyDuplicates,
  ensureWritableTail,
  fromStorage,
  listRunIndices,
  numberedIndexInRun,
  toStorage,
  type NoteBlock,
  type BlockType
} from '../notes/codec';
import {
  adjustScale,
  getSelectionFromEl,
  restoreSelection,
  toggleBold,
  toggleUnderline,
  type Sel
} from '../notes/span-utils';
import { getSettings } from '../settings/store';

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
}

export function renderNotesEditor(
  container: HTMLElement,
  rawNotes: string,
  onChange: (storage: string) => void
): { getBlocks: () => NoteBlock[]; setBlocks: (b: NoteBlock[]) => void } {
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

  const focusBlock = (id: string, caretAtEnd = true): void => {
    requestAnimationFrame(() => {
      const row = container.querySelector(`[data-block="${id}"] .nx-note-edit`) as HTMLElement | null;
      if (!row) return;
      row.focus();
      if (caretAtEnd) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(row);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
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
    blocks.splice(index + 1, 0, inserted);
    flushStorage();
    draw();
    focusBlock(inserted.id);
  };

  const backspaceBlock = (index: number): void => {
    const block = blocks[index];
    if (block.type !== 'TEXT' && !block.text) {
      if (block.indent > 0) {
        blocks[index] = { ...block, indent: block.indent - 1 };
        flushStorage();
        draw();
        focusBlock(block.id);
        return;
      }
      blocks[index] = { ...newBlock('TEXT'), id: block.id };
      flushStorage();
      draw();
      focusBlock(block.id);
      return;
    }
    if (blocks.length > 1) {
      const stay = blocks[Math.min(index, blocks.length - 2)]?.id ?? blocks[0].id;
      blocks.splice(index, 1);
      flushStorage();
      draw();
      focusBlock(stay);
    } else {
      const single = newBlock('TEXT');
      blocks = [single];
      flushStorage();
      draw();
      focusBlock(single.id);
    }
  };

  const notesHasContent = (): boolean =>
    blocks.some((b) => b.text.trim().length > 0 || b.type !== 'TEXT');

  const draw = (): void => {
    const keepFocus = editingId;
    const hasContent = notesHasContent();
    container.innerHTML = '';
    blocks.forEach((block, index) => {
      const row = document.createElement('div');
      row.className = 'nx-note-line';
      row.dataset.block = block.id;
      row.style.paddingLeft = `${block.indent * 18}px`;

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
        live = { ...live, text: el.innerText.replace(/\n/g, '') };
        if (!live.text && live.type !== 'TEXT') {
          live = {
            ...live,
            localScale: composer.scale,
            bold: composer.bold,
            underline: composer.underline
          };
        }
        blocks[liveIdx] = live;
        onChange(toStorage(blocks));
      });
      el.addEventListener('keydown', (e) => {
        const liveIdx = indexOf(block.id);
        if (liveIdx < 0) return;
        const live = blocks[liveIdx];
        if (e.key === 'Enter' && !e.shiftKey) {
          if (live.type === 'TEXT') return;
          e.preventDefault();
          editingId = null;
          insertAfter(liveIdx, live.type);
        }
        if (e.key === 'Backspace' && !live.text) {
          e.preventDefault();
          editingId = null;
          backspaceBlock(liveIdx);
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
      row.appendChild(el);
      container.appendChild(row);
    });
    if (keepFocus) focusBlock(keepFocus, false);
  };

  let activeId: string | null = blocks[0]?.id ?? null;
  draw();

  container.addEventListener('click', (e) => {
    const edit = (e.target as HTMLElement).closest('.nx-note-edit');
    if (edit) (edit as HTMLElement).focus();
  });

  return {
    getBlocks: () => blocks,
    setBlocks: (b) => {
      blocks = b;
      flushStorage();
      const focus = editingId;
      draw();
      if (focus) focusBlock(focus, false);
    }
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

  const insertList = (type: BlockType): void => {
    const blocks = getBlocks();
    const el = getActiveEl();
    const id = el?.closest('[data-block]')?.getAttribute('data-block');
    let idx = id ? blocks.findIndex((b) => b.id === id) : blocks.length - 1;
    if (idx < 0) idx = blocks.length - 1;
    const block = blocks[idx];

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

  const tools: { label: string; action: () => void }[] = [
    { label: '☐', action: () => insertList('CHECKBOX') },
    { label: '•', action: () => insertList('BULLET') },
    { label: '1.', action: () => insertList('NUMBERED') },
    { label: 'A+', action: () => applyFormat((b, s) => adjustScale(b, s, 0.08)) },
    { label: 'A−', action: () => applyFormat((b, s) => adjustScale(b, s, -0.08)) },
    { label: 'B', action: () => applyFormat((b, s) => toggleBold(b, s)) },
    { label: 'U', action: () => applyFormat((b, s) => toggleUnderline(b, s)) }
  ];

  bar.innerHTML = '';
  tools.forEach(({ label, action }) => {
    const b = document.createElement('button');
    b.className = 'nx-tool';
    b.textContent = label;
    b.type = 'button';
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      action();
    });
    bar.appendChild(b);
  });
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
