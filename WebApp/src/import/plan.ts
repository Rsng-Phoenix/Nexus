import { DEFAULT_DUE_ALERT_TIME, clampAlertTime, formatDueAlerts } from '../calendar/due';
import type { Priority } from '../types';
import { type Cell, columnLetter, isEmptyCell, isEmptyRow } from './cell';
import { parseCellDate } from './dates';
import { deterministicUuid } from './hash';

/**
 * Turns a parsed sheet plus the user's column choices into task rows for the Excel/CSV import
 * (spec 3.7 §4). Mirrors Android's ImportPlanner so both apps derive the same uuids:
 *
 *   taskUuid = "xl-" + first 24 hex of SHA-256(UTF-8(fileName + "\u001f" + sheetName + "\u001f"
 *              + title + "\u001f" + dueDate))
 *
 * - fileName: the picked file's name as-is, extension included ("Filings 2026.xlsx").
 * - sheetName: the xlsx sheet name; "" for .csv/.tsv.
 * - title: the title cells' text, each trimmed, empty ones dropped, joined with " · "
 *   (space, U+00B7, space). Cell text: strings as-is; integers without a decimal point ("12"),
 *   other numbers in shortest round-trip form ("1.5"); booleans "TRUE"/"FALSE"; date-formatted
 *   numbers as their ISO day.
 * - dueDate: ISO YYYY-MM-DD.
 * Rows with the same uuid (same title and date) after the first are counted as duplicates and
 * skipped. Rows that are entirely empty are skipped silently; rows with no title or no valid
 * date are reported in `invalid` (spec: never silently).
 */
export const IMPORT_UUID_PREFIX = 'xl-';
export const TITLE_JOINER = ' · ';

export type ImportPriority = Priority | { col: number; fallback?: Priority };

export type ImportPlanInput = {
  fileName: string;
  sheetName: string;
  rows: Cell[][];
  /** Index of the header row, or -1 when the sheet has none. Data starts on the next row. */
  headerRow: number;
  titleCols: number[];
  dateCol: number;
  notesCols?: number[];
  priority: ImportPriority;
  offsets: number[];
  alertTime?: number;
  dayFirst?: boolean;
  date1904?: boolean;
  /** Uuids already on this device; matching items are flagged `exists` (re-import = update). */
  existingUuids?: ReadonlySet<string>;
};

export type ImportItem = {
  taskUuid: string;
  description: string;
  notes: string;
  priority: Priority;
  dueDate: string;
  dueAlerts: string;
  dueAlertTime: number;
  /** Zero-based row index in the sheet. */
  rowIndex: number;
  exists: boolean;
};

export type ImportInvalidRow = { rowIndex: number; reason: string };

export type ImportPlan = { items: ImportItem[]; invalid: ImportInvalidRow[]; duplicates: number };

const PRIORITY_WORDS: Record<string, Priority> = {
  high: 'HIGH', h: 'HIGH', '1': 'HIGH', p1: 'HIGH', urgent: 'HIGH', important: 'HIGH',
  medium: 'MEDIUM', med: 'MEDIUM', m: 'MEDIUM', '2': 'MEDIUM', p2: 'MEDIUM',
  low: 'LOW', l: 'LOW', '3': 'LOW', p3: 'LOW',
  none: 'NONE', n: 'NONE', '4': 'NONE', p4: 'NONE'
};

/**
 * Priority cell text → Priority, case-insensitive: High/Medium/Low/None, H/M/L/N, 1–4, P1–P4,
 * urgent/important → HIGH. Anything else → null (caller falls back).
 */
export function parsePriorityText(text: string): Priority | null {
  return PRIORITY_WORDS[text.trim().toLowerCase()] ?? null;
}

export function numberText(n: number): string {
  return String(n);
}

export function cellText(cell: Cell | undefined, opts: { date1904?: boolean } = {}): string {
  if (!cell || cell.v === null) return '';
  const v = cell.v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (cell.date) return parseCellDate(cell, opts) ?? numberText(v);
    return numberText(v);
  }
  return v;
}

function headerName(rows: Cell[][], headerRow: number, col: number): string {
  const h = headerRow >= 0 ? cellText(rows[headerRow]?.[col]).trim() : '';
  return h || `Column ${columnLetter(col)}`;
}

export async function importTaskUuid(
  fileName: string,
  sheetName: string,
  title: string,
  dueDate: string
): Promise<string> {
  return deterministicUuid(IMPORT_UUID_PREFIX, [fileName, sheetName, title, dueDate]);
}

export async function buildImportPlan(input: ImportPlanInput): Promise<ImportPlan> {
  const { rows, headerRow, titleCols, dateCol } = input;
  const notesCols = input.notesCols ?? [];
  const dateOpts = { dayFirst: input.dayFirst, date1904: input.date1904 };
  const dueAlerts = formatDueAlerts(input.offsets);
  const dueAlertTime = clampAlertTime(input.alertTime ?? DEFAULT_DUE_ALERT_TIME);
  const fixedPriority: Priority =
    typeof input.priority === 'string' ? input.priority : (input.priority.fallback ?? 'NONE');
  const priorityCol = typeof input.priority === 'string' ? -1 : input.priority.col;

  const items: ImportItem[] = [];
  const invalid: ImportInvalidRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (let r = Math.max(0, headerRow + 1); r < rows.length; r++) {
    const row = rows[r];
    if (isEmptyRow(row)) continue;
    const title = titleCols
      .map((c) => cellText(row[c], dateOpts).trim())
      .filter((t) => t !== '')
      .join(TITLE_JOINER);
    if (!title) {
      invalid.push({ rowIndex: r, reason: 'No title' });
      continue;
    }
    const dateCell = row[dateCol];
    const dueDate = parseCellDate(dateCell, dateOpts);
    if (!dueDate) {
      const raw = cellText(dateCell).trim();
      invalid.push({ rowIndex: r, reason: raw ? `Not a date: "${raw}"` : 'No date' });
      continue;
    }
    const taskUuid = await importTaskUuid(input.fileName, input.sheetName, title, dueDate);
    if (seen.has(taskUuid)) {
      duplicates++;
      continue;
    }
    seen.add(taskUuid);

    const notes = notesCols
      .filter((c) => !isEmptyCell(row[c]))
      .map((c) => `${headerName(rows, headerRow, c)}: ${cellText(row[c], dateOpts).trim()}`)
      .join('\n');
    const priority =
      (priorityCol >= 0 ? parsePriorityText(cellText(row[priorityCol])) : null) ?? fixedPriority;

    items.push({
      taskUuid,
      description: title,
      notes,
      priority,
      dueDate,
      dueAlerts,
      dueAlertTime,
      rowIndex: r,
      exists: input.existingUuids?.has(taskUuid) ?? false
    });
  }
  return { items, invalid, duplicates };
}
