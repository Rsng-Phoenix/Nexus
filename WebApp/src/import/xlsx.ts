import { type Cell, EMPTY_CELL, IMPORT_MAX_COLS, IMPORT_MAX_ROWS } from './cell';
import { STOP_PARSING, type XmlAttrs, parseXml } from './xml';
import { type ZipArchive, type ZipLimits, readZip } from './zip';

/**
 * Local .xlsx reader for the Excel import (spec 3.7 §4). Reads sheet names, the 1904 date flag,
 * shared strings (rich text runs included, phonetic runs skipped), cell styles (to know which
 * numbers are dates) and every worksheet's cell values. Formulas give their cached value; merged
 * cells, hyperlinks, comments and formatting beyond "is this a date" are ignored.
 */
export type XlsxSheet = { name: string; rows: Cell[][]; hidden: boolean; truncated: boolean };
export type XlsxWorkbook = { sheets: XlsxSheet[]; date1904: boolean };
export type XlsxOptions = ZipLimits & { maxRows?: number; maxCols?: number };

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

const REL_OFFICE_DOC = '/officeDocument';
const REL_SHARED_STRINGS = '/sharedStrings';
const REL_STYLES = '/styles';
const REL_WORKSHEET = '/worksheet';

/** Built-in number formats that Excel renders as dates/times. */
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * True when a custom number format shows a date/time: a d, m, y or h token outside quoted text,
 * [bracket] sections (colours, locales) and escaped characters. Only the first section counts.
 * Elapsed-time formats like "[h]:mm" are durations, not dates.
 */
export function isDateFormat(code: string): boolean {
  let plain = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === ';') break;
    if (ch === '"') {
      const e = code.indexOf('"', i + 1);
      i = e < 0 ? code.length : e;
    } else if (ch === '[') {
      const e = code.indexOf(']', i + 1);
      const inside = code.slice(i + 1, e < 0 ? code.length : e);
      if (/^(h+|m+|s+)$/i.test(inside)) return false;
      i = e < 0 ? code.length : e;
    } else if (ch === '\\' || ch === '_' || ch === '*') {
      i++;
    } else {
      plain += ch;
    }
  }
  return /[dmyh]/i.test(plain);
}

export function isDateNumFmt(id: number, custom: Map<number, string>): boolean {
  const code = custom.get(id);
  if (code !== undefined) return isDateFormat(code);
  return BUILTIN_DATE_FMTS.has(id);
}

/** "AB12" → { row: 11, col: 27 } (zero-based); null for anything else. */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  if (row < 1) return null;
  return { row: row - 1, col: col - 1 };
}

