import { describe, expect, it } from 'vitest';
import { fuzzyScore, rankFuzzy } from './fuzzy';

describe('fuzzyScore', () => {
  it('empty query matches everything with a flat score', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('   ', 'anything')).toBe(0);
  });

  it('substrings beat scattered letters, and the start of the text beats the middle', () => {
    const start = fuzzyScore('call', 'call CA')!;
    const word = fuzzyScore('call', 'morning call with CA')!;
    const inside = fuzzyScore('call', 'recall the order')!;
    const scattered = fuzzyScore('call', 'clean all the things')!;
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(scattered);
  });

  it('needs every letter, in order', () => {
    expect(fuzzyScore('cca', 'call CA')).not.toBeNull();
    expect(fuzzyScore('acc', 'call CA')).toBeNull();
    expect(fuzzyScore('xyz', 'call CA')).toBeNull();
  });

  it('ignores case and accents; spaces in the query are free', () => {
    expect(fuzzyScore('CALL ca', 'call CA')).toBe(fuzzyScore('call ca', 'call CA'));
    expect(fuzzyScore('cafe', 'Café run')).not.toBeNull();
    expect(fuzzyScore('c a', 'call CA')).not.toBeNull();
  });
});

describe('rankFuzzy', () => {
  const items = ['clean all the things', 'call CA', 'Calendar', 'buy milk', 'recall the order'];

  it('returns matches best first and drops the rest', () => {
    expect(rankFuzzy('call', items, (s) => s)).toEqual(['call CA', 'recall the order', 'clean all the things']);
    expect(rankFuzzy('cal ca', items, (s) => s)[0]).toBe('call CA');
  });

  it('keeps the original order on ties and honours the limit', () => {
    expect(rankFuzzy('', items, (s) => s)).toEqual(items);
    expect(rankFuzzy('', items, (s) => s, 2)).toEqual(items.slice(0, 2));
  });
});
