export type BlockType = 'TEXT' | 'CHECKBOX' | 'BULLET' | 'NUMBERED';

export interface NoteSpan {
  start: number;
  end: number;
  bold: boolean;
  underline: boolean;
  localScale?: number;
}

export interface NoteBlock {
  id: string;
  type: BlockType;
  text: string;
  checked: boolean;
  indent: number;
  bold: boolean;
  underline: boolean;
  localScale: number;
  spans: NoteSpan[];
  sortKey: number;
}

export function fromStorage(raw: string): NoteBlock[] {
  if (!raw.trim()) return [block('TEXT', '')];
  if (!raw.trimStart().startsWith('{')) {
    return raw.split('\n').map(parseLegacyLine).filter(Boolean) as NoteBlock[];
  }
  try {
    const o = JSON.parse(raw) as { blocks?: Record<string, unknown>[] };
    const blocks = o.blocks ?? [];
    const out = blocks.map(parseBlock);
    return out.length ? out : [block('TEXT', '')];
  } catch {
    return [block('TEXT', raw)];
  }
}

function parseLegacyLine(line: string): NoteBlock {
  if (line.startsWith('- [x] '))
    return block('CHECKBOX', line.slice(6), true);
  if (line.startsWith('- [ ] ')) return block('CHECKBOX', line.slice(6));
  if (line.startsWith('- ')) return block('BULLET', line.slice(2));
  if (/^\d+\.\s/.test(line))
    return block('NUMBERED', line.replace(/^\d+\.\s/, ''));
  return block('TEXT', line);
}

function parseBlock(o: Record<string, unknown>): NoteBlock {
  const spans = ((o.spans as Record<string, unknown>[]) ?? []).map((s) => ({
    start: Number(s.start ?? 0),
    end: Number(s.end ?? 0),
    bold: Boolean(s.bold),
    underline: Boolean(s.underline),
    localScale:
      s.localScale !== undefined && !Number.isNaN(Number(s.localScale))
        ? Number(s.localScale)
        : undefined
  }));
  return {
    id: String(o.id ?? crypto.randomUUID()),
    type: (o.type as BlockType) || 'TEXT',
    text: String(o.text ?? ''),
    checked: Boolean(o.checked),
    indent: Number(o.indent ?? 0),
    bold: Boolean(o.bold),
    underline: Boolean(o.underline),
    localScale: Math.min(1.6, Math.max(0.75, Number(o.localScale ?? 1))),
    spans,
    sortKey: Number(o.sortKey ?? -1)
  };
}

function block(
  type: BlockType,
  text: string,
  checked = false
): NoteBlock {
  return {
    id: crypto.randomUUID(),
    type,
    text,
    checked,
    indent: 0,
    bold: false,
    underline: false,
    localScale: 1,
    spans: [],
    sortKey: -1
  };
}

export function toStorage(blocks: NoteBlock[]): string {
  return JSON.stringify({
    blocks: blocks.map((b) => ({
      id: b.id,
      type: b.type,
      text: b.text,
      checked: b.checked,
      indent: b.indent,
      bold: b.bold,
      underline: b.underline,
      localScale: b.localScale,
      spans: b.spans.map((s) => {
        const o: Record<string, unknown> = {
          start: s.start,
          end: s.end,
          bold: s.bold,
          underline: s.underline
        };
        if (s.localScale !== undefined) o.localScale = s.localScale;
        return o;
      }),
      sortKey: b.sortKey
    }))
  });
}

/** Contiguous blocks of the same list type (TEXT lines break numbering). */
export function listRunIndices(blocks: NoteBlock[], index: number, type: BlockType): number[] {
  if (blocks[index]?.type !== type) return [index];
  let start = index;
  while (start > 0 && blocks[start - 1].type === type) start--;
  let end = index;
  while (end < blocks.length - 1 && blocks[end + 1].type === type) end++;
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

export function numberedIndexInRun(blocks: NoteBlock[], index: number): number {
  const target = blocks[index];
  if (!target || target.type !== 'NUMBERED') return 1;
  const indent = target.indent;
  let count = 0;
  for (let i = 0; i <= index; i++) {
    const b = blocks[i];
    if (b.type === 'NUMBERED' && b.indent < indent) count = 0;
    if (b.type === 'NUMBERED' && b.indent === indent) count++;
  }
  return Math.max(1, count);
}

export function applyAutoArrange(blocks: NoteBlock[]): NoteBlock[] {
  if (!blocks.some((b) => b.type === 'CHECKBOX')) return blocks;
  const result: NoteBlock[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i].type !== 'CHECKBOX') {
      result.push(blocks[i]);
      i++;
      continue;
    }
    const runStart = i;
    while (i < blocks.length && blocks[i].type === 'CHECKBOX') i++;
    const run = blocks.slice(runStart, i);
    const indexed = run.map((b, idx) => [idx, b] as const);
    const unchecked = indexed
      .filter(([, b]) => !b.checked)
      .sort(([a], [b]) => a - b)
      .map(([, b]) => b);
    const checked = indexed
      .filter(([, b]) => b.checked)
      .sort(([, a], [, b]) => a.sortKey - b.sortKey)
      .map(([, b]) => b);
    result.push(...unchecked, ...checked);
  }
  return result;
}

export function collapseEmptyDuplicates(blocks: NoteBlock[]): NoteBlock[] {
  const result: NoteBlock[] = [];
  for (const b of blocks) {
    const last = result[result.length - 1];
    if (
      b.type === 'CHECKBOX' &&
      !b.text &&
      last?.type === 'CHECKBOX' &&
      !last.text
    )
      continue;
    result.push(b);
  }
  return result;
}

export function toPlainText(blocks: NoteBlock[]): string {
  return blocks
    .map((b, i) => {
      const pad = '  '.repeat(Math.max(0, b.indent));
      switch (b.type) {
        case 'CHECKBOX':
          return `${pad}- [${b.checked ? 'x' : ' '}] ${b.text}`;
        case 'BULLET':
          return `${pad}• ${b.text}`;
        case 'NUMBERED':
          return `${pad}${numberedIndexInRun(blocks, i)}. ${b.text}`;
        default:
          return `${pad}${b.text}`;
      }
    })
    .join('\n');
}

export function ensureWritableTail(blocks: NoteBlock[]): NoteBlock[] {
  if (!blocks.length) return [block('TEXT', '')];
  if (blocks[blocks.length - 1].type !== 'TEXT')
    return [...blocks, block('TEXT', '')];
  return blocks;
}
