import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sync/backup', () => ({ SYNC_TOMBSTONE_RETENTION_MS: 0 }));
vi.mock('../task-utils', () => ({ withTaskDefaults: (t: unknown) => t }));

import { DB_BLOCKED_MESSAGE, getMeta } from './tasks';

type Req = { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; onupgradeneeded?: () => void };

/** A stand-in for IndexedDB: every open() is recorded and settled by the test. */
function fakeIdb() {
  const opens: Req[] = [];
  const dbs: { closed: boolean; onversionchange?: () => void; onclose?: () => void; transaction: () => unknown }[] = [];
  const makeDb = () => {
    const db = {
      closed: false,
      close() {
        db.closed = true;
      },
      transaction: () => ({
        objectStore: () => ({
          get: () => {
            const r: Req = { result: 'v' };
            queueMicrotask(() => r.onsuccess?.());
            return r;
          }
        })
      })
    } as (typeof dbs)[number] & { close(): void };
    dbs.push(db);
    return db;
  };
  vi.stubGlobal('indexedDB', {
    open: () => {
      const r: Req = {};
      opens.push(r);
      return r;
    }
  });
  const succeed = (i: number) => {
    opens[i].result = makeDb();
    opens[i].onsuccess?.();
  };
  return { opens, dbs, succeed };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the IndexedDB connection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is opened once and shared; another window upgrading closes it, and the next call reopens', async () => {
    const idb = fakeIdb();
    const a = getMeta('k');
    const b = getMeta('k');
    await flush();
    expect(idb.opens).toHaveLength(1);
    idb.succeed(0);
    expect(await a).toBe('v');
    expect(await b).toBe('v');

    idb.dbs[0].onversionchange!(); // a newer Nexus asks to upgrade
    expect(idb.dbs[0].closed).toBe(true);
    const c = getMeta('k');
    await flush();
    expect(idb.opens).toHaveLength(2);
    idb.succeed(1);
    expect(await c).toBe('v');

    // Closed by the browser itself: reopened too.
    idb.dbs[1].onclose!();
    const d = getMeta('k');
    await flush();
    expect(idb.opens).toHaveLength(3);
    idb.opens[2].onblocked!(); // leave no connection behind for the next test
    await d.catch(() => {});
  });

  it('an upgrade blocked by an old window fails with a clear message instead of hanging', async () => {
    const idb = fakeIdb();
    const p = getMeta('k');
    await flush();
    const n = idb.opens.length;
    idb.opens[n - 1].onblocked!();
    await expect(p).rejects.toThrow(DB_BLOCKED_MESSAGE);
    expect(DB_BLOCKED_MESSAGE).toMatch(/Close other Nexus windows/);
    // Not cached: the next call tries again.
    void getMeta('k');
    await flush();
    expect(idb.opens.length).toBe(n + 1);
  });
});
