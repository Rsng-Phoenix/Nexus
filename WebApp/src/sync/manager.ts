import * as db from '../db/tasks';
import {
  vibrateSyncFail,
  vibrateSyncPulse,
  vibrateSyncSuccess
} from '../lib/haptics';
import { getSettings, patchSettings } from '../settings/store';
import type { Task } from '../types';
import { exportSyncJson, isDeleted, parseSyncJson } from './backup';
import { clearToken, fetchGoogleProfile, getAccessToken } from './auth';
import { findBackup, uploadBackup } from './drive';
import { countActiveRemovals, mergeTasks } from './merge';

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

export async function signIn(): Promise<boolean> {
  const token = await getAccessToken(true);
  if (!token) return false;
  const profile = await fetchGoogleProfile(token);
  patchSettings({
    googleEmail: profile.email,
    googlePhotoUrl: profile.picture,
    displayName: getSettings().displayName || profile.name,
    lastSyncError: ''
  });
  await runSync();
  return true;
}

export async function countDriveTasks(): Promise<number | null> {
  const s = getSettings();
  if (!s.googleEmail) return null;
  try {
    const token = await getAccessToken();
    if (!token) return null;
    const remoteFile = await findBackup(token);
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

export async function runSync(): Promise<{ ok: boolean; message: string }> {
  const s = getSettings();
  if (!s.googleEmail) return { ok: false, message: 'Sign in with Google to sync' };
  if (syncing) return { ok: false, message: 'Sync in progress' };

  syncing = true;
  patchSettings({ lastSyncTime: Date.now() });
  startSyncPulse();

  try {
    const token = await getAccessToken();
    if (!token) throw new Error('Could not get access token');

    const local = await db.getAllTasksIncludingDeleted();
    const remoteFile = await findBackup(token);
    let remoteTasks: Task[] = [];
    let fileId = s.driveFileId || null;

    if (remoteFile) {
      remoteTasks = parseSyncJson(remoteFile.content).tasks;
      fileId = remoteFile.fileId;
      patchSettings({ driveFileId: fileId });
    }

    const localActive = local.filter((t) => t.deletedAt === 0);
    const result = mergeTasks(local, remoteTasks);

    const removals = countActiveRemovals(localActive, result.tasks);
    if (removals > localActive.length * 0.5 && localActive.length > 0) {
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
    return { ok: true, message: 'Synced' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sync failed';
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
