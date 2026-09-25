import { describe, expect, it } from 'vitest';
import type { Cell } from './cell';
import {
  detectDayFirst,
  detectHeaderRow,
  excelSerialToIso,
  firstNonEmptyRow,
  parseCellDate,
  parseDateString,
  suggestDateColumn
} from './dates';

const c = (v: Cell['v'], date?: boolean): Cell => (date ? { v, date } : { v });

describe('excel serials', () => {
  it('1900 system with the Lotus leap-year bug', () => {
    expect(excelSerialToIso(1)).toBe('1900-01-01');
    expect(excelSerialToIso(59)).toBe('1900-02-28');
    expect(excelSerialToIso(60)).toBeNull(); // fake 29 Feb 1900
    expect(excelSerialToIso(61)).toBe('1900-03-01');
    expect(excelSerialToIso(45658)).toBe('2025-01-01');
    expect(excelSerialToIso(46300)).toBe('2026-10-05');
    expect(excelSerialToIso(46300.999)).toBe('2026-10-05');
    expect(excelSerialToIso(46300.999999999)).toBe('2026-10-06'); // float noise for midnight
    expect(excelSerialToIso(0)).toBeNull();
    expect(excelSerialToIso(-5)).toBeNull();
    expect(excelSerialToIso(0.5)).toBeNull(); // time only
  });

  it('1904 system', () => {
    expect(excelSerialToIso(0, true)).toBe('1904-01-01');
    expect(excelSerialToIso(44838, true)).toBe('2026-10-05');
    expect(parseCellDate(c(44838, true), { date1904: true })).toBe('2026-10-05');
  });

  it('plain numbers: serial range or yyyymmdd only', () => {
    expect(parseCellDate(c(46300))).toBe('2026-10-05');
    expect(parseCellDate(c(20261005))).toBe('2026-10-05');
    expect(parseCellDate(c(3))).toBeNull();
    expect(parseCellDate(c(1000000))).toBeNull();
    expect(parseCellDate(c(3, true))).toBe('1900-01-03');
    expect(parseCellDate(c(true))).toBeNull();
    expect(parseCellDate(null)).toBeNull();
  });
});

describe('date strings', () => {
  const cases: [string, string | null][] = [
    ['2026-10-05', '2026-10-05'],
    ['2026-10-05T09:30:00Z', '2026-10-05'],
    ['2026-10-05 09:30', '2026-10-05'],
    ['2026/10/5', '2026-10-05'],
    ['2026.10.05', '2026-10-05'],
    ['20261005', '2026-10-05'],
    ['05/10/2026', '2026-10-05'],
    ['5-10-2026', '2026-10-05'],
    ['5.10.2026', '2026-10-05'],
    ['05/10/26', '2026-10-05'],
    ['05/10/69', '2069-10-05'],
    ['05/10/70', '1970-10-05'],
    ['13/01/2026', '2026-01-13'],
    ['5 Oct 2026', '2026-10-05'],
    ['5th October 2026', '2026-10-05'],
    ['5 of October, 2026', '2026-10-05'],
    ['Oct 5, 2026', '2026-10-05'],
    ['October 5th, 2026 10:00 AM', '2026-10-05'],
    ['Sept 5 2026', '2026-09-05'],
    ['5-Oct-26', '2026-10-05'],
    ['05-oct-2026', '2026-10-05'],
    ['Monday, 5 October 2026', '2026-10-05'],
    ['Mon 5 Oct 2026 14:00', '2026-10-05'],
    ['Thursday, October 1, 2026', '2026-10-01'],
    ['  5 Oct 2026  ', '2026-10-05'],
    ['31/02/2026', null],
    ['2026-02-29', null],
    ['2028-02-29', '2028-02-29'],
    ['5 Foo 2026', null],
    ['Oct 2026', null],
    ['hello', null],
    ['', null],
    ['12345', null],
    ['1/2/3/4', null],
    ['5/10/2026/7', null]
  ];
  for (const [input, want] of cases) {
    it(`"${input}" → ${want}`, () => expect(parseCellDate(input)).toBe(want));
  }

  it('dayFirst picks the order for ambiguous values and falls back when impossible', () => {
    expect(parseCellDate('05/10/2026', { dayFirst: true })).toBe('2026-10-05');
    expect(parseCellDate('05/10/2026', { dayFirst: false })).toBe('2026-05-10');
    expect(parseCellDate('10/13/2026', { dayFirst: true })).toBe('2026-10-13');
    expect(parseCellDate('13/10/2026', { dayFirst: false })).toBe('2026-10-13');
    // Dots are always day first.
    expect(parseCellDate('05.10.2026', { dayFirst: false })).toBe('2026-10-05');
    expect(parseCellDate(c('2026-10-05', true))).toBe('2026-10-05');
  });
});