/** OOXML escapes characters XML can't carry as "_xHHHH_" (e.g. "_x000D_" for CR). */
function unescapeOoxml(s: string): string {
  if (!s.includes('_x')) return s;
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function resolvePart(baseDir: string, target: string): string {
  const joined = target.startsWith('/') ? target.slice(1) : baseDir + target;
  const out: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

function relsPathFor(part: string): string {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

type Rel = { id: string; type: string; target: string };

async function readRels(zip: ZipArchive, relsPath: string, baseDir: string): Promise<Rel[]> {
  const xml = await zip.readText(relsPath);
  if (xml === null) return [];
  const rels: Rel[] = [];
  parseXml(xml, {
    open(name, a) {
      if (name === 'Relationship' && a.Target && a.TargetMode !== 'External') {
        rels.push({ id: a.Id ?? '', type: a.Type ?? '', target: resolvePart(baseDir, a.Target) });
      }
    }
  });
  return rels;
}

function relId(a: XmlAttrs): string {
  for (const k of Object.keys(a)) {
    if (/(^|:)id$/.test(k)) return a[k];
  }
  return '';
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  let inSi = false;
  let phonetic = 0;
  let inT = false;
  let cur = '';
  parseXml(xml, {
    open(name) {
      if (name === 'si') {
        inSi = true;
        cur = '';
      } else if (name === 'rPh') phonetic++;
      else if (name === 't' && inSi && phonetic === 0) inT = true;
    },
    close(name) {
      if (name === 'si') {
        out.push(unescapeOoxml(cur));
        inSi = false;
      } else if (name === 'rPh') phonetic--;
      else if (name === 't') inT = false;
    },
    text(t) {
      if (inT) cur += t;
    }
  });
  return out;
}

/** For each cellXfs index: does that style display its number as a date? */
function parseDateStyles(xml: string): boolean[] {
  const custom = new Map<number, string>();
  const xfFmts: number[] = [];
  let inXfs = false;
  parseXml(xml, {
    open(name, a) {
      if (name === 'numFmt' && a.numFmtId !== undefined) custom.set(Number(a.numFmtId), a.formatCode ?? '');
      else if (name === 'cellXfs') inXfs = true;
      else if (name === 'xf' && inXfs) xfFmts.push(Number(a.numFmtId ?? 0));
    },
    close(name) {
      if (name === 'cellXfs') inXfs = false;
    }
  });
  return xfFmts.map((id) => isDateNumFmt(id, custom));
}

function parseSheet(
  xml: string,
  shared: string[],
  dateStyles: boolean[],
  maxRows: number,
  maxCols: number
): { rows: Cell[][]; truncated: boolean } {
  const grid = new Map<number, Map<number, Cell>>();
  let truncated = false;
  let maxRow = -1;
  let maxCol = -1;
  let row = -1;
  let col = -1;
  let cType = '';
  let cStyle = 0;
  let cCol = -1;
  let inCell = false;
  let inInline = false;
  let phonetic = 0;
  let capture: 'v' | 't' | null = null;
  let vText: string | null = null;
  let tText = '';

  const finish = () => {
    let cell: Cell | null = null;
    switch (cType) {
      case 's': {
        const s = vText === null ? undefined : shared[Number(vText)];
        cell = s ? { v: s } : null;
        break;
      }
      case 'str':
        cell = vText ? { v: unescapeOoxml(vText) } : null;
        break;
      case 'inlineStr':
        cell = tText ? { v: unescapeOoxml(tText) } : null;
        break;
      case 'b':
        cell = vText === null ? null : { v: vText.trim() === '1' || vText.trim().toLowerCase() === 'true' };
        break;
      case 'e':
        cell = null;
        break;
      case 'd':
        cell = vText ? { v: vText.trim(), date: true } : null;
        break;
      default: {
        if (vText === null || vText.trim() === '') break;
        const num = Number(vText);
        if (!Number.isFinite(num)) break;
        cell = dateStyles[cStyle] ? { v: num, date: true } : { v: num };
      }
    }
    if (!cell || cCol < 0) return;
    if (cCol >= maxCols) {
      truncated = true;
      return;
    }
    let r = grid.get(row);
    if (!r) grid.set(row, (r = new Map()));
    r.set(cCol, cell);
    if (row > maxRow) maxRow = row;
    if (cCol > maxCol) maxCol = cCol;
  };

  parseXml(xml, {
    open(name, a) {
      switch (name) {
        case 'row': {
          const r = a.r !== undefined ? Number(a.r) - 1 : row + 1;
          row = Number.isInteger(r) && r >= 0 ? r : row + 1;
          if (row >= maxRows) {
            truncated = true;
            throw STOP_PARSING;
          }
          col = -1;
          break;
        }
        case 'c': {
          const ref = a.r ? parseCellRef(a.r) : null;
          cCol = ref ? ref.col : col + 1;
          if (ref && ref.row !== row) {
            row = ref.row;
            if (row >= maxRows) {
              truncated = true;
              throw STOP_PARSING;
            }
          }
          col = cCol;
          cType = a.t ?? 'n';
          cStyle = Number(a.s ?? 0) || 0;
          inCell = true;
          vText = null;
          tText = '';
          break;
        }
        case 'v':
          if (inCell) {
            capture = 'v';
            vText = '';
          }
          break;
        case 'is':
          if (inCell) inInline = true;
          break;
        case 'rPh':
          phonetic++;
          break;
        case 't':
          if (inInline && phonetic === 0) capture = 't';
          break;
      }
    },
    close(name) {
      switch (name) {
        case 'c':
          if (inCell) finish();
          inCell = false;
          inInline = false;
          capture = null;
          break;
        case 'v':
        case 't':
          capture = null;
          break;
        case 'is':
          inInline = false;
          break;
        case 'rPh':
          phonetic--;
          break;
      }
    },
    text(t) {
      if (capture === 'v') vText += t;
      else if (capture === 't') tText += t;
    }
  });

  const width = maxCol + 1;
  const rows: Cell[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const src = grid.get(r);
    const out: Cell[] = new Array(width);
    for (let c = 0; c < width; c++) out[c] = src?.get(c) ?? EMPTY_CELL;
    rows.push(out);
  }
  return { rows, truncated };
}

function looksLikeOleFile(b: Uint8Array): boolean {
  return b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
}

export async function readXlsx(buf: ArrayBuffer | Uint8Array, opts: XlsxOptions = {}): Promise<XlsxWorkbook> {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (looksLikeOleFile(bytes)) {
    throw new XlsxError('This is an old .xls file or a password-protected workbook. Save it as .xlsx and try again.');
  }
  const zip = await readZip(bytes, opts);
  const maxRows = opts.maxRows ?? IMPORT_MAX_ROWS;
  const maxCols = opts.maxCols ?? IMPORT_MAX_COLS;

  const rootRels = await readRels(zip, '_rels/.rels', '');
  const workbookPath = rootRels.find((r) => r.type.endsWith(REL_OFFICE_DOC))?.target ?? 'xl/workbook.xml';
  const workbookXml = await zip.readText(workbookPath);
  if (workbookXml === null) throw new XlsxError('Not an Excel workbook (.xlsx)');
  const baseDir = dirOf(workbookPath);
  const rels = await readRels(zip, relsPathFor(workbookPath), baseDir);
  const relById = new Map(rels.map((r) => [r.id, r]));

  let date1904 = false;
  const sheetRefs: { name: string; rid: string; hidden: boolean }[] = [];
  parseXml(workbookXml, {
    open(name, a) {
      if (name === 'workbookPr') {
        const v = (a.date1904 ?? '').toLowerCase();
        date1904 = v === '1' || v === 'true';
      } else if (name === 'sheet') {
        const state = a.state ?? 'visible';
        sheetRefs.push({ name: a.name ?? '', rid: relId(a), hidden: state !== 'visible' });
      }
    }
  });

  const partOf = (suffix: string, fallback: string) =>
    rels.find((r) => r.type.endsWith(suffix))?.target ?? fallback;
  const ssXml = await zip.readText(partOf(REL_SHARED_STRINGS, `${baseDir}sharedStrings.xml`));
  const shared = ssXml === null ? [] : parseSharedStrings(ssXml);
  const stylesXml = await zip.readText(partOf(REL_STYLES, `${baseDir}styles.xml`));
  const dateStyles = stylesXml === null ? [] : parseDateStyles(stylesXml);

  const sheets: XlsxSheet[] = [];
  for (let i = 0; i < sheetRefs.length; i++) {
    const ref = sheetRefs[i];
    const rel = relById.get(ref.rid);
    if (rel && !rel.type.endsWith(REL_WORKSHEET)) continue; // chart sheets, dialog sheets
    const xml = await zip.readText(rel?.target ?? `${baseDir}worksheets/sheet${i + 1}.xml`);
    if (xml === null) continue;
    const { rows, truncated } = parseSheet(xml, shared, dateStyles, maxRows, maxCols);
    sheets.push({ name: ref.name || `Sheet${i + 1}`, rows, hidden: ref.hidden, truncated });
  }
  return { sheets, date1904 };
}
