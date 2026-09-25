import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkedCalendar } from '../settings/store';

// One Drive app folder shared by "devices"; each device has its own settings.
let driveFile: { id: string; text: string } | null = null;
let writes = 0;
vi.mock('../sync/drive', () => ({
  readAppFile: async () => driveFile,
  writeAppFile: async (_t: string, _n: string, text: string) => {
    writes++;
    driveFile = { id: 'f1', text };
  }
}));
const fetched: string[] = [];
const dropped: string[] = [];
vi.mock('./linked', () => ({
  fetchCalendar: async (c: LinkedCalendar) => void fetched.push(c.url),
  dropLinkedCache: async (id: string) => void dropped.push(id)
}));
type Dev = { linkedCalendars: LinkedCalendar[]; linkedRemoved: { url: string; at: number }[] };
let settings: Dev = { linkedCalendars: [], linkedRemoved: [] };
vi.mock('../settings/store', () => ({ getSettings: () => settings, patchSettings: (p: object) => void (settings = { ...settings, ...p }) }));

import { mergeLinked, parseLinkedFile, syncLinkedCalendars } from './linkedSync';

const ZOHO = 'https://calendar.zoho.in/ical/abc/pvt_1';
const GOOGLE = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-x/basic.ics';
const cal = (url: string, updatedAt: number, extra: Partial<LinkedCalendar> = {}): LinkedCalendar => ({
  id: `id-${url.length}-${updatedAt}`,
  name: 'Cal',
  url,
  color: '#4A90E2',
  enabled: true,
  updatedAt,
  ...extra
});
const NOW = Date.now();
const T = (n: number) => NOW - 1_000_000 + n; // recent moments, in order

describe('mergeLinked', () => {
  it('two devices that each added a calendar end up with both', () => {
    const m = mergeLinked({ calendars: [cal(ZOHO, T(10))], removed: [] }, { calendars: [cal(GOOGLE, T(20))], removed: [] }, NOW);
    expect(m.calendars.map((c) => c.url)).toEqual([ZOHO, GOOGLE]);
  });

  it('the newest rename wins and this device keeps its own id', () => {
    const mine = cal(ZOHO, T(10), { id: 'mine', name: 'Old' });
    const m = mergeLinked({ calendars: [mine], removed: [] }, { calendars: [cal(ZOHO, T(20), { id: 'theirs', name: 'Work' })], removed: [] }, NOW);
    expect(m.calendars).toHaveLength(1);
    expect(m.calendars[0]).toMatchObject({ id: 'mine', name: 'Work' });
  });

  it('a removal newer than the calendar removes it; an add newer than the removal brings it back', () => {
    const removed = mergeLinked({ calendars: [cal(ZOHO, T(10))], removed: [] }, { calendars: [], removed: [{ url: ZOHO, at: T(15) }] }, NOW);
    expect(removed.calendars).toEqual([]);
    expect(removed.removed).toEqual([{ url: ZOHO, at: T(15) }]);
    const readded = mergeLinked({ calendars: [cal(ZOHO, T(20))], removed: [] }, { calendars: [], removed: [{ url: ZOHO, at: T(15) }] }, NOW);
    expect(readded.calendars.map((c) => c.url)).toEqual([ZOHO]);
    expect(readded.removed).toEqual([]);
  });

  it('calendars from before sync existed (no timestamp) are kept, but lose to any removal', () => {
    const legacy = { ...cal(ZOHO, 0) };
    delete legacy.updatedAt;
    expect(mergeLinked({ calendars: [legacy], removed: [] }, null, NOW).calendars).toHaveLength(1);
    expect(mergeLinked({ calendars: [legacy], removed: [] }, { calendars: [], removed: [{ url: ZOHO, at: T(1) }] }, NOW).calendars).toEqual([]);
  });

  it('forgets removals after 180 days', () => {
    const old = NOW - 181 * 86_400_000;
    expect(mergeLinked({ calendars: [], removed: [{ url: ZOHO, at: old }] }, null, NOW).removed).toEqual([]);
  });
});

