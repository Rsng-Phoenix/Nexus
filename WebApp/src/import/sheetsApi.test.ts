import { describe, expect, it, vi } from 'vitest';

vi.mock('../sync/auth', () => ({
  clearToken: () => {},
  getAccessToken: async () => null,
  isDriveScopeError: (m: string) => /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(m)
}));

import { apiErrorMessage, isAccessRefusal, parseTabs, readRowsViaApi, SheetApiError, SheetNeedsPickError, tabRange, tabTitleFor, valuesToCells } from './sheetsApi';

const ID = 'SHEET_ID_ABCDEFGHIJKLMNOPQRST';
const META = { sheets: [{ properties: { sheetId: 0, title: 'Orders' } }, { properties: { sheetId: 123456, title: "Q4 'RTO'" } }, { properties: { title: 'no id' } }] };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

/** A fake Sheets API: answers by URL, remembers the bearer tokens it saw. */
function api(o: { meta?: Response | (() => Response); values?: Response | (() => Response) } = {}) {
  const seen: { url: string; token: string }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    seen.push({ url, token: String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '') });
    const pick = (r: Response | (() => Response) | undefined, dflt: () => Response) => (typeof r === 'function' ? r() : (r ?? dflt()));
    if (/\/values\//.test(url)) return pick(o.values, () => json({ values: [['Task', 'Due'], ['A', '05/10/2026'], ['', ''], ['B']] }));
    return pick(o.meta, () => json(META));
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe('gid → tab title', () => {
  it('parses the tabs and finds the one a link names; no gid = the first tab (as the CSV export)', () => {
    const tabs = parseTabs(META);
    expect(tabs).toEqual([{ sheetId: 0, title: 'Orders' }, { sheetId: 123456, title: "Q4 'RTO'" }]);
    expect(tabTitleFor(tabs, '')).toBe('Orders');
    expect(tabTitleFor(tabs, '123456')).toBe("Q4 'RTO'");
    expect(tabTitleFor(tabs, '0')).toBe('Orders');
    expect(tabTitleFor(tabs, '99')).toBeNull();
    expect(tabTitleFor([], '')).toBeNull();
    expect(parseTabs(null)).toEqual([]);
    expect(parseTabs({ sheets: 'nope' })).toEqual([]);
  });
  it('quotes the tab title as an A1 range, doubling quotes', () => {
    expect(tabRange('Orders')).toBe("'Orders'");
    expect(tabRange("Q4 'RTO'")).toBe("'Q4 ''RTO'''");
  });
});

describe('values → cells', () => {
  it('gives the CSV reader’s shape: blank = null, ragged rows kept as they are', () => {
    expect(valuesToCells({ values: [['Task', ' Due '], ['A', ''], [], ['B']] })).toEqual([
      [{ v: 'Task' }, { v: ' Due ' }],
      [{ v: 'A' }, { v: null }],
      [],
      [{ v: 'B' }]
    ]);
    expect(valuesToCells({})).toEqual([]);
    expect(valuesToCells(null)).toEqual([]);
  });
  it('caps rows and columns like a file import', () => {
    const big = { values: Array.from({ length: 6000 }, () => Array.from({ length: 300 }, () => 'x')) };
    const cells = valuesToCells(big);
    expect(cells).toHaveLength(5000);
    expect(cells[0]).toHaveLength(200);
  });
});

describe('readRowsViaApi', () => {
  it('reads a tab in two requests, with the bearer token, as formatted text', async () => {
    const { f, seen } = api();
    const rows = await readRowsViaApi('tok', ID, '', { fetch: f });
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual([{ v: 'A' }, { v: '05/10/2026' }]);
    expect(seen.map((s) => s.token)).toEqual(['tok', 'tok']);
    expect(seen[0].url).toBe(`https://sheets.googleapis.com/v4/spreadsheets/${ID}?fields=sheets.properties(sheetId,title)`);
    expect(seen[1].url).toContain(`/values/${encodeURIComponent("'Orders'")}?valueRenderOption=FORMATTED_VALUE`);
  });

  it('a 401 renews the token once and retries; without a fresh token it is an error', async () => {
    let calls = 0;
    const { f, seen } = api({ meta: () => (calls++ === 0 ? new Response('expired', { status: 401 }) : json(META)) });
    const rows = await readRowsViaApi('old', ID, '123456', { fetch: f, renew: async () => 'new' });
    expect(rows).toHaveLength(4);
    expect(seen.map((s) => s.token)).toEqual(['old', 'new', 'new']);

    const dead = api({ meta: new Response('expired', { status: 401 }) });
    await expect(readRowsViaApi('old', ID, '', { fetch: dead.f, renew: async () => null })).rejects.toBeInstanceOf(SheetApiError);
    expect(dead.seen).toHaveLength(1); // no second try without a token
  });

  it('a 403 for missing access asks for the Picker; other errors keep the CSV wording', async () => {
    const refused = api({ meta: json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } }, 403) });
    await expect(readRowsViaApi('t', ID, '', { fetch: refused.f })).rejects.toBeInstanceOf(SheetNeedsPickError);
    const noScope = api({ meta: json({ error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } }, 403) });
    await expect(readRowsViaApi('t', ID, '', { fetch: noScope.f })).rejects.toBeInstanceOf(SheetNeedsPickError);

    const gone = api({ meta: json({ error: { code: 404 } }, 404) });
    await expect(readRowsViaApi('t', ID, '', { fetch: gone.f })).rejects.toThrow(/not found/);
    const busy = api({ values: json({ error: { code: 429 } }, 429) });
    await expect(readRowsViaApi('t', ID, '', { fetch: busy.f })).rejects.toThrow(/busy/);
    const noTab = api();
    await expect(readRowsViaApi('t', ID, '4242', { fetch: noTab.f })).rejects.toThrow(/copy the link again/);
    const down = { f: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch };
    await expect(readRowsViaApi('t', ID, '', { fetch: down.f })).rejects.toThrow(/connection|offline/);
  });

  it('a 403 rate limit is not an access problem', () => {
    expect(isAccessRefusal(403, JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }))).toBe(false);
    expect(isAccessRefusal(403, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')).toBe(true);
    expect(apiErrorMessage(500, '')).toMatch(/answered 500/);
  });
});
