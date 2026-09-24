import { beforeEach, describe, expect, it, vi } from 'vitest';

// One Drive app folder shared by "two devices"; each device has its own settings.
let driveFile: { id: string; text: string } | null = null;
vi.mock('../sync/drive', () => ({
  readAppFile: async () => driveFile,
  writeAppFile: async (_t: string, _n: string, text: string) => void (driveFile = { id: 'f1', text }),
  deleteFile: async () => void (driveFile = null)
}));
vi.mock('../db/tasks', () => ({ getAllTasksIncludingDeleted: async () => [], getMeta: async () => '', setMeta: async () => {} }));
let settings: { calendarFeed: unknown } = { calendarFeed: null };
vi.mock('../settings/store', () => ({ getSettings: () => settings, patchSettings: (p: object) => void (settings = { ...settings, ...p }) }));

import { disableFeed, enableFeed, syncFeedCreds } from './feed';

type C = { id: string; key: string; shared?: boolean };
const phone = { calendarFeed: null as C | null };
const laptop = { calendarFeed: null as C | null };
const on = (d: typeof phone) => (settings = d as never);
const save = (d: typeof phone) => (d.calendarFeed = settings.calendarFeed as C | null);

describe('one calendar link for all your devices', () => {
  beforeEach(() => {
    driveFile = null;
    phone.calendarFeed = laptop.calendarFeed = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  it('turned on on the phone, picked up by the laptop, turned off everywhere from the laptop', async () => {
    on(phone);
    await enableFeed();
    await syncFeedCreds('t');
    save(phone);
    expect(driveFile).not.toBeNull();
    expect(phone.calendarFeed?.shared).toBe(true);
    expect(driveFile!.text).not.toContain('shared');

    on(laptop);
    await syncFeedCreds('t');
    save(laptop);
    expect(laptop.calendarFeed?.id).toBe(phone.calendarFeed?.id);
    expect(laptop.calendarFeed?.key).toBe(phone.calendarFeed?.key);

    await disableFeed('t');
    save(laptop);
    expect(driveFile).toBeNull();

    on(phone);
    await syncFeedCreds('t');
    save(phone);
    expect(phone.calendarFeed).toBeNull();
  });

  it('a link made before signing in is uploaded, not thrown away', async () => {
    on(phone);
    await enableFeed();
    save(phone);
    expect(phone.calendarFeed?.shared).toBe(false);
    await syncFeedCreds('t');
    save(phone);
    expect(driveFile).not.toBeNull();
    expect(phone.calendarFeed).not.toBeNull();
  });

  it('ignores a damaged Drive file', async () => {
    driveFile = { id: 'f', text: '{"v":1,"id":"short","key":"x"}' };
    on(laptop);
    await syncFeedCreds('t');
    save(laptop);
    expect(laptop.calendarFeed).toBeNull();
  });
});
