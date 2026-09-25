import { describe, expect, it } from 'vitest';
import type { Cell } from './cell';
import { csvRowsToCells, parseCsv } from './csv';
import { detectHeaderRow, suggestDateColumn } from './dates';
import { buildImportPlan, importTaskUuid, parsePriorityText } from './plan';

const c = (v: Cell['v'], date?: boolean): Cell => (date ? { v, date } : { v });

describe('deterministic import uuid', () => {
  // Android ImportPlanner must produce exactly these (see plan.ts header for the derivation).
  it('matches the shared reference values', async () => {
    expect(await importTaskUuid('Filings 2026.xlsx', 'Sheet1', 'GST return · Client A', '2026-10-05')).toBe(
      'xl-2cc864df1ec5821de3caed97'
    );
    expect(await importTaskUuid('deadlines.csv', '', 'Renew passport', '2027-01-31')).toBe(
      'xl-c0b99bbe8d0fd0322cf551bb'
    );
  });

  it('is stable across runs and sensitive to every field', async () => {
    const a = await importTaskUuid('f.xlsx', 'S', 'T', '2026-10-05');
    expect(await importTaskUuid('f.xlsx', 'S', 'T', '2026-10-05')).toBe(a);
    expect(a).toMatch(/^xl-[0-9a-f]{24}$/);
    expect(await importTaskUuid('f.xlsx', 'S', 'T', '2026-10-06')).not.toBe(a);
    expect(await importTaskUuid('f.xlsx', 'ST', '', '2026-10-05')).not.toBe(await importTaskUuid('f.xlsx', 'S', 'T', '2026-10-05'));
  });
});

describe('parsePriorityText', () => {
  it('maps the accepted spellings', () => {
    const want: Record<string, string | null> = {
      High: 'HIGH', h: 'HIGH', '1': 'HIGH', P1: 'HIGH', URGENT: 'HIGH', Important: 'HIGH',
      medium: 'MEDIUM', M: 'MEDIUM', '2': 'MEDIUM', p2: 'MEDIUM', Med: 'MEDIUM',
      low: 'LOW', L: 'LOW', '3': 'LOW', P3: 'LOW',
      None: 'NONE', n: 'NONE', '4': 'NONE', p4: 'NONE',
      ' high ': 'HIGH', critical: null, '5': null, '': null
    };
    for (const [input, p] of Object.entries(want)) expect(parsePriorityText(input)).toBe(p);
  });
});

