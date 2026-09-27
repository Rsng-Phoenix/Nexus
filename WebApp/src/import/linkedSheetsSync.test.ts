import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkedSheet, SheetMapping } from '../settings/store';

// One Drive app folder shared by "devices"; each device has its own settings and meta.
let driveFile: { id: string; text: string } | null = null;
let writes = 0;
vi.mock('../sync/drive', () => ({
  readAppFile: async () => driveFile,
  writeAppFile: async (_t: string, _n: string, text: string) => {
    writes++;
    driveFile = { id: 'f1', text };
  }
}));
const refreshed: string[] = [];
const dropped: string[] = [];
vi.mock('./liveSheet', () => ({
  refreshSheet: async (id: string) => void refreshed.push(id),
  dropSheetSnapshot: async (id: string) => void dropped.push(id)
}));
type Dev = { linkedSheets: LinkedSheet[]; meta: Map<string, unknown> };
let settings: { linkedSheets: LinkedSheet[] } = { linkedSheets: [] };
let meta = new Map<string, unknown>();
vi.mock('../settings/store', () => ({ getSettings: () => settings, patchSettings: (p: object) => void (settings = { ...settings, ...p }) }));
vi.mock('../db/tasks', () => ({
  getMetaValue: async (k: string) => meta.get(k),
  setMetaValue: async (k: string, v: unknown) => void meta.set(k, JSON.parse(JSON.stringify(v)))
}));

import { localLinkedSheets, markSheetRemoved, markSheetUpdated, mergeLinkedSheets, parseLinkedSheetsFile, parseMapping, sheetKey, syncLinkedSheets, wireLinkedSheets, type SyncedSheet } from './linkedSheetsSync';

const A = 'SHEET_A_ABCDEFGHIJKLMNOPQRSTUV';
const B = 'SHEET_B_ABCDEFGHIJKLMNOPQRSTUV';
const MAP: SheetMapping = { headerRow: 0, titleCols: [0], titleText: '', dateCol: 1, notesCols: [2], priority: 'MEDIUM', offsets: [0, -1], alertTime: 540, dayFirst: true };
const sheet = (sheetId: string, updatedAt: number, extra: Partial<SyncedSheet> = {}): SyncedSheet => ({
  id: `id-${sheetId.slice(6, 7)}-${updatedAt}`,
  name: 'Sheet',
  sheetId,
  gid: '0',
  mapping: MAP,
  enabled: true,
  updatedAt,
  ...extra
});
const NOW = Date.now();
const T = (n: number) => NOW - 1_000_000 + n; // recent moments, in order

describe('mergeLinkedSheets', () => {
  it('two devices that each linked a sheet end up with both; the same sheet on both is one', () => {
    const m = mergeLinkedSheets({ sheets: [sheet(A, T(10))], removed: [] }, { sheets: [sheet(B, T(20)), sheet(A, T(5))], removed: [] }, NOW);
    expect(m.sheets.map((s) => s.sheetId)).toEqual([A, B]);
  });

  it('tabs of one spreadsheet are separate links', () => {
    const m = mergeLinkedSheets({ sheets: [sheet(A, T(10))], removed: [] }, { sheets: [sheet(A, T(10), { gid: '77', id: 'tab77' })], removed: [] }, NOW);
    expect(m.sheets.map(sheetKey)).toEqual([`${A}#0`, `${A}#77`]);
  });

  it('the newest change wins (name, mapping, switch) and this device keeps its own id', () => {
    const mine = sheet(A, T(10), { id: 'mine', name: 'Old' });
    const theirs = sheet(A, T(20), { id: 'theirs', name: 'RTO tracker', enabled: false, mapping: { ...MAP, dateCol: 3 } });
    const m = mergeLinkedSheets({ sheets: [mine], removed: [] }, { sheets: [theirs], removed: [] }, NOW);
    expect(m.sheets).toHaveLength(1);
    expect(m.sheets[0]).toMatchObject({ id: 'mine', name: 'RTO tracker', enabled: false, updatedAt: T(20) });
    expect(m.sheets[0].mapping.dateCol).toBe(3);
    const older = mergeLinkedSheets({ sheets: [sheet(A, T(30), { id: 'mine', name: 'New' })], removed: [] }, { sheets: [theirs], removed: [] }, NOW);
    expect(older.sheets[0].name).toBe('New');
  });

  it('a removal newer than the link removes it; a link newer than the removal brings it back', () => {
    const rm = { sheetId: A, gid: '0', at: T(15) };
    const removed = mergeLinkedSheets({ sheets: [sheet(A, T(10))], removed: [] }, { sheets: [], removed: [rm] }, NOW);
    expect(removed.sheets).toEqual([]);
    expect(removed.removed).toEqual([rm]);
    const readded = mergeLinkedSheets({ sheets: [sheet(A, T(20))], removed: [] }, { sheets: [], removed: [rm] }, NOW);
    expect(readded.sheets.map((s) => s.sheetId)).toEqual([A]);
    expect(readded.removed).toEqual([]);
  });

  it('links from before sync existed (no timestamp) are kept, but lose to any removal', () => {
    expect(mergeLinkedSheets({ sheets: [sheet(A, 0)], removed: [] }, null, NOW).sheets).toHaveLength(1);
    expect(mergeLinkedSheets({ sheets: [sheet(A, 0)], removed: [] }, { sheets: [], removed: [{ sheetId: A, gid: '0', at: T(1) }] }, NOW).sheets).toEqual([]);
  });

  it('removals of the same tab keep the newest; forgotten after 180 days', () => {
    const m = mergeLinkedSheets({ sheets: [], removed: [{ sheetId: A, gid: '0', at: T(5) }] }, { sheets: [], removed: [{ sheetId: A, gid: '0', at: T(9) }] }, NOW);
    expect(m.removed).toEqual([{ sheetId: A, gid: '0', at: T(9) }]);
    const old = NOW - 181 * 86_400_000;
    expect(mergeLinkedSheets({ sheets: [], removed: [{ sheetId: A, gid: '0', at: old }] }, null, NOW).removed).toEqual([]);
  });

  it('keeps at most 30 sheets, this device’s first', () => {
    const many = Array.from({ length: 40 }, (_, i) => sheet(`SHEET_${String(i).padStart(2, '0')}_ABCDEFGHIJKLMNOPQRS`, T(i), { id: `c${i}` }));
    const m = mergeLinkedSheets({ sheets: many, removed: [] }, null, NOW);
    expect(m.sheets).toHaveLength(30);
    expect(m.sheets[0].id).toBe('c0');
  });
});

