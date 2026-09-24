import { beforeEach, describe, expect, it, vi } from 'vitest';

const meta = new Map<string, string>();
vi.mock('../db/tasks', () => ({
  getMeta: async (k: string) => meta.get(k) ?? null,
  setMeta: async (k: string, v: string) => void meta.set(k, v)
}));

const { deliverRing, meetingInfo } = await import('./notify');

type Shown = { title: string; opts: NotificationOptions & { data?: Record<string, unknown>; actions?: { action: string }[] } };
function fakeReg() {
  const shown: Shown[] = [];
  const reg = {
    showNotification: async (title: string, opts: Shown['opts']) => void shown.push({ title, opts }),
    getNotifications: async () => []
  } as unknown as ServiceWorkerRegistration;
  return { reg, shown };
}

const now = Date.now();
const info = { title: 'Client call', at: now + 10 * 60_000, url: 'https://meet.google.com/abc-defg-hij', source: 'Google · Work' };
const ring = { kind: 'meet' as const, ref: 'meet:abc', fireAt: now };

describe('meeting heads-up delivery', () => {
  beforeEach(() => {
    meta.clear();
    meta.set('sw_settings', JSON.stringify({ notifyMeetings: true }));
  });

  it('shows once, with Join and the source', async () => {
    const { reg, shown } = fakeReg();
    expect(await deliverRing(reg, ring, undefined, info)).toBe(true);
    expect(await deliverRing(reg, ring, undefined, info)).toBe(false); // never twice
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('Client call');
    expect(String(shown[0].opts.body)).toMatch(/^In 10 min · .*\nGoogle · Work$/);
    expect(shown[0].opts.actions?.map((a) => a.action)).toEqual(['join']);
    expect(shown[0].opts.data?.url).toBe(info.url);
  });

  it('stays silent when turned off, paused, unknown or long over', async () => {
    const { reg, shown } = fakeReg();
    meta.set('sw_settings', JSON.stringify({ notifyMeetings: false }));
    expect(await deliverRing(reg, ring, undefined, info)).toBe(false);
    meta.set('sw_settings', JSON.stringify({ notifyMeetings: true, pauseNotificationsUntil: now + 3_600_000 }));
    expect(await deliverRing(reg, { ...ring, ref: 'meet:b' }, undefined, info)).toBe(false);
    meta.set('sw_settings', JSON.stringify({ notifyMeetings: true }));
    expect(await deliverRing(reg, { ...ring, ref: 'meet:c' }, undefined, undefined)).toBe(false);
    expect(await deliverRing(reg, { ...ring, ref: 'meet:d' }, undefined, { ...info, at: now - 3_600_000 })).toBe(false);
    expect(shown).toHaveLength(0);
  });

  it('reads the meeting from the device index', async () => {
    meta.set('meet_index', JSON.stringify({ 'meet:abc': info }));
    expect(await meetingInfo('meet:abc')).toEqual(info);
    expect(await meetingInfo('meet:gone')).toBeUndefined();
  });
});
