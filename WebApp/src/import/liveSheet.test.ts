import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types';

// In-memory tasks and meta, standing in for IndexedDB and the store.
let tasks: Task[] = [];
const meta = new Map<string, string>();
let clock = 1_000;
const tick = () => ++clock;
vi.mock('../db/tasks', () => ({
  getAllTasksIncludingDeleted: async () => tasks.map((t) => ({ ...t })),
  getMeta: async (k: string) => meta.get(k) ?? '',
  setMeta: async (k: string, v: string) => void meta.set(k, v),
  deleteMeta: async (k: string) => void meta.delete(k)
}));
vi.mock('../state/store', () => ({
  importTasks: async (rows: Array<Partial<Task> & { taskUuid: string }>) => {
    let added = 0;
    let updated = 0;
    for (const r of rows) {
      const cur = tasks.find((t) => t.taskUuid === r.taskUuid);
      if (!cur) {
        tasks.push({ id: tasks.length + 1, isCompleted: false, isWontDo: false, deletedAt: 0, updatedAt: tick(), ...r } as Task);
        added++;
      } else if (cur.deletedAt === 0) {
        Object.assign(cur, r, { updatedAt: tick() });
        updated++;
      }
    }
    return { added, updated, skipped: 0, undo: async () => {} };
  },
  restoreTasks: async () => {},
  deleteTasks: async (ids: number[]) => {
    for (const t of tasks) if (ids.includes(t.id)) Object.assign(t, { deletedAt: tick(), updatedAt: clock });
  }
}));
let settings = { linkedSheets: [] as unknown[], sheetRefreshMinutes: 15, sheetLateAlerts: true, notifyDeadlines: true };
const snoozes: { ref: string; kind: string; fireAt: number }[] = [];
vi.mock('../reminders/notify', () => ({ addSnooze: async (z: { ref: string; kind: string; fireAt: number }) => void snoozes.push(z) }));
vi.mock('../reminders/push', () => ({ scheduleAll: async () => {} }));
vi.mock('../settings/store', () => ({ getSettings: () => settings, patchSettings: (p: object) => void (settings = { ...settings, ...p }) }));

import { csvRowsToCells } from './csv';
import { applySheet, fetchSheetRows, lateAlerts, parseSheetUrl, sheetCsvUrl, unlinkSheet, upcomingSheetTasks } from './liveSheet';

const cells = (rows: string[][]) => csvRowsToCells(rows);
const link = {
  id: 'L1',
  sheetId: 'SHEET_ID_ABCDEFGHIJKLMNOPQRST',
  gid: '0',
  mapping: { headerRow: 0, titleCols: [0], dateCol: 1, notesCols: [2], priority: 'MEDIUM' as const, offsets: [0], alertTime: 540, dayFirst: true }
};
const byTitle = (s: string) => tasks.find((t) => t.description === s && t.deletedAt === 0);

describe('parseSheetUrl', () => {
  it('reads the sheet and tab from the links Google gives you', () => {
    expect(parseSheetUrl('https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?usp=sharing')).toEqual({
      sheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
      gid: '' // no tab in the link: the first tab (uploaded Excel files have no tab 0)
    });
    expect(sheetCsvUrl({ sheetId: 'X'.repeat(33), gid: '' })).toBe(`https://docs.google.com/spreadsheets/d/${'X'.repeat(33)}/export?format=csv`);
    expect(sheetCsvUrl({ sheetId: 'X'.repeat(33), gid: '7' })).toMatch(/&gid=7$/);
    // An uploaded Excel file opened in Sheets (rtpof=true) is read the same way.
    expect(parseSheetUrl('https://docs.google.com/spreadsheets/d/1eauNFUiHzr8Pp2P6BDrjUbh_tTQIOTqz/edit?usp=sharing&ouid=1&rtpof=true&sd=true')).toEqual({
      sheetId: '1eauNFUiHzr8Pp2P6BDrjUbh_tTQIOTqz',
      gid: ''
    });
    expect(parseSheetUrl(' https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=123456 ')?.gid).toBe('123456');
    expect(parseSheetUrl('https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?gid=42#gid=42')?.gid).toBe('42');
    expect(parseSheetUrl('https://evil.example/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms')).toBeNull();
    expect(parseSheetUrl('http://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms')).toBeNull();
    expect(parseSheetUrl('not a link')).toBeNull();
  });
});

