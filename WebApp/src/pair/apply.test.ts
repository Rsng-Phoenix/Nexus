import { describe, expect, it, vi } from 'vitest';

let settings = { linkedSheets: [] as unknown[], linkedCalendars: [] as unknown[], linkedRemoved: [] as unknown[] };
const stamped: { sheetId: string; gid: string }[][] = [];
const refreshed: boolean[] = [];
vi.mock('../settings/store', () => ({ getSettings: () => settings, patchSettings: (p: object) => void (settings = { ...settings, ...p }) }));
vi.mock('../calendar/linked', () => ({ refreshLinked: async () => {} }));
vi.mock('../import/liveSheet', () => ({ refreshSheets: async (force: boolean) => void refreshed.push(force) }));
vi.mock('../import/linkedSheetsSync', () => ({ markSheetsUpdated: async (refs: { sheetId: string; gid: string }[]) => void stamped.push(refs) }));
vi.mock('../state/nav', () => ({ closeKind: () => {} }));
vi.mock('./pair', () => ({
  newCalendars: () => [],
  newSheets: (p: { sheets: unknown[] }) => p.sheets
}));

import { applySetup } from './apply';
import type { SetupPayload } from './pair';

describe('applySetup', () => {
  it('sheets added by Scan to set up are stamped as linked now (so an old removal on Drive loses)', () => {
    const sheet = { name: 'RTO', sheetId: 'SHEET_A_ABCDEFGHIJKLMNOPQRSTUV', gid: '0', mapping: {} };
    const n = applySetup({ sheets: [sheet] } as unknown as SetupPayload, { calendars: false, prefs: false, sheets: true });
    expect(n).toBe(1);
    expect(settings.linkedSheets).toMatchObject([{ sheetId: sheet.sheetId, gid: '0', enabled: true }]);
    expect(stamped).toEqual([[expect.objectContaining({ sheetId: sheet.sheetId, gid: '0' })]]);
    expect(refreshed).toEqual([true]);
  });
});
