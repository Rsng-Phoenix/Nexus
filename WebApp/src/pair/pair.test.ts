import { describe, expect, it } from 'vitest';
import type { Settings } from '../settings/store';
import { b64u, cleanPayload, newCalendars, newPairLink, openPayload, pairUrl, parsePairLink, sealPayload, unb64u, verifyCode, type SetupPayload, cleanMapping } from './pair';

const payload: SetupPayload = {
  v: 1,
  from: 'Chrome on Mac',
  at: 1,
  calendars: [{ name: 'Work', url: 'https://calendar.google.com/calendar/ical/me%40x.in/private-abc/basic.ics', color: '#4285F4', enabled: true }],
  prefs: { weekStart: 0, clashRadar: false },
  account: 'me@x.in'
};
const defaults = { weekStart: 1, clashRadar: true, themeMode: 'SYSTEM', displayName: '' } as unknown as Settings;

describe('scan to set up', () => {
  it('round-trips a setup and nobody else can open it', async () => {
    const link = newPairLink('get');
    const blob = await sealPayload(link, payload);
    expect(blob).not.toContain('calendar.google.com');
    expect(await openPayload(link, blob).then((p) => cleanPayload(p, defaults))).toEqual(payload);
    await expect(openPayload({ ...link, key: newPairLink('get').key }, blob)).rejects.toBeTruthy();
    // The id is bound in: a blob can't be replayed under another code.
    await expect(openPayload({ ...link, id: newPairLink('get').id }, blob)).rejects.toBeTruthy();
  });

  it('builds and reads links; rejects anything else', () => {
    const link = newPairLink('send');
    const url = pairUrl(link, 'https://rsng-phoenix.github.io/Nexus/');
    expect(url).toMatch(/^https:\/\/rsng-phoenix\.github\.io\/Nexus\/\?pair=[\w-]{22}&m=send#k=[\w-]{43}$/);
    expect(parsePairLink(url)).toEqual(link);
    expect(parsePairLink('https://evil.example/?pair=x&m=get#k=y')).toBeNull();
    expect(parsePairLink(url.replace('m=send', 'm=steal'))).toBeNull();
    expect(parsePairLink('not a url')).toBeNull();
  });

  it('shows the same 4-digit check on both screens', async () => {
    const link = newPairLink('get');
    const a = await verifyCode(link);
    expect(a).toMatch(/^\d{4}$/);
    expect(await verifyCode({ ...link })).toBe(a);
  });

  it('keeps only well-formed data from the other device', () => {
    const p = cleanPayload(
      {
        v: 1,
        from: 'x'.repeat(200),
        calendars: [{ url: 'javascript:alert(1)' }, { url: 'http://insecure.example/cal.ics' }, { name: 'Ok', url: 'https://calendar.zoho.in/ical/a', color: 'red' }],
        prefs: { weekStart: 0, clashRadar: 'yes', evil: 1, themeMode: 'DARK' },
        account: 'not an email'
      },
      defaults
    );
    expect(p.from.length).toBe(60);
    expect(p.calendars).toEqual([{ name: 'Ok', url: 'https://calendar.zoho.in/ical/a', color: '#3B9EFF', enabled: true }]);
    expect(p.prefs).toEqual({ weekStart: 0, themeMode: 'DARK' });
    expect(p.account).toBeUndefined();
    expect(() => cleanPayload({ v: 2 }, defaults)).toThrow('newer Nexus');
  });

  it('only adds calendars this device does not have', () => {
    const have = [{ id: '1', name: 'Work', url: payload.calendars[0].url, color: '#000', enabled: true }];
    expect(newCalendars(payload, have)).toEqual([]);
    expect(newCalendars(payload, [])).toHaveLength(1);
  });

  it('base64url round-trips bytes', () => {
    const b = new Uint8Array([0, 255, 62, 63, 250, 1]);
    expect(Array.from(unb64u(b64u(b)))).toEqual(Array.from(b));
  });
});

describe('linked Google Sheets travel with a setup', () => {
  const good = {
    name: 'Appointments',
    sheetId: '1eauNFUiHzr8Pp2P6BDrjUbh_tTQIOTqz',
    gid: '',
    mapping: { headerRow: 0, titleCols: [], titleText: 'Appointment', dateCol: 8, notesCols: [1, 6], priority: 'MEDIUM', offsets: [0, -1], alertTime: 540, dayFirst: true }
  };
  it('keeps a well-formed sheet and its column choices', () => {
    const p = cleanPayload({ v: 1, from: 'Mac', at: 1, calendars: [], prefs: {}, sheets: [good] });
    expect(p.sheets).toEqual([good]);
  });
  it('drops sheets with a bad address or unusable columns, and older senders without sheets still work', () => {
    const bad = [
      { ...good, sheetId: '../../etc' },
      { ...good, gid: '0; drop' },
      { ...good, mapping: { ...good.mapping, dateCol: -1 } },
      { ...good, mapping: { ...good.mapping, titleCols: [], titleText: '' } },
      { ...good, mapping: null }
    ];
    expect(cleanPayload({ v: 1, calendars: [], prefs: {}, sheets: bad }).sheets ?? []).toEqual([]);
    expect(cleanPayload({ v: 1, calendars: [], prefs: {} }).sheets).toBeUndefined();
  });
  it('clamps odd values instead of trusting them', () => {
    const m = cleanMapping({ ...good.mapping, priority: 'URGENT', alertTime: 99999, offsets: [0, 'x', 9999, -1], titleText: 'x'.repeat(200) })!;
    expect(m.priority).toBe('MEDIUM');
    expect(m.alertTime).toBe(540);
    expect(m.offsets).toEqual([0, -1]);
    expect(m.titleText).toHaveLength(80);
  });
});