describe('fetchSheetRows', () => {
  it('turns a private sheet (Google sign-in page) into a clear message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(fetchSheetRows({ sheetId: link.sheetId, gid: '0' })).rejects.toThrow(/Anyone with the link/);
  });
  it('reads CSV rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Task,Due\nA,2026-10-05\n', { status: 200, headers: { 'content-type': 'text/csv' } })));
    const rows = await fetchSheetRows({ sheetId: link.sheetId, gid: '0' });
    expect(rows).toHaveLength(2);
  });
});

describe('a linked sheet keeps its tasks up to date', () => {
  beforeEach(() => {
    tasks = [];
    meta.clear();
    clock = 1_000;
  });

  it('adds, updates only changed rows, keeps Nexus edits, and removes only untouched tasks', async () => {
    const v1 = cells([
      ['Task', 'Due', 'Reason'],
      ['Call courier', '2026-10-05', 'Late pickup'],
      ['Refund Anu', '2026-10-06', 'Damaged'],
      ['Audit', '2026-10-07', ''],
      ['Old row', '2026-10-08', '']
    ]);
    expect(await applySheet(link, v1)).toEqual({ added: 4, updated: 0, removed: 0 });

    // In Nexus: finish one, edit another's priority, leave the rest.
    Object.assign(byTitle('Audit')!, { isCompleted: true, updatedAt: tick() });
    Object.assign(byTitle('Refund Anu')!, { priority: 'HIGH', updatedAt: tick() });

    // Same sheet again: nothing changes, and the edit made in Nexus stays.
    expect(await applySheet(link, v1)).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(byTitle('Refund Anu')!.priority).toBe('HIGH');

    // The sheet changes: a reason edited, a row added, two rows deleted.
    const v2 = cells([
      ['Task', 'Due', 'Reason'],
      ['Call courier', '2026-10-05', 'Late pickup, called twice'],
      ['Refund Anu', '2026-10-06', 'Damaged'],
      ['New order check', '2026-10-09', '']
    ]);
    expect(await applySheet(link, v2)).toEqual({ added: 1, updated: 1, removed: 1 });
    expect(byTitle('Call courier')!.notes).toBe('Reason: Late pickup, called twice');
    expect(byTitle('Refund Anu')!.priority).toBe('HIGH'); // untouched row: Nexus edit kept
    expect(byTitle('Old row')).toBeUndefined(); // removed from the sheet, never touched in Nexus → removed
    expect(tasks.find((t) => t.description === 'Audit')!.deletedAt).toBe(0); // finished in Nexus → kept
  });

  it('a row removed from the sheet keeps its task when it was edited in Nexus', async () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      await applySheet(link, cells([['Task', 'Due', 'Reason'], ['Keep me', '2026-10-05', 'x'], ['Drop me', '2026-10-06', 'y']]));
      Object.assign(byTitle('Keep me')!, { notes: 'my own notes', updatedAt: tick() });
      expect(await applySheet(link, cells([['Task', 'Due', 'Reason']]))).toEqual({ added: 0, updated: 0, removed: 1 });
      expect(byTitle('Keep me')!.notes).toBe('my own notes');
      expect(byTitle('Drop me')).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it('a task deleted in Nexus is not brought back while its row stays the same', async () => {
    const v = cells([['Task', 'Due'], ['Pay GST', '2026-10-05']]);
    await applySheet({ ...link, mapping: { ...link.mapping, notesCols: [] } }, v);
    Object.assign(byTitle('Pay GST')!, { deletedAt: tick(), updatedAt: clock });
    expect(await applySheet({ ...link, mapping: { ...link.mapping, notesCols: [] } }, v)).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(byTitle('Pay GST')).toBeUndefined();
  });

  it('unlinking can remove the upcoming tasks only: past and finished ones stay', async () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const sheet = cells([
        ['Task', 'Due', 'Reason'],
        ['Past appointment', '2020-01-10', ''],
        ['Future appointment', '2099-01-10', ''],
        ['Future but done', '2099-02-10', ''],
        ['Another future', '2099-03-10', '']
      ]);
      await applySheet(link, sheet);
      Object.assign(byTitle('Future but done')!, { isCompleted: true, updatedAt: tick() });
      expect((await upcomingSheetTasks(link.id)).map((t) => t.description).sort()).toEqual(['Another future', 'Future appointment']);
      const removed = await unlinkSheet(link.id, true);
      expect(removed).toHaveLength(2);
      expect(byTitle('Past appointment')).toBeDefined();
      expect(byTitle('Future but done')).toBeDefined();
      expect(byTitle('Future appointment')).toBeUndefined();
      expect(await upcomingSheetTasks(link.id)).toEqual([]); // the link and its memory are gone
    } finally {
      now.mockRestore();
    }
  });

  it('unlinking without removing keeps every task', async () => {
    await applySheet(link, cells([['Task', 'Due', 'Reason'], ['Future appointment', '2099-01-10', '']]));
    expect(await unlinkSheet(link.id)).toEqual([]);
    expect(byTitle('Future appointment')).toBeDefined();
  });

  it('a row that arrives after its alert time (its day not over) alerts once right away', async () => {
    snoozes.length = 0;
    const d = new Date();
    const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const today = iso(d);
    const tomorrow = iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
    const nextYear = iso(new Date(d.getFullYear() + 1, d.getMonth(), 1));
    // Alerts on the day at 00:00 (always passed today): today's row is late, tomorrow's and next year's are not.
    const early = { ...link, mapping: { ...link.mapping, offsets: [0], alertTime: 0, notesCols: [] } };
    await applySheet(early, cells([['Task', 'Due'], ['Today shipment', today], ['Tomorrow shipment', tomorrow], ['Later', nextYear]]));
    expect(snoozes.map((z) => tasks.find((t) => t.taskUuid === z.ref)?.description)).toEqual(['Today shipment']);
    expect(snoozes[0].kind).toBe('due');
    // Read again, nothing changed: no second alert.
    await applySheet(early, cells([['Task', 'Due'], ['Today shipment', today], ['Tomorrow shipment', tomorrow], ['Later', nextYear]]));
    expect(snoozes).toHaveLength(1);
  });

  it('no late alert for tasks you finished, or with late alerts switched off', async () => {
    snoozes.length = 0;
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const early = { ...link, mapping: { ...link.mapping, offsets: [0], alertTime: 0, notesCols: [2] } };
    await applySheet(early, cells([['Task', 'Due', 'Reason'], ['Done already', today, 'a']]));
    snoozes.length = 0;
    Object.assign(byTitle('Done already')!, { isCompleted: true, updatedAt: tick() });
    await applySheet(early, cells([['Task', 'Due', 'Reason'], ['Done already', today, 'b changed']]));
    expect(snoozes).toHaveLength(0);
    settings = { ...settings, sheetLateAlerts: false };
    await applySheet(early, cells([['Task', 'Due', 'Reason'], ['Fresh row', today, 'x']]));
    expect(snoozes).toHaveLength(0);
    settings = { ...settings, sheetLateAlerts: true };
  });

  it('lateAlerts: past deadline days and alerts still ahead never ring late', () => {
    const item = (dueDate: string, dueAlerts: string, dueAlertTime: number) =>
      ({ taskUuid: dueDate + dueAlerts, description: 'x', notes: '', priority: 'MEDIUM', dueDate, dueAlerts, dueAlertTime, rowIndex: 1, exists: false }) as never;
    const now = new Date(2026, 8, 25, 12, 0).getTime(); // 25 Sep 2026, noon
    expect(lateAlerts([item('2026-09-24', '0', 540)], now)).toEqual([]); // yesterday: over
    expect(lateAlerts([item('2026-09-25', '0', 780)], now)).toEqual([]); // 1 pm today: still ahead
    expect(lateAlerts([item('2026-09-25', '0', 540)], now)).toHaveLength(1); // 9 am today: missed
    expect(lateAlerts([item('2026-09-26', '-1,0', 540)], now)).toHaveLength(1); // day-before alert at 9 am today: missed
    expect(lateAlerts([item('2026-09-27', '-1,0', 540)], now)).toEqual([]); // both ahead
  });
});
