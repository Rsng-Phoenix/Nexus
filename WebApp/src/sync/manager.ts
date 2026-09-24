import * as db from '../db/tasks';
import {
  vibrateSyncFail,
  vibrateSyncPulse,
  vibrateSyncSuccess
} from '../lib/haptics';
import { getSettings, patchSettings } from '../settings/store';
import { exportSyncJson, isDeleted } from './backup';
import {
  clearToken,
  fetchGoogleProfile,
  getAccessToken,
  hasDriveAppDataAccess,
  isDriveScopeError
} from './auth';
import { deleteFile, DriveError, findBackup, uploadBackup } from './drive';
import { countActiveRemovals, mergeTasks } from './merge';
import { ensureDriveToken, signInWithDriveScope } from './sign-in-drive';

export type SyncResult = { ok: boolean; message: string; needsReconnect?: boolean };

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;
/** A sync was requested while one was running: run once more when it finishes. */
let rerun = false;
let pulseTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(syncing: boolean, result?: SyncResult) => void>();

/** UI hook: profile chip glow, "Syncing…" rows, sync pill. */
export function onSyncState(fn: (syncing: boolean, result?: SyncResult) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(result?: SyncResult) {
  listeners.forEach((fn) => fn(syncing, result));
}

/** Debounced background sync after local edits. Never opens a Google popup. */
export function scheduleSync(delayMs = 1200): void {
  if (!getSettings().googleEmail) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void runSync({ background: true }), delayMs);
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
    if (document.visibilityState === 'visible') scheduleSync(300);
  });
  window.addEventListener('online', () => scheduleSync(300));
}

export async function signInMessage(): Promise<string> {
  const result = await signInWithDriveScope();
  if (!result.ok) {
    patchSettings({ lastSyncError: result.message });
    return result.message;
  }
  const token = await getAccessToken({ interactive: false });
  if (!token) return 'Sign-in failed';
  const profile = await fetchGoogleProfile(token);
  const prev = getSettings().googleEmail;
  patchSettings({
    googleEmail: profile.email,
    googlePhotoUrl: profile.picture,
    displayName: getSettings().displayName || profile.name,
    lastSyncError: '',
    ...(prev && prev !== profile.email ? { driveFileId: '' } : {})
  });
  const sync = await runSync();
  return sync.ok ? 'Signed in' : sync.message;
}

export async function signIn(): Promise<boolean> {
  return (await signInMessage()) === 'Signed in';
}

export async function countDriveTasks(): Promise<number | null> {
  if (!getSettings().googleEmail) return null;
  try {
    const token = await getAccessToken({ interactive: false });
    if (!token) return null;
    const remote = await findBackup(token);
    if (!remote) return 0;
    return new Set(remote.tasks.filter((t) => !isDeleted(t)).map((t) => t.taskUuid)).size;
  } catch {
    return null;
  }
}

export function signOut(): void {
  clearToken();
  patchSettings({ googleEmail: '', googlePhotoUrl: '', driveFileId: '', lastSyncError: '' });
}

/**
 * download → merge → write IndexedDB → upload. [background] syncs (after edits, on focus,
 * on load) never open the Google popup; when the session has expired they report
 * `needsReconnect` so the UI can offer a one-tap reconnect instead of hanging.
 */
export async function runSync(options?: { background?: boolean }): Promise<SyncResult> {
  const background = options?.background ?? false;
  const s = getSettings();
  if (!s.googleEmail) return { ok: false, message: 'Sign in with Google to sync' };
  if (syncing) {
    rerun = true;
    return { ok: false, message: 'Sync in progress' };
  }

  syncing = true;
  rerun = false;
  patchSettings({ lastSyncTime: Date.now() });
  if (!background) startSyncPulse();
  emit();

  let result: SyncResult;
  try {
    result = await syncOnce(background);
  } catch (e) {
    let msg = e instanceof Error ? e.message : 'Sync failed';
    if (isDriveScopeError(msg)) {
      clearToken();
      msg = 'Google Drive permission is missing. Tap Sync to reconnect.';
      result = { ok: false, message: msg, needsReconnect: true };
    } else {
      result = { ok: false, message: e instanceof DriveError ? 'Drive is unreachable right now' : msg };
    }
    patchSettings({ lastSyncError: result.message });
  } finally {
    stopSyncPulse();
    syncing = false;
  }
  if (result.ok) {
    if (!background) vibrateSyncSuccess();
  } else if (result.message && !background) {
    vibrateSyncFail();
  }
  emit(result);
  if (rerun) {
    rerun = false;
    scheduleSync(200);
  }
  return result;
}

async function syncOnce(background: boolean): Promise<SyncResult> {
  let token = await getAccessToken({ interactive: false });
  if (token && !(await hasDriveAppDataAccess(token))) {
    clearToken();
    token = null;
  }
  if (!token) {
    if (background) {
      return { ok: false, message: 'Tap to reconnect Google Drive', needsReconnect: true };
    }
    token = await ensureDriveToken();
    if (!token) {
      return {
        ok: false,
        message: 'Drive permission required. Enable “See, create, and delete” when signing in with Google.',
        needsReconnect: true
      };
    }
  }

  const s = getSettings();
  await db.purgeExpired(s.retentionDays || 15);
  const local = await db.getAllTasksIncludingDeleted();
  const localActive = local.filter((t) => t.deletedAt === 0);
  const remote = await findBackup(token);

  const merge = mergeTasks(local, remote?.tasks ?? []);
  const removals = countActiveRemovals(localActive, merge.tasks);
  if (removals > localActive.length * 0.5 && removals > 3) {
    // Never ask during background syncs; the user confirms on the next manual sync.
    if (background) return { ok: false, message: `Sync paused: it would remove ${removals} tasks` };
    const ok = confirm(`Sync would remove ${removals} of ${localActive.length} tasks. Continue?`);
    if (!ok) return { ok: false, message: 'Sync cancelled' };
  }

  await db.mergeIntoDb(merge.tasks, local);
  const json = exportSyncJson(await db.getAllTasksIncludingDeleted());
  // A missing file means create a new one; a stale cached id is never reused.
  const fileId = await uploadBackup(token, json, remote?.fileId ?? null);
  for (const dup of remote?.duplicateIds ?? []) await deleteFile(token, dup);

  patchSettings({ driveFileId: fileId, lastSuccessTime: Date.now(), lastSyncError: '' });
  const pulled = merge.downloaded > 0 ? ` · ${merge.downloaded} from Drive` : '';
  return { ok: true, message: `Synced${pulled}` };
}

export function isSyncing(): boolean {
  return syncing;
}