describe('detectDayFirst', () => {
  it('decides from unambiguous values', () => {
    expect(detectDayFirst(['01/02/2026', '13/02/2026', '05/10/2026'])).toBe(true);
    expect(detectDayFirst(['01/02/2026', '02/13/2026', '10/05/2026'])).toBe(false);
  });
  it('reports ambiguity when every value works both ways', () => {
    expect(detectDayFirst(['01/02/2026', '03/04/2026'])).toBe('ambiguous');
  });
  it('mixed columns go to the majority, ties are ambiguous', () => {
    expect(detectDayFirst(['13/01/2026', '14/01/2026', '01/13/2026'])).toBe(true);
    expect(detectDayFirst(['13/01/2026', '01/13/2026'])).toBe('ambiguous');
  });
  it('ignores non-numeric and dotted values', () => {
    expect(detectDayFirst(['5 Oct 2026', '2026-10-05', 'x', '05.10.2026'])).toBe(true);
    expect(detectDayFirst([])).toBe(true);
  });
});

describe('column + header detection', () => {
  const rows: Cell[][] = [
    [c(null), c(null)],
    [c('Task'), c('Amount'), c('Created'), c('Due date'), c('Notes')],
    [c('GST'), c(30000), c('2026-01-01'), c(46300, true), c('x')],
    [c('TDS'), c(40000), c('2026-01-02'), c('07/10/2026'), c(null)],
    [c('ROC'), c(45000), c(null), c('bad'), c('y')]
  ];

  it('finds the first non-empty row as header when it reads like one', () => {
    expect(firstNonEmptyRow(rows)).toBe(1);
    expect(detectHeaderRow(rows)).toBe(1);
    expect(detectHeaderRow(rows.slice(2))).toBe(-1); // starts with data
    expect(detectHeaderRow([[c(null)]])).toBe(-1);
  });

  it('suggests the column with most dates, preferring date-like headers', () => {
    // "Created" and "Due date" both have 2 dates; the header hint wins. Amounts count half.
    expect(suggestDateColumn(rows, 1)).toBe(3);
    const noHints: Cell[][] = rows.map((r, i) => (i === 1 ? r.map((_, j) => c(`c${j}`)) : r));
    expect(suggestDateColumn(noHints, 1)).toBe(2);
    expect(suggestDateColumn([[c('a')], [c('b')]], 0)).toBe(-1);
  });
});

describe('dates without a year', () => {
  const sept25 = Date.UTC(2026, 8, 25);
  it('reads "24th Sep", "19th sep", "Sep 24" as the nearest such day', () => {
    expect(parseDateString('24th Sep', true, sept25)).toBe('2026-09-24');
    expect(parseDateString('19th sep', true, sept25)).toBe('2026-09-19');
    expect(parseDateString('23rd Sep', true, sept25)).toBe('2026-09-23');
    expect(parseDateString('Sep 24', true, sept25)).toBe('2026-09-24');
    expect(parseDateString('1 October', true, sept25)).toBe('2026-10-01');
    expect(parseDateString('2nd Jan', true, sept25)).toBe('2027-01-02'); // next January is nearer
    expect(parseDateString('10th Aug', true, Date.UTC(2027, 0, 5))).toBe('2026-08-10'); // last August is nearer
  });
  it('still refuses text that only contains a date-like word', () => {
    expect(parseDateString('24th Sep pending', true, sept25)).toBeNull();
    expect(parseDateString('May', true, sept25)).toBeNull();
    expect(parseDateString('31st Feb', true, sept25)).toBeNull();
  });
});
