import * as db from '../db/tasks';
import {
  vibrateSyncFail,
  vibrateSyncPulse,
  vibrateSyncSuccess
} from '../lib/haptics';
import { getSettings, patchSettings } from '../settings/store';
import type { Task } from '../types';
import { exportSyncJson, isDeleted, parseSyncJson } from './backup';
import {
  clearToken,
  ensureOAuthClientConsistency,
  fetchGoogleProfile,
  getAccessToken,
  hasDriveAppDataAccess,
  isDriveScopeError
} from './auth';
import { findBackup, uploadBackup } from './drive';
import { countActiveRemovals, mergeTasks } from './merge';
import { ensureDriveToken, signInWithDriveScope } from './sign-in-drive';

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;
let pulseTimer: ReturnType<typeof setInterval> | null = null;

export function scheduleSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void runSync(), 1200);
}

function startSyncPulse(): void {
  stopSyncPulse();
  vibrateSyncPulse();
  pulseTimer = setInterval(() => vibrateSyncPulse(), 900);
}

function stopSyncPulse(): void {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getSettings().googleEmail) {
      scheduleSync();
    }
  });
}

export async function signInMessage(): Promise<string> {
  const result = await signInWithDriveScope();
  if (!result.ok) {
    patchSettings({ lastSyncError: result.message });
    return result.message;
  }
  const token = await getAccessToken();
  if (!token) return 'Sign-in failed';
  const profile = await fetchGoogleProfile(token);
  patchSettings({
    googleEmail: profile.email,
    googlePhotoUrl: profile.picture,
    displayName: getSettings().displayName || profile.name,
    lastSyncError: ''
  });
  const sync = await runSync();
  return sync.ok ? 'Signed in' : sync.message;
}

export async function signIn(): Promise<boolean> {
  const msg = await signInMessage();
  return msg === 'Signed in';
}

export async function countDriveTasks(): Promise<number | null> {
  const s = getSettings();
  if (!s.googleEmail) return null;
  try {
    const token = await getAccessToken({ interactive: false });
    if (!token) return null;
    const remoteFile = await findBackup(token, s.driveFileId);
    if (!remoteFile) return 0;
    return parseSyncJson(remoteFile.content).tasks.filter((t) => !isDeleted(t)).length;
  } catch {
    return null;
  }
}

export function signOut(): void {
  clearToken();
  patchSettings({
    googleEmail: '',
    googlePhotoUrl: '',
    driveFileId: '',
    lastSyncError: ''
  });
}

export async function runSync(options?: {
  /** Skip Google popup when the in-memory token expired (e.g. on page load). */
  background?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  const s = getSettings();
  if (!s.googleEmail) return { ok: false, message: 'Sign in with Google to sync' };
  if (syncing) return { ok: false, message: 'Sync in progress' };

  syncing = true;
  patchSettings({ lastSyncTime: Date.now() });
  startSyncPulse();

  try {
    let token = await getAccessToken(
      options?.background ? { interactive: false } : {}
    );
    if (token && !(await hasDriveAppDataAccess(token))) {
      clearToken();
      token = null;
    }
    if (!token) {
      if (options?.background) {
        stopSyncPulse();
        syncing = false;
        return { ok: false, message: '' };
      }
      token = await ensureDriveToken();
      if (!token) {
        stopSyncPulse();
        syncing = false;
        return {
          ok: false,
          message:
            'Drive permission required. Enable “See, create, and delete” when signing in with Google.'
        };
      }
    }

    const local = await db.getAllTasksIncludingDeleted();
    const localActive = local.filter((t) => t.deletedAt === 0);
    const remoteFile = await findBackup(token, s.driveFileId);
    let remoteTasks: Task[] = [];
    let fileId = s.driveFileId || null;

    if (remoteFile) {
      remoteTasks = parseSyncJson(remoteFile.content).tasks;
      fileId = remoteFile.fileId;
      patchSettings({ driveFileId: fileId });
    } else if (localActive.length === 0) {
      stopSyncPulse();
      syncing = false;
      return {
        ok: false,
        message:
          'No Nexus backup on Drive yet. Open the Android app, tap Sync, then refresh here.'
      };
    }

    const result = mergeTasks(local, remoteTasks);
    const remoteActive = remoteTasks.filter((t) => !isDeleted(t));

    const removals = countActiveRemovals(localActive, result.tasks);
    if (
      removals > localActive.length * 0.5 &&
      localActive.length > 0 &&
      remoteActive.length > 0
    ) {
      const ok = confirm(
        `Sync would remove ${removals} of ${localActive.length} tasks. Continue?`
      );
      if (!ok) {
        stopSyncPulse();
        syncing = false;
        return { ok: false, message: 'Sync cancelled' };
      }
    }

    await db.mergeIntoDb(result.tasks);
    const json = exportSyncJson(await db.getAllTasksIncludingDeleted());
    const newId = await uploadBackup(token, json, fileId);
    patchSettings({
      driveFileId: newId,
      lastSuccessTime: Date.now(),
      lastSyncError: ''
    });
    stopSyncPulse();
    vibrateSyncSuccess();
    syncing = false;
    const pulled =
      localActive.length === 0 && result.downloaded > 0
        ? ` — ${result.downloaded} tasks from Drive`
        : '';
    return { ok: true, message: `Synced${pulled}` };
  } catch (e) {
    let msg = e instanceof Error ? e.message : 'Sync failed';
    if (isDriveScopeError(msg)) {
      clearToken();
      stopSyncPulse();
      syncing = false;
      const token = await ensureDriveToken();
      if (token) return runSync();
      msg =
        'Drive permission required. Enable “See, create, and delete” on the Google sign-in screen.';
    }
    patchSettings({ lastSyncError: msg });
    stopSyncPulse();
    vibrateSyncFail();
    syncing = false;
    return { ok: false, message: msg };
  }
}

export function isSyncing(): boolean {
  return syncing;
}
