import { type Cell, isEmptyCell, isEmptyRow } from './cell';

/**
 * Date recognition for the Excel/CSV import (spec 3.7 §4). Everything resolves to an ISO
 * `YYYY-MM-DD` calendar day; any time part is ignored.
 *
 * Accepted: Excel serials (1900 system with Lotus' fake 29 Feb 1900, and the 1904 system),
 * ISO / yyyy-mm-dd / yyyy/mm/dd / yyyy.mm.dd, yyyymmdd, dd/mm/yyyy and mm/dd/yyyy (also with "-"),
 * d.m.yyyy (always day first), 2-digit years (< 70 → 20xx, else 19xx), "5 Oct 2026",
 * "Oct 5, 2026", "5-Oct-26", "Monday, 5 October 2026", ordinals ("5th").
 *
 * Numeric d/m ambiguity: `dayFirst` picks the order (default true, as in most of the world);
 * if that order gives an impossible date but the other works, the other is used.
 */
export type DateOpts = { dayFirst?: boolean; date1904?: boolean };

const MIN_YEAR = 1900;
const MAX_YEAR = 2200;
const DAY_MS = 86_400_000;
/** Plain (unformatted) numbers are read as serials only inside 1970-01-01 … 2099-12-31. */
const PLAIN_SERIAL_MIN = 25569;
const PLAIN_SERIAL_MAX = 73050;
/** Excel stores 00:00 as e.g. 45000.99999999; nudge before flooring. */
const SERIAL_EPSILON = 1e-8;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const TAIL = '(?=$|[T\\s,])';
const RE_YMD = new RegExp(`^(\\d{4})([-/.])(\\d{1,2})\\2(\\d{1,2})${TAIL}`);
const RE_COMPACT = /^(\d{4})(\d{2})(\d{2})$/;
const RE_NUMERIC = new RegExp(`^(\\d{1,2})([-/.])(\\d{1,2})\\2(\\d{4}|\\d{2})${TAIL}`);
const RE_D_MON_Y = new RegExp(
  `^(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?[\\s\\-/.]*([a-z]+)\\.?,?[\\s\\-/.]*(\\d{4}|\\d{2})${TAIL}`,
  'i'
);
const RE_MON_D_Y = new RegExp(
  `^([a-z]+)\\.?[\\s\\-/.]*(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*|[\\s\\-/.]+)(\\d{4}|\\d{2})${TAIL}`,
  'i'
);
const RE_WEEKDAY = /^(?:[a-z]+day|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\.?,?\s+/i;
const HEADER_HINT = /date|due|deadline|expir|renew|filing|until|valid|dob|birthday|anniversary/i;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isoFromParts(y: number, m: number, d: number): string | null {
  if (y < MIN_YEAR || y > MAX_YEAR || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function isoFromUtcMs(ms: number): string {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function fullYear(raw: string): number {
  const y = Number(raw);
  if (raw.length !== 2) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

/**
 * Excel serial → ISO day. 1900 system: 1 = 1900-01-01; 60 is Lotus' non-existent 29 Feb 1900
 * (→ null); from 61 on every serial is one day ahead, so subtract one. 1904 system: 0 = 1904-01-01.
 */
export function excelSerialToIso(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial)) return null;
  const day = Math.floor(serial + SERIAL_EPSILON);
  let ms: number;
  if (date1904) {
    if (day < 0) return null;
    ms = Date.UTC(1904, 0, 1) + day * DAY_MS;
  } else {
    if (day < 1 || day === 60) return null;
    ms = Date.UTC(1899, 11, day < 60 ? 31 : 30) + day * DAY_MS;
  }
  const iso = isoFromUtcMs(ms);
  const y = Number(iso.slice(0, 4));
  return y >= MIN_YEAR && y <= MAX_YEAR ? iso : null;
}

function monthNumber(token: string): number | null {
  return MONTHS[token.toLowerCase()] ?? null;
}

function numericDate(a: number, b: number, y: number, dayFirst: boolean): string | null {
  const first = dayFirst ? isoFromParts(y, b, a) : isoFromParts(y, a, b);
  if (first) return first;
  return dayFirst ? isoFromParts(y, a, b) : isoFromParts(y, b, a);
}

export function parseDateString(input: string, dayFirst = true): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(RE_WEEKDAY, '');

  let m = RE_YMD.exec(s);
  if (m) return isoFromParts(Number(m[1]), Number(m[3]), Number(m[4]));
  m = RE_COMPACT.exec(s);
  if (m) return isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]));
  m = RE_NUMERIC.exec(s);
  if (m) {
    const y = fullYear(m[4]);
    // Dotted dates (d.m.yyyy) are day-first everywhere they are used.
    return numericDate(Number(m[1]), Number(m[3]), y, m[2] === '.' ? true : dayFirst);
  }
  m = RE_D_MON_Y.exec(s);
  if (m) {
    const mon = monthNumber(m[2]);
    if (mon) return isoFromParts(fullYear(m[3]), mon, Number(m[1]));
  }
  m = RE_MON_D_Y.exec(s);
  if (m) {
    const mon = monthNumber(m[1]);
    if (mon) return isoFromParts(fullYear(m[3]), mon, Number(m[2]));
  }
  return null;
}

