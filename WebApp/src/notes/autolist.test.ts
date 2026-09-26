import { describe, expect, it } from 'vitest';
import {
  blocksFromLines,
  convertAtCaret,
  detectPrefix,
  looksLikeList,
  mergeBlocks,
  splitListItemAt,
  splitTextBlockAt
} from './autolist';
import { fromStorage, imageBlock, imageIdOf, makeBlock, parseLegacyLine, toPlainText, toStorage, type NoteBlock } from './codec';
import { adjustSpansForEdit } from './span-utils';

const text = (t: string, spans: NoteBlock['spans'] = []): NoteBlock => ({ ...makeBlock('TEXT', t), id: 'orig', spans });

// Same cases as Android's NotesAutoListTest.kt.
describe('detectPrefix', () => {
  it('numbered: "1. " and "1) "', () => {
    expect(detectPrefix('1. Buy milk')).toEqual({ type: 'NUMBERED', rest: 'Buy milk' });
    expect(detectPrefix('12) Buy milk')).toEqual({ type: 'NUMBERED', rest: 'Buy milk' });
    expect(detectPrefix('  3. indented')).toEqual({ type: 'NUMBERED', rest: 'indented' });
  });
  it('bullets: "- ", "* ", "+ ", "• "', () => {
    for (const p of ['- ', '* ', '+ ', '• ']) expect(detectPrefix(`${p}x`)).toEqual({ type: 'BULLET', rest: 'x' });
  });
  it('checkboxes: "[ ] ", "[x] ", "[] ", "- [ ] ", "* [X] "', () => {
    expect(detectPrefix('[ ] a')).toEqual({ type: 'CHECKBOX', checked: false, rest: 'a' });
    expect(detectPrefix('[x] a')).toEqual({ type: 'CHECKBOX', checked: true, rest: 'a' });
    expect(detectPrefix('[] a')).toEqual({ type: 'CHECKBOX', checked: false, rest: 'a' });
    expect(detectPrefix('- [ ] a')).toEqual({ type: 'CHECKBOX', checked: false, rest: 'a' });
    expect(detectPrefix('* [X] a')).toEqual({ type: 'CHECKBOX', checked: true, rest: 'a' });
  });
  it('needs the space; plain text stays text', () => {
    expect(detectPrefix('-nope')).toBeNull();
    expect(detectPrefix('1.5 litres')).toBeNull();
    expect(detectPrefix('[x]done')).toBeNull();
    expect(detectPrefix('hello - world')).toBeNull();
    expect(detectPrefix('')).toBeNull();
  });
  it('an empty rest is still a prefix (just typed "- ")', () => {
    expect(detectPrefix('- ')).toEqual({ type: 'BULLET', rest: '' });
    expect(detectPrefix('1. ')).toEqual({ type: 'NUMBERED', rest: '' });
  });
});

describe('looksLikeList', () => {
  it('two prefixed lines', () => expect(looksLikeList(['1. a', '2. b'])).toBe(true));
  it('60 % rule', () => {
    expect(looksLikeList(['- a', '- b', 'c'])).toBe(true); // 66 %
    expect(looksLikeList(['- a', 'b', 'c'])).toBe(false); // 33 %
    expect(looksLikeList(['- a', '- b', 'c', 'd', 'e'])).toBe(false); // 40 %
  });
  it('blank lines are ignored; a single line is never a list', () => {
    expect(looksLikeList(['- a', '', '- b', ''])).toBe(true);
    expect(looksLikeList(['- a'])).toBe(false);
    expect(looksLikeList([])).toBe(false);
  });
});

