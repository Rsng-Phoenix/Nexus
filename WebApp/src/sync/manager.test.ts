import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let settings: Record<string, unknown> = {};
let token: string | null = null;
let refreshToken = true;
vi.mock('../db/tasks', () => ({
  wipeAllTasks: async () => void calls.push('tasks'),
  wipeAllImages: async () => void calls.push('images'),
  getAllTasksIncludingDeleted: async () => []
}));
vi.mock('../lib/haptics', () => ({ vibrateSyncFail: () => {}, vibrateSyncPulse: () => {}, vibrateSyncSuccess: () => {} }));
vi.mock('../settings/store', () => ({ getSettings: () => settings, patchSettings: (p: object) => void (settings = { ...settings, ...p }) }));
vi.mock('../state/prompts', () => ({ askChoice: async () => 'remove' }));
vi.mock('../state/store', () => ({ reload: async () => void calls.push('reload') }));
vi.mock('./backup', () => ({ effectiveTimestamp: () => 0, exportSyncJson: () => '', isDeleted: () => false, TUTORIAL_UUID_PREFIX: 'nexus-tutorial-' }));
vi.mock('./auth', () => ({
  clearToken: () => {},
  DRIVE_APPDATA_SCOPE: 'drive.appdata',
  fetchGoogleProfile: async () => ({ email: '', name: '', picture: '' }),
  getAccessToken: async () => token,
  hasDriveAppDataAccess: async () => true,
  isDriveScopeError: () => false,
  setToken: () => {},
  tokenEmail: async () => ''
}));
vi.mock('./oauth', () => ({
  clearRefreshToken: async () => {},
  commitRefreshToken: async () => {},
  completeRedirectSignIn: async () => null,
  hasRefreshToken: async () => refreshToken,
  revokeRefreshToken: async () => {},
  revokeToken: async () => {}
}));
vi.mock('../ui/drive-scope-prompt', () => ({ showDriveScopePrompt: async () => false }));
vi.mock('./drive', () => ({ deleteFile: async () => {}, DriveError: class extends Error {}, findBackup: async () => null, uploadBackup: async () => 'f' }));
vi.mock('../calendar/feed', () => ({ syncFeedCreds: async () => {} }));
vi.mock('../calendar/linkedSync', () => ({ syncLinkedCalendars: async () => {} }));
vi.mock('../import/linkedSheetsSync', () => ({ syncLinkedSheets: async () => {} }));
vi.mock('../import/liveSheet', () => ({ forgetAllLinkedSheets: async () => void calls.push('sheets') }));
vi.mock('./images', () => ({ syncImages: async () => {} }));
vi.mock('./merge', () => ({ countActiveRemovals: () => 0, mergeTasks: () => ({ tasks: [], downloaded: 0 }) }));
vi.mock('./sign-in-drive', () => ({ ensureDriveToken: async () => null, signInWithDriveScope: async () => ({ ok: false, message: '' }) }));

import { backgroundNoTokenResult, runSync, signOutFlow } from './manager';

beforeEach(() => {
  calls.length = 0;
  settings = { googleEmail: 'me@x.com', dataOwnerEmail: 'me@x.com', lastSuccessTime: 0, linkedCalendars: [{ id: 'c' }] };
  token = null;
  refreshToken = true;
  vi.stubGlobal('navigator', { onLine: true });
});

describe('sign out with "Remove tasks from this device"', () => {
  it('removes tasks, pictures and linked sheets; linked calendars stay', async () => {
    expect(await signOutFlow()).toBe('Signed out · tasks removed from this device');
    expect(calls).toEqual(['tasks', 'images', 'sheets', 'reload']);
    expect(settings.linkedCalendars).toEqual([{ id: 'c' }]);
  });
});

describe('a background sync without a token', () => {
  it('offline: waits, never asks to reconnect', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const r = await runSync({ background: true });
    expect(r.ok).toBe(false);
    expect(r.needsReconnect).toBeUndefined();
    expect(r.message).toMatch(/offline/);
  });

  it('online but the refresh did not get through: waits too', async () => {
    const r = await runSync({ background: true });
    expect(r.ok).toBe(false);
    expect(r.needsReconnect).toBeUndefined();
  });

  it('the refresh token is gone (revoked): asks to reconnect', async () => {
    refreshToken = false;
    expect((await runSync({ background: true })).needsReconnect).toBe(true);
  });

  it('asks to reconnect only when access is really gone', () => {
    expect(backgroundNoTokenResult({ online: true, hasRefreshToken: false, scopeMissing: false }).needsReconnect).toBe(true);
    expect(backgroundNoTokenResult({ online: true, hasRefreshToken: true, scopeMissing: true }).needsReconnect).toBe(true);
    expect(backgroundNoTokenResult({ online: false, hasRefreshToken: false, scopeMissing: false }).needsReconnect).toBeUndefined();
    expect(backgroundNoTokenResult({ online: true, hasRefreshToken: true, scopeMissing: false }).needsReconnect).toBeUndefined();
  });
});