describe('buildImportPlan', () => {
  const rows: Cell[][] = [
    [c(null)],
    [c('Client'), c('Task'), c('Due'), c('Priority'), c('Ref'), c(null)],
    [c('Acme'), c('GST return'), c(46300, true), c('High'), c(1234), c('ignored')],
    [c('Acme'), c('GST return'), c('05/10/2026'), c('low'), c(null)], // same title+date → duplicate
    [c('Beta'), c('TDS'), c('07/10/2026'), c('P3'), c('x')],
    [c(null), c(null), c(null)], // blank → skipped silently
    [c(null), c(' '), c('08/10/2026')], // no title
    [c('Gamma'), c('Audit'), c('someday'), c('2')], // bad date
    [c('Delta'), c('ROC'), c(null), c('1')], // no date
    [c('Eps'), c('Board'), c('2026-10-09'), c('whatever'), c(true)]
  ];

  it('rows with the same title and date keep every reason (one task, notes combined)', async () => {
    const sheet: Cell[][] = [
      [c('Task'), c('Due'), c('Reason'), c('Priority')],
      [c('RTO follow-up'), c('2026-10-05'), c('Customer not home'), c('Low')],
      [c('RTO follow-up'), c('2026-10-05'), c('Wrong address'), c('High')],
      [c('RTO follow-up'), c('2026-10-05'), c('Customer not home'), c('Low')], // exact repeat: nothing new
      [c('RTO follow-up'), c('2026-10-06'), c('Refused'), c('Low')] // other date: its own task
    ];
    const plan = await buildImportPlan({
      fileName: 'rto.csv',
      sheetName: '',
      rows: sheet,
      headerRow: 0,
      titleCols: [0],
      dateCol: 1,
      notesCols: [2],
      priority: { col: 3 },
      offsets: [0]
    });
    expect(plan.duplicates).toBe(2);
    expect(plan.items.map((i) => [i.dueDate, i.priority, i.notes])).toEqual([
      ['2026-10-05', 'HIGH', 'Reason: Customer not home\nReason: Wrong address'],
      ['2026-10-06', 'LOW', 'Reason: Refused']
    ]);
  });

  it('builds items, invalid rows and duplicate count', async () => {
    const plan = await buildImportPlan({
      fileName: 'Filings.xlsx',
      sheetName: 'FY27',
      rows,
      headerRow: 1,
      titleCols: [0, 1],
      dateCol: 2,
      notesCols: [4, 5],
      priority: { col: 3, fallback: 'MEDIUM' },
      offsets: [0, -1, -1, 99, -2],
      alertTime: 1050,
      dayFirst: true
    });
    expect(plan.duplicates).toBe(1);
    expect(plan.invalid).toEqual([
      { rowIndex: 6, reason: 'No title' },
      { rowIndex: 7, reason: 'Not a date: "someday"' },
      { rowIndex: 8, reason: 'No date' }
    ]);
    expect(plan.items.map((i) => [i.rowIndex, i.description, i.dueDate, i.priority, i.notes])).toEqual([
      [2, 'Acme · GST return', '2026-10-05', 'HIGH', 'Ref: 1234\nColumn F: ignored'],
      [4, 'Beta · TDS', '2026-10-07', 'LOW', 'Ref: x'],
      [9, 'Eps · Board', '2026-10-09', 'MEDIUM', 'Ref: TRUE']
    ]);
    for (const item of plan.items) {
      expect(item.dueAlerts).toBe('-2,-1,0');
      expect(item.dueAlertTime).toBe(1050);
      expect(item.taskUuid).toBe(await importTaskUuid('Filings.xlsx', 'FY27', item.description, item.dueDate));
      expect(item.exists).toBe(false);
    }
  });

  it('uses a fixed priority, flags existing uuids, and gives the same uuids on re-import', async () => {
    const input = {
      fileName: 'Filings.xlsx',
      sheetName: 'FY27',
      rows,
      headerRow: 1,
      titleCols: [1],
      dateCol: 2,
      priority: 'LOW' as const,
      offsets: [],
      alertTime: 540
    };
    const first = await buildImportPlan(input);
    expect(first.items.every((i) => i.priority === 'LOW' && i.notes === '' && i.dueAlerts === '')).toBe(true);
    const again = await buildImportPlan({ ...input, existingUuids: new Set(first.items.map((i) => i.taskUuid)) });
    expect(again.items.map((i) => i.taskUuid)).toEqual(first.items.map((i) => i.taskUuid));
    expect(again.items.every((i) => i.exists)).toBe(true);
  });

  it('month-first files and header-less sheets', async () => {
    const plan = await buildImportPlan({
      fileName: 'us.csv',
      sheetName: '',
      rows: [[c('Pay tax'), c('04/15/2027')], [c('Pay rent'), c('05/01/2027')]],
      headerRow: -1,
      titleCols: [0],
      dateCol: 1,
      priority: 'NONE',
      offsets: [-1],
      dayFirst: false
    });
    expect(plan.items.map((i) => [i.rowIndex, i.dueDate, i.dueAlertTime])).toEqual([
      [0, '2027-04-15', 540],
      [1, '2027-05-01', 540]
    ]);
  });

  it('works end to end from CSV text', async () => {
    const csv = '﻿Title;Deadline;Notes\r\n"Renew passport";31 Jan 2027;"Bring photo; old passport"\r\nFile ITR;Jul 31, 2027;\r\n';
    const { rows: raw } = parseCsv(csv);
    const cells = csvRowsToCells(raw);
    const header = detectHeaderRow(cells);
    expect(header).toBe(0);
    const dateCol = suggestDateColumn(cells, header);
    expect(dateCol).toBe(1);
    const plan = await buildImportPlan({
      fileName: 'deadlines.csv',
      sheetName: '',
      rows: cells,
      headerRow: header,
      titleCols: [0],
      dateCol,
      notesCols: [2],
      priority: 'HIGH',
      offsets: [-1, 0]
    });
    expect(plan.items[0]).toEqual({
      taskUuid: 'xl-c0b99bbe8d0fd0322cf551bb',
      description: 'Renew passport',
      notes: 'Notes: Bring photo; old passport',
      priority: 'HIGH',
      dueDate: '2027-01-31',
      dueAlerts: '-1,0',
      dueAlertTime: 540,
      rowIndex: 1,
      exists: false
    });
    expect(plan.items[1].dueDate).toBe('2027-07-31');
    expect(plan.items[1].notes).toBe('');
  });
});