/** A cell (or raw value) as an ISO day, or null when it isn't a recognisable date. */
export function parseCellDate(
  cell: Cell | string | number | boolean | null | undefined,
  opts: DateOpts = {}
): string | null {
  if (cell === null || cell === undefined) return null;
  const c: Cell = typeof cell === 'object' ? cell : { v: cell };
  const v = c.v;
  if (typeof v === 'number') {
    if (c.date) return excelSerialToIso(v, opts.date1904);
    if (Number.isInteger(v) && v >= 19000101 && v <= 22001231) {
      return parseDateString(String(v), opts.dayFirst);
    }
    if (v >= PLAIN_SERIAL_MIN && v <= PLAIN_SERIAL_MAX) return excelSerialToIso(v, opts.date1904);
    return null;
  }
  if (typeof v === 'string') return parseDateString(v, opts.dayFirst ?? true);
  return null;
}

/**
 * Which d/m order fits a column of numeric dates ("05/10/2026", "13-01-26"): true = day first,
 * false = month first, 'ambiguous' when every value works both ways (or neither order wins).
 * Values that aren't numeric slash/dash dates are ignored; with none at all, day first.
 */
export function detectDayFirst(values: string[]): boolean | 'ambiguous' {
  let considered = 0;
  let dmOk = 0;
  let mdOk = 0;
  for (const raw of values) {
    const m = RE_NUMERIC.exec(raw.trim().replace(RE_WEEKDAY, ''));
    if (!m || m[2] === '.') continue;
    considered++;
    const a = Number(m[1]);
    const b = Number(m[3]);
    const y = fullYear(m[4]);
    if (isoFromParts(y, b, a)) dmOk++;
    if (isoFromParts(y, a, b)) mdOk++;
  }
  if (considered === 0) return true;
  if (dmOk === considered && mdOk === considered) return 'ambiguous';
  if (dmOk === considered) return true;
  if (mdOk === considered) return false;
  if (dmOk !== mdOk) return dmOk > mdOk;
  return 'ambiguous';
}

function cellString(c: Cell | undefined): string {
  if (!c || c.v === null) return '';
  return String(c.v).trim();
}

/**
 * Column with the most date-like cells below the header; a header named like a date
 * (date, due, deadline, expiry, renewal, filing, …) adds a bonus. Unformatted numbers that only
 * happen to fall in the serial range count half. -1 when no column has any date.
 */
export function suggestDateColumn(rows: Cell[][], headerRowIndex: number): number {
  const start = headerRowIndex >= 0 ? headerRowIndex + 1 : 0;
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const header = headerRowIndex >= 0 ? rows[headerRowIndex] : undefined;
  let dataRows = 0;
  for (let r = start; r < rows.length; r++) if (!isEmptyRow(rows[r])) dataRows++;
  let best = -1;
  let bestScore = 0;
  for (let c = 0; c < width; c++) {
    let score = 0;
    for (let r = start; r < rows.length; r++) {
      const cell = rows[r][c];
      if (isEmptyCell(cell) || !parseCellDate(cell)) continue;
      score += typeof cell.v === 'number' && !cell.date ? 0.5 : 1;
    }
    if (score > 0 && HEADER_HINT.test(cellString(header?.[c]))) score += Math.max(1, dataRows * 0.2);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

export function firstNonEmptyRow(rows: Cell[][]): number {
  return rows.findIndex((r) => !isEmptyRow(r));
}

/**
 * Header row index: the first non-empty row when it reads like a header (only text, no dates,
 * and more rows follow); -1 when it looks like data, so the import should start at row 0.
 */
export function detectHeaderRow(rows: Cell[][]): number {
  const first = firstNonEmptyRow(rows);
  if (first < 0) return -1;
  const cells = rows[first].filter((c) => !isEmptyCell(c));
  const textOnly = cells.every((c) => typeof c.v === 'string' && !c.date && !parseCellDate(c));
  const hasData = rows.slice(first + 1).some((r) => !isEmptyRow(r));
  return textOnly && hasData ? first : -1;
}