describe('the Drive file', () => {
  it('round-trips through the wire format, keys in a fixed order', () => {
    const set = { sheets: [sheet(B, 7, { id: 'b' }), sheet(A, 5, { id: 'a', mapping: { ...MAP, priority: { col: 4 } } })], removed: [{ sheetId: B, gid: '9', at: 3 }] };
    const text = wireLinkedSheets(set);
    const o = JSON.parse(text) as { v: number; sheets: { sheetId: string; mapping: Record<string, unknown> }[]; removed: unknown[] };
    expect(o.v).toBe(1);
    expect(o.sheets.map((s) => s.sheetId)).toEqual([A, B]); // sorted by key
    expect(Object.keys(o.sheets[0].mapping)).toEqual(['headerRow', 'titleCols', 'dateCol', 'titleText', 'notesCols', 'priority', 'offsets', 'alertTime', 'dayFirst']);
    expect(o.sheets[0].mapping.priority).toEqual({ col: 4, fallback: 'NONE' });
    const back = parseLinkedSheetsFile(text)!;
    expect(back.sheets.map((s) => s.id)).toEqual(['a', 'b']);
    expect(back.sheets[0].mapping).toMatchObject({ dateCol: 1, priority: { col: 4, fallback: 'NONE' }, offsets: [0, -1] });
    expect(back.removed).toEqual([{ sheetId: B, gid: '9', at: 3 }]);
    // Android writes the same text for the same set.
    expect(wireLinkedSheets(back)).toBe(text);
  });

  it('skips anything malformed instead of trusting it', () => {
    const text = JSON.stringify({
      v: 1,
      sheets: [
        { id: 'ok', name: 'Zoho', sheetId: A, gid: '12', mapping: MAP, enabled: false, updatedAt: 5 },
        { id: 'short', sheetId: 'abc', gid: '0', mapping: MAP },
        { id: 'badgid', sheetId: A, gid: 'x', mapping: MAP },
        { id: 'nomap', sheetId: B, gid: '0' },
        { id: 'badprio', sheetId: B, gid: '0', mapping: { ...MAP, priority: 'URGENT' } },
        { id: 'strcols', sheetId: B, gid: '1', mapping: { ...MAP, titleCols: ['a', 2], notesCols: 'x' } }
      ],
      removed: [{ sheetId: B, gid: '0', at: 3 }, { sheetId: '', at: 1 }, { sheetId: A, gid: '0' }, { sheetId: 'javascript:alert(1)', gid: '0', at: 9 }]
    });
    const p = parseLinkedSheetsFile(text)!;
    expect(p.sheets.map((s) => s.id)).toEqual(['ok', 'strcols']);
    expect(p.sheets[0]).toMatchObject({ enabled: false, updatedAt: 5, gid: '12' });
    expect(p.sheets[1].mapping).toMatchObject({ titleCols: [2], notesCols: [] });
    expect(p.removed).toEqual([{ sheetId: B, gid: '0', at: 3 }]);
    expect(parseLinkedSheetsFile('{"v":2}')).toBeNull();
    expect(parseLinkedSheetsFile('not json')).toBeNull();
    expect(parseMapping({ headerRow: '0', dateCol: 1, priority: 'LOW' })).toBeNull();
    expect(parseMapping({ headerRow: -1, dateCol: 1, priority: { col: 2, fallback: 'nope' } })).toMatchObject({ priority: { col: 2 }, alertTime: 540, dayFirst: true });
  });
});

