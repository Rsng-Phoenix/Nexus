import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const meta = new Map<string, string>();
let tasks: unknown[] = [];
vi.mock('../db/tasks', () => ({
  getAllTasksIncludingDeleted: async () => tasks,
  getMeta: async (k: string) => meta.get(k) ?? '',
  setMeta: async (k: string, v: string) => void meta.set(k, v)
}));
vi.mock('../sync/drive', () => ({}));
const creds = { v: 1, id: 'A'.repeat(43), key: 'K'.repeat(43), createdAt: 1, notes: false };
vi.mock('../settings/store', () => ({ getSettings: () => ({ calendarFeed: creds }), patchSettings: () => {} }));

import { publishFeed, schedulePublishFeed } from './feed';

const task = (uuid: string, title: string) => ({
  id: 1, taskUuid: uuid, description: title, priority: 'HIGH', position: 0, isCompleted: false, isWontDo: false, isPinned: false,
  reminderTime: null, reminderDateOnly: false, reminderIntervalMinutes: 0, reminderEndDate: 0, reminderHistoryLabel: '',
  notes: '', createdAt: 1, updatedAt: 1, deletedAt: 0, completedAt: 0, skippedAt: 0, archivedAt: 0, dueDate: '2026-10-05', dueAlerts: '', dueAlertTime: 540
});

describe('feed publishing', () => {
  const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
  beforeEach(() => {
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    meta.clear();
    fetchMock.mockClear();
    tasks = [task('a', 'First')];
  });
  afterEach(() => vi.useRealTimers());

  it('sends once, a few seconds after a burst of edits', async () => {
    schedulePublishFeed();
    schedulePublishFeed();
    schedulePublishFeed();
    await vi.advanceTimersByTimeAsync(3900);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0, { timeout: 2000, interval: 5 });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/feed\/A{43}$/);
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${'K'.repeat(43)}`);
    expect(String(init.body)).toContain('SUMMARY:First');
  });

  it('skips unchanged calendars (even though DTSTAMP changes), sends real changes', async () => {
    await publishFeed();
    await vi.advanceTimersByTimeAsync(60_000);
    await publishFeed();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    tasks = [task('a', 'First'), task('b', 'Second')];
    await publishFeed();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await publishFeed(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the last good copy when the network fails, and retries next time', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 500 }));
    await publishFeed();
    expect(meta.get('feed_hash') ?? '').toBe('');
    await publishFeed();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(meta.get('feed_hash')).toBeTruthy();
  });
});