describe('splitTextBlockAt', () => {
  it('middle line → TEXT, item, TEXT', () => {
    const out = splitTextBlockAt(text('intro\n- item\noutro'), 1, 'BULLET');
    expect(out.map((b) => [b.type, b.text])).toEqual([
      ['TEXT', 'intro'],
      ['BULLET', 'item'],
      ['TEXT', 'outro']
    ]);
    expect(out[0].id).toBe('orig');
    expect(out[1].id).not.toBe('orig');
  });
  it('first line keeps the id; empties dropped', () => {
    const out = splitTextBlockAt(text('1. only\nafter'), 0, 'NUMBERED');
    expect(out.map((b) => [b.type, b.text])).toEqual([
      ['NUMBERED', 'only'],
      ['TEXT', 'after']
    ]);
    expect(out[0].id).toBe('orig');
  });
  it('last line', () => {
    const out = splitTextBlockAt(text('a\n[x] done'), 1, 'CHECKBOX', true);
    expect(out.map((b) => [b.type, b.text])).toEqual([
      ['TEXT', 'a'],
      ['CHECKBOX', 'done']
    ]);
    expect(out[1].checked).toBe(true);
  });
  it('carries spans to the right part', () => {
    // "bold\n- it" → bold[0,4) stays on the TEXT part, the item's "it" gets [0,2)
    const out = splitTextBlockAt(
      text('bold\n- it', [
        { start: 0, end: 4, bold: true, underline: false },
        { start: 7, end: 9, bold: false, underline: true }
      ]),
      1,
      'BULLET'
    );
    expect(out[0].spans).toEqual([{ start: 0, end: 4, bold: true, underline: false }]);
    expect(out[1].spans).toEqual([{ start: 0, end: 2, bold: false, underline: true }]);
  });
  it('inherits indent and style', () => {
    const b = { ...text('- a'), indent: 2, bold: true, localScale: 1.2 };
    const [item] = splitTextBlockAt(b, 0, 'BULLET');
    expect(item.indent).toBe(2);
    expect(item.bold).toBe(true);
    expect(item.localScale).toBe(1.2);
  });
});

describe('convertAtCaret', () => {
  it('single-line block converts in place (same id, prefix stripped)', () => {
    const c = convertAtCaret(text('- '), 2);
    expect(c).not.toBeNull();
    expect(c!.blocks).toHaveLength(1);
    expect(c!.blocks[0]).toMatchObject({ id: 'orig', type: 'BULLET', text: '' });
    expect(c!.focusId).toBe('orig');
  });
  it('multi-line block: the caret line becomes the item, the rest stays TEXT', () => {
    const t = 'first line\n1. \nlast';
    const c = convertAtCaret(text(t), t.indexOf('1. ') + 3);
    expect(c!.blocks.map((b) => [b.type, b.text])).toEqual([
      ['TEXT', 'first line'],
      ['NUMBERED', ''],
      ['TEXT', 'last']
    ]);
    expect(c!.focusId).toBe(c!.blocks[1].id);
  });
  it('only fires when the caret is right after the prefix', () => {
    expect(convertAtCaret(text('- abc'), 5)).toBeNull(); // typing at the end of an old "- " line
    expect(convertAtCaret(text('- abc'), 2)).not.toBeNull();
    expect(convertAtCaret(text('abc'), 3)).toBeNull();
  });
  it('checkbox with text after the caret keeps that text in the item', () => {
    const c = convertAtCaret(text('[ ] rest'), 4);
    expect(c!.blocks[0]).toMatchObject({ type: 'CHECKBOX', text: 'rest', checked: false });
  });
  it('never converts a list block', () => {
    expect(convertAtCaret({ ...text('- '), type: 'BULLET' }, 2)).toBeNull();
  });
});

describe('splitListItemAt / mergeBlocks', () => {
  it('Enter in the middle of an item moves the tail to a new item of the same type', () => {
    const item = { ...text('hello world'), type: 'BULLET' as const, indent: 1 };
    const [head, tail] = splitListItemAt(item, 5);
    expect(head).toMatchObject({ id: 'orig', type: 'BULLET', text: 'hello' });
    expect(tail).toMatchObject({ type: 'BULLET', text: ' world', indent: 1 });
    expect(tail.id).not.toBe('orig');
  });
  it('Enter at the end gives an empty next item', () => {
    const [, tail] = splitListItemAt({ ...text('a'), type: 'NUMBERED' }, 1);
    expect(tail.text).toBe('');
  });
  it('merge puts the caret at the join and shifts spans', () => {
    const prev = text('ab');
    const cur = { ...text('cd', [{ start: 0, end: 2, bold: true, underline: false }]), id: 'cur' };
    const { block, caret } = mergeBlocks(prev, cur);
    expect(block.text).toBe('abcd');
    expect(caret).toBe(2);
    expect(block.spans).toEqual([{ start: 2, end: 4, bold: true, underline: false }]);
  });
  it('merging multi-line text into a list item flattens the line breaks', () => {
    const prev = { ...text('item'), type: 'BULLET' as const };
    expect(mergeBlocks(prev, text('x\ny')).block.text).toBe('itemx y');
  });
});

