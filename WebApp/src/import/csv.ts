import { type Cell, IMPORT_MAX_COLS, IMPORT_MAX_ROWS } from './cell';

/**
 * RFC 4180 CSV/TSV parser: quoted fields, "" escapes, CRLF / LF / CR line ends, UTF-8 BOM, and
 * delimiter auto-detection among , ; \t |. Lenient like spreadsheet apps: an unterminated quote
 * runs to the end of the file, text after a closing quote is kept.
 */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];
export type CsvOptions = { delimiter?: CsvDelimiter; maxRows?: number; maxCols?: number };
export type CsvResult = { rows: string[][]; delimiter: CsvDelimiter; truncated: boolean };

const SNIFF_LINES = 20;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Per-line delimiter counts outside quotes for the first few lines. */
function sniffCounts(text: string, delim: string): number[] {
  const counts: number[] = [];
  let n = 0;
  let quoted = false;
  for (let i = 0; i < text.length && counts.length < SNIFF_LINES; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === delim) n++;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      counts.push(n);
      n = 0;
    }
  }
  if (counts.length < SNIFF_LINES && n > 0) counts.push(n);
  return counts;
}

/**
 * The delimiter that appears the same (non-zero) number of times on the most lines; ties go to
 * the earlier one in , ; \t | order. A file with none of them is one column of ','.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const body = stripBom(text);
  let best: CsvDelimiter = ',';
  let bestScore = 0;
  for (const d of CSV_DELIMITERS) {
    const counts = sniffCounts(body, d);
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    let score = 0;
    for (const [perLine, lines] of freq) score = Math.max(score, lines * 1000 + Math.min(perLine, 999));
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export function parseCsv(text: string, opts: CsvOptions = {}): CsvResult {
  const body = stripBom(text);
  const delimiter = opts.delimiter ?? detectDelimiter(body);
  const maxRows = opts.maxRows ?? IMPORT_MAX_ROWS;
  const maxCols = opts.maxCols ?? IMPORT_MAX_COLS;
  const rows: string[][] = [];
  let truncated = false;
  let row: string[] = [];
  let field = '';
  let quotedField = false;
  let i = 0;
  const n = body.length;

  const endField = () => {
    if (row.length < maxCols) row.push(field);
    else truncated = true;
    field = '';
    quotedField = false;
  };
  const endRow = (): boolean => {
    endField();
    rows.push(row);
    row = [];
    if (rows.length >= maxRows) {
      truncated = truncated || i < n;
      return false;
    }
    return true;
  };

  while (i < n) {
    const ch = body[i];
    if (ch === '"' && field === '' && !quotedField) {
      // Quoted field: runs to the next lone quote; "" is a literal quote.
      quotedField = true;
      i++;
      for (;;) {
        const q = body.indexOf('"', i);
        if (q < 0) {
          field += body.slice(i);
          i = n;
          break;
        }
        field += body.slice(i, q);
        if (body[q + 1] === '"') {
          field += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
    } else if (ch === '\n' || ch === '\r') {
      i += ch === '\r' && body[i + 1] === '\n' ? 2 : 1;
      if (!endRow()) break;
    } else {
      field += ch;
      i++;
    }
  }
  if (i >= n && (field !== '' || quotedField || row.length > 0)) {
    if (rows.length < maxRows) endRow();
    else truncated = true;
  }
  return { rows, delimiter, truncated };
}

/** CSV strings as import cells: blank fields become empty cells. */
export function csvRowsToCells(rows: string[][]): Cell[][] {
  return rows.map((r) => r.map((v) => ({ v: v.trim() === '' ? null : v })));
}