describe('the same sheets on every device', () => {
  const link = (id: string, sheetId: string, name = 'Sheet'): LinkedSheet => ({ id, name, sheetId, gid: '0', mapping: MAP, enabled: true, lastSyncAt: 0, lastError: '' });
  const mac: Dev = { linkedSheets: [], meta: new Map() };
  const desk: Dev = { linkedSheets: [], meta: new Map() };
  const phone: Dev = { linkedSheets: [], meta: new Map() };
  const on = (d: Dev) => {
    settings = { linkedSheets: d.linkedSheets };
    meta = d.meta;
  };
  const save = (d: Dev) => {
    d.linkedSheets = settings.linkedSheets;
    d.meta = meta;
  };

  beforeEach(() => {
    driveFile = null;
    writes = 0;
    refreshed.length = dropped.length = 0;
    for (const d of [mac, desk, phone]) Object.assign(d, { linkedSheets: [], meta: new Map() });
  });

  it('linked in the browser, shows up in Nexus Desk and on the phone and is read there; unlinked on the phone, gone everywhere', async () => {
    on(mac);
    settings.linkedSheets = [link('mac-a', A, 'RTO')];
    await markSheetUpdated({ sheetId: A, gid: '0' }, T(100)); // what linkSheet does
    await syncLinkedSheets('t');
    save(mac);
    expect(writes).toBe(1);
    expect(refreshed).toEqual([]); // its own link was read when it was made

    on(desk);
    await syncLinkedSheets('t');
    save(desk);
    expect(desk.linkedSheets.map((l) => l.name)).toEqual(['RTO']);
    expect(desk.linkedSheets[0]).toMatchObject({ lastSyncAt: 0, lastError: '' });
    expect(refreshed).toEqual([desk.linkedSheets[0].id]); // read straight away
    expect(writes).toBe(1); // nothing new to share
    expect((await localLinkedSheets(desk.linkedSheets)).sheets[0].updatedAt).toBe(T(100)); // remembers Drive's timestamp

    on(phone);
    await syncLinkedSheets('t');
    save(phone);
    // Unlinked on the phone (what unlinkSheet does).
    phone.linkedSheets = [];
    on(phone);
    await markSheetRemoved({ sheetId: A, gid: '0' }, T(200));
    await syncLinkedSheets('t');
    save(phone);
    expect(writes).toBe(2);

    for (const d of [mac, desk]) {
      on(d);
      await syncLinkedSheets('t');
      save(d);
      expect(d.linkedSheets).toEqual([]);
    }
    expect(dropped).toEqual(['mac-a', desk.linkedSheets[0]?.id ?? dropped[1]]);
    expect(dropped).toHaveLength(2);
  });

  it('a device with nothing linked and nothing in Drive writes nothing', async () => {
    on(phone);
    await syncLinkedSheets('t');
    expect(writes).toBe(0);
    expect(driveFile).toBeNull();
  });

  it('two devices that linked the same sheet before sync existed merge it without duplicates', async () => {
    on(mac);
    settings.linkedSheets = [link('a', A)];
    await syncLinkedSheets('t');
    save(mac);
    on(desk);
    settings.linkedSheets = [link('b', A), link('c', B)];
    await syncLinkedSheets('t');
    save(desk);
    on(mac);
    await syncLinkedSheets('t');
    save(mac);
    expect(mac.linkedSheets.map((l) => l.sheetId)).toEqual([A, B]);
    expect(mac.linkedSheets.map((l) => l.id)[0]).toBe('a'); // its own id and row snapshot kept
    expect(desk.linkedSheets.map((l) => l.id)).toEqual(['b', 'c']);
  });

  it('a link made here after another device removed it wins (re-linking on purpose)', async () => {
    driveFile = { id: 'f1', text: wireLinkedSheets({ sheets: [], removed: [{ sheetId: A, gid: '0', at: T(50) }] }) };
    on(mac);
    settings.linkedSheets = [link('again', A)];
    await markSheetUpdated({ sheetId: A, gid: '0' }, T(60));
    await syncLinkedSheets('t');
    save(mac);
    expect(mac.linkedSheets.map((l) => l.id)).toEqual(['again']);
    expect(parseLinkedSheetsFile(driveFile!.text)!.removed).toEqual([]);
  });
});
