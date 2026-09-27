import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings/store', () => ({ getSettings: () => ({ googleEmail: '', dataOwnerEmail: '' }) }));
vi.mock('./oauth', () => ({ refreshAccessToken: async () => null }));

import { hasDriveAppDataAccess, tokenEmail, tokenHasScope } from './auth';

describe('tokeninfo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the access token in a POST body, never in the URL', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ scope: 'https://www.googleapis.com/auth/drive.appdata openid', email: 'a@b.c' }));
    });
    expect(await hasDriveAppDataAccess('secret-tok')).toBe(true);
    expect(await tokenHasScope('secret-tok', 'openid')).toBe(true);
    expect(await tokenEmail('secret-tok')).toBe('a@b.c');
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).toBe('https://oauth2.googleapis.com/tokeninfo');
      expect(c.url).not.toContain('secret-tok');
      expect(c.init?.method).toBe('POST');
      expect(String(c.init?.body)).toBe('access_token=secret-tok');
    }
  });
});
