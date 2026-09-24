import { describe, expect, it } from 'vitest';
import { csvRowsToCells, detectDelimiter, parseCsv } from './csv';

describe('parseCsv', () => {
  it('parses quotes, escaped quotes, embedded delimiters and newlines', () => {
    const { rows, delimiter } = parseCsv('a,"b,c","say ""hi""","line1\nline2"\r\n1,2,3,4\n');
    expect(delimiter).toBe(',');
    expect(rows).toEqual([
      ['a', 'b,c', 'say "hi"', 'line1\nline2'],
      ['1', '2', '3', '4']
    ]);
  });

  it('strips a UTF-8 BOM and handles CRLF, LF and lone CR', () => {
    expect(parseCsv('﻿x,y\r\n1,2\n3,4\r5,6').rows).toEqual([['x', 'y'], ['1', '2'], ['3', '4'], ['5', '6']]);
  });

  it('keeps empty fields and blank lines, no phantom last row', () => {
    expect(parseCsv('a,,c\n\n,b,\n').rows).toEqual([['a', '', 'c'], [''], ['', 'b', '']]);
    expect(parseCsv('').rows).toEqual([]);
    expect(parseCsv('"x"').rows).toEqual([['x']]);
    expect(parseCsv('""').rows).toEqual([['']]);
  });

  it('is lenient with an unterminated quote and text after a closing quote', () => {
    expect(parseCsv('"open,field\nstill').rows).toEqual([['open,field\nstill']]);
    expect(parseCsv('"a"b,c').rows).toEqual([['ab', 'c']]);
  });

  it('auto-detects ; tab and | delimiters', () => {
    expect(detectDelimiter('Title;Due;Notes\nGST;05/10/2026;"a, b"\n')).toBe(';');
    expect(detectDelimiter('Title\tDue\nGST, return\t2026-10-05\n')).toBe('\t');
    expect(detectDelimiter('a|b|c\n1|2|3')).toBe('|');
    expect(detectDelimiter('single column\nno delimiters')).toBe(',');
    expect(parseCsv('Title;Due\n"Pay; rent";2026-10-05').rows).toEqual([['Title', 'Due'], ['Pay; rent', '2026-10-05']]);
  });

  it('ignores delimiters inside quotes when detecting', () => {
    expect(detectDelimiter('"a,b,c,d";x\n"e,f,g,h";y\n')).toBe(';');
  });

  it('honours an explicit delimiter and caps rows/cols', () => {
    const tsv = parseCsv('a,b\tc\n', { delimiter: '\t' });
    expect(tsv.rows).toEqual([['a,b', 'c']]);
    const big = parseCsv('1\n2\n3\n4\n', { maxRows: 2 });
    expect(big.rows).toEqual([['1'], ['2']]);
    expect(big.truncated).toBe(true);
    const wide = parseCsv('1,2,3,4', { maxCols: 2 });
    expect(wide.rows).toEqual([['1', '2']]);
    expect(wide.truncated).toBe(true);
    expect(parseCsv('1\n2\n', { maxRows: 2 }).truncated).toBe(false);
  });

  it('converts to cells with blanks as empty', () => {
    expect(csvRowsToCells([['a', ' ', '']])).toEqual([[{ v: 'a' }, { v: null }, { v: null }]]);
  });
});