describe('parseLinkedFile', () => {
  it('skips anything malformed instead of trusting it', () => {
    const text = JSON.stringify({
      v: 1,
      calendars: [
        { id: 'a', name: 'Zoho', url: ZOHO, color: '#FF0000', enabled: false, updatedAt: 5 },
        { url: 'javascript:alert(1)' },
        { url: 'http://insecure.example/cal.ics' },
        { url: GOOGLE, color: 'red; background:url(x)' }
      ],
      removed: [{ url: GOOGLE, at: 3 }, { url: '', at: 1 }, { url: ZOHO }]
    });
    const p = parseLinkedFile(text)!;
    expect(p.calendars.map((c) => c.url)).toEqual([ZOHO, GOOGLE]);
    expect(p.calendars[0]).toMatchObject({ enabled: false, color: '#FF0000', updatedAt: 5 });
    expect(p.calendars[1].color).toBe('#4A90E2');
    expect(p.removed).toEqual([{ url: GOOGLE, at: 3 }]);
    expect(parseLinkedFile('{"v":2}')).toBeNull();
    expect(parseLinkedFile('not json')).toBeNull();
  });
});

describe('the same calendars on every device', () => {
  const mac: Dev = { linkedCalendars: [], linkedRemoved: [] };
  const desk: Dev = { linkedCalendars: [], linkedRemoved: [] };
  const phone: Dev = { linkedCalendars: [], linkedRemoved: [] };
  const on = (d: Dev) => (settings = { ...d });
  const save = (d: Dev) => Object.assign(d, settings);

  beforeEach(() => {
    driveFile = null;
    writes = 0;
    fetched.length = dropped.length = 0;
    for (const d of [mac, desk, phone]) Object.assign(d, { linkedCalendars: [], linkedRemoved: [] });
  });

  it('added in the browser, shows up in Nexus Desk and on the phone; removed on the phone, gone everywhere', async () => {
    on(mac);
    settings.linkedCalendars = [cal(ZOHO, T(100), { id: 'mac-zoho', name: 'Zoho' })];
    await syncLinkedCalendars('t');
    save(mac);
    expect(writes).toBe(1);

    on(desk);
    await syncLinkedCalendars('t');
    save(desk);
    expect(desk.linkedCalendars.map((c) => c.name)).toEqual(['Zoho']);
    expect(fetched).toEqual([ZOHO]); // downloaded straight away
    expect(writes).toBe(1); // nothing new to share

    on(phone);
    await syncLinkedCalendars('t');
    save(phone);
    phone.linkedCalendars = [];
    phone.linkedRemoved = [{ url: ZOHO, at: T(200) }];
    on(phone);
    await syncLinkedCalendars('t');
    save(phone);
    expect(writes).toBe(2);

    for (const d of [mac, desk]) {
      on(d);
      await syncLinkedCalendars('t');
      save(d);
      expect(d.linkedCalendars).toEqual([]);
    }
    expect(dropped).toEqual(['mac-zoho', 'mac-zoho']);
  });

  it('a device with nothing linked and nothing in Drive writes nothing', async () => {
    on(phone);
    await syncLinkedCalendars('t');
    expect(writes).toBe(0);
    expect(driveFile).toBeNull();
  });

  it('two devices that linked calendars before sync existed merge them without duplicates', async () => {
    on(mac);
    settings.linkedCalendars = [{ id: 'a', name: 'Zoho', url: ZOHO, color: '#4A90E2', enabled: true }];
    await syncLinkedCalendars('t');
    save(mac);
    on(desk);
    settings.linkedCalendars = [
      { id: 'b', name: 'Zoho', url: ZOHO, color: '#4A90E2', enabled: true },
      { id: 'c', name: 'Google', url: GOOGLE, color: '#34A853', enabled: true }
    ];
    await syncLinkedCalendars('t');
    save(desk);
    on(mac);
    await syncLinkedCalendars('t');
    save(mac);
    expect(mac.linkedCalendars.map((c) => c.url)).toEqual([ZOHO, GOOGLE]);
    expect(desk.linkedCalendars.map((c) => c.id)).toEqual(['b', 'c']);
  });
});