describe('blocksFromLines (list-like paste)', () => {
  it('type per line, TEXT for a plain line, blanks dropped', () => {
    const out = blocksFromLines(['1. a', '', '2) b', 'note', '[x] c  '], text(''));
    expect(out.map((b) => [b.type, b.text, b.checked])).toEqual([
      ['NUMBERED', 'a', false],
      ['NUMBERED', 'b', false],
      ['TEXT', 'note', false],
      ['CHECKBOX', 'c', true]
    ]);
  });
});

describe('codec: legacy lines and IMAGE blocks', () => {
  it('parseLegacyLine knows every prefix', () => {
    expect(parseLegacyLine('- [x] a')).toMatchObject({ type: 'CHECKBOX', checked: true, text: 'a' });
    expect(parseLegacyLine('[ ] a')).toMatchObject({ type: 'CHECKBOX', checked: false, text: 'a' });
    expect(parseLegacyLine('[x] a')).toMatchObject({ type: 'CHECKBOX', checked: true, text: 'a' });
    expect(parseLegacyLine('* a')).toMatchObject({ type: 'BULLET', text: 'a' });
    expect(parseLegacyLine('+ a')).toMatchObject({ type: 'BULLET', text: 'a' });
    expect(parseLegacyLine('1) a')).toMatchObject({ type: 'NUMBERED', text: 'a' });
    expect(parseLegacyLine('plain')).toMatchObject({ type: 'TEXT', text: 'plain' });
  });
  it('fromStorage on plain text uses the same rules', () => {
    const b = fromStorage('1. one\n* two\n[ ] three');
    expect(b.map((x) => x.type)).toEqual(['NUMBERED', 'BULLET', 'CHECKBOX']);
  });
  it('IMAGE round-trips and prints [image]', () => {
    const img = imageBlock('0123456789abcdef');
    expect(img.text).toBe('img:0123456789abcdef');
    expect(imageIdOf(img)).toBe('0123456789abcdef');
    const back = fromStorage(toStorage([text('hi'), img]));
    expect(back[1]).toMatchObject({ type: 'IMAGE', text: 'img:0123456789abcdef', id: img.id });
    expect(toPlainText(back)).toBe('hi\n[image]');
    expect(imageIdOf(text('img:x'))).toBeNull();
  });
  it('unknown block types become TEXT instead of breaking the note', () => {
    const raw = JSON.stringify({ blocks: [{ id: 'a', type: 'HOLOGRAM', text: 'keep me' }] });
    expect(fromStorage(raw)[0]).toMatchObject({ type: 'TEXT', text: 'keep me' });
  });
});

describe('adjustSpansForEdit', () => {
  const bold = (s: number, e: number) => ({ start: s, end: e, bold: true, underline: false });
  it('typing after a span leaves it', () => {
    expect(adjustSpansForEdit('ab', 'abc', [bold(0, 2)])).toEqual([bold(0, 2)]);
  });
  it('typing before a span shifts it', () => {
    expect(adjustSpansForEdit('ab', 'xab', [bold(0, 2)])).toEqual([bold(1, 3)]);
  });
  it('typing inside a span grows it', () => {
    expect(adjustSpansForEdit('abcd', 'abXcd', [bold(0, 4)])).toEqual([bold(0, 5)]);
  });
  it('deleting a whole span removes it', () => {
    expect(adjustSpansForEdit('a bold c', 'a  c', [bold(2, 6)])).toEqual([]);
  });
});
