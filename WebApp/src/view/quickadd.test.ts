import { describe, expect, it } from 'vitest';
import { clampPanelHeight, clipboardHint, cornerVector, parseCorner, parsePriorityParam, parseQuickAddParams } from '../lib/quickAddParams';

describe('Quick Add address parameters', () => {
  it('reads ?text= as title, further lines as notes', () => {
    const p = parseQuickAddParams('?mode=quickadd&text=' + encodeURIComponent('Call CA tomorrow 5pm\nabout GST\nand TDS'));
    expect(p.text).toBe('Call CA tomorrow 5pm');
    expect(p.notes).toBe('about GST\nand TDS');
  });
  it('handles Windows line endings and blanks', () => {
    const p = parseQuickAddParams(new URLSearchParams({ text: '  Buy milk \r\n\r\n' }));
    expect(p).toMatchObject({ text: 'Buy milk', notes: '' });
  });
  it('reads priorities by number or name, case-insensitively', () => {
    expect(parsePriorityParam('high')).toBe('HIGH');
    expect(parsePriorityParam('HIGH')).toBe('HIGH');
    expect(parsePriorityParam('2')).toBe('MEDIUM');
    expect(parsePriorityParam('low')).toBe('LOW');
    expect(parsePriorityParam('none')).toBe('NONE');
    expect(parsePriorityParam('urgent')).toBeNull();
    expect(parsePriorityParam(null)).toBeNull();
    expect(parseQuickAddParams('?priority=3').priority).toBe('LOW');
    expect(parseQuickAddParams('').priority).toBeNull();
  });
  it('reads the hot corner, defaulting to the centre', () => {
    expect(parseCorner('top-right')).toBe('top-right');
    expect(parseCorner('Bottom_Left')).toBe('bottom-left');
    expect(parseCorner('middle')).toBe('center');
    expect(parseCorner(undefined)).toBe('center');
    expect(parseQuickAddParams('?from=top-left').from).toBe('top-left');
  });
  it('gives each corner an entrance vector pointing inward', () => {
    expect(cornerVector('top-left')).toEqual({ fx: expect.any(Number), fy: expect.any(Number) });
    expect(cornerVector('top-left').fx).toBeLessThan(0);
    expect(cornerVector('top-right').fx).toBeGreaterThan(0);
    expect(cornerVector('bottom-left').fy).toBeGreaterThan(0);
    expect(cornerVector('top-right').fy).toBeLessThan(0);
    expect(cornerVector('center').fx).toBe(0);
  });
});

describe('panel height clamp', () => {
  const o = { min: 120, max: 640, margin: 16 };
  it('adds both margins and rounds up', () => {
    expect(clampPanelHeight(200.2, o)).toBe(233);
  });
  it('never goes below the minimum or above the maximum', () => {
    expect(clampPanelHeight(10, o)).toBe(120);
    expect(clampPanelHeight(5000, o)).toBe(640);
  });
});

describe('clipboard ghost hint', () => {
  it('offers a short single line', () => {
    expect(clipboardHint('  Renew passport ', [], 120)).toBe('Renew passport');
  });
  it('rejects empty, multi-line and long text', () => {
    expect(clipboardHint('', [], 120)).toBeNull();
    expect(clipboardHint(null, [], 120)).toBeNull();
    expect(clipboardHint('a\nb', [], 120)).toBeNull();
    expect(clipboardHint('x'.repeat(120), [], 120)).toBeNull();
    expect(clipboardHint('x'.repeat(119), [], 120)).toBe('x'.repeat(119));
  });
  it('rejects text that already is a task', () => {
    expect(clipboardHint('Buy milk', ['buy milk ', 'Other'], 120)).toBeNull();
    expect(clipboardHint('Buy milk', ['Other'], 120)).toBe('Buy milk');
  });
});
