/**
 * One spreadsheet cell as read from .xlsx or .csv. `date` is set when the xlsx cell's number
 * format is a date format (or the cell is an OOXML `t="d"` ISO date), so an Excel serial can be
 * told apart from a plain number.
 */
export type Cell = { v: string | number | boolean | null; date?: boolean };

/** Safety caps shared by the xlsx and csv readers (spec 3.7 §4: up to 5,000 rows). */
export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_COLS = 200;

export const EMPTY_CELL: Cell = Object.freeze({ v: null }) as Cell;

export function isEmptyCell(c: Cell | undefined | null): boolean {
  if (!c || c.v === null) return true;
  return typeof c.v === 'string' && c.v.trim() === '';
}

export function isEmptyRow(row: Cell[] | undefined): boolean {
  return !row || row.every(isEmptyCell);
}

/** "A" → 0, "Z" → 25, "AA" → 26. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
