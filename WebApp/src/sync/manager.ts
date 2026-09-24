import * as db from '../db/tasks';
import {
  vibrateSyncFail,
  vibrateSyncPulse,
  vibrateSyncSuccess
} from '../lib/haptics';
import { getSettings, patchSettings } from '../settings/store';
import { askChoice } from '../state/prompts';
import { reload } from '../state/store';
import { effectiveTimestamp, exportSyncJson, isDeleted, TUTORIAL_UUID_PREFIX } from './backup';
import {
  clearToken,
  DRIVE_APPDATA_SCOPE,
  fetchGoogleProfile,
  getAccessToken,
  hasDriveAppDataAccess,
  isDriveScopeError,
  setToken,
  tokenEmail
} from './auth';
import { clearRefreshToken, commitRefreshToken, completeRedirectSignIn, hasRefreshToken, revokeRefreshToken, revokeToken } from './oauth';
import { showDriveScopePrompt } from '../ui/drive-scope-prompt';
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

/**
 * True while a sign-in waits for the user to decide about the tasks on this device. Nothing may
 * sync meanwhile, or one account's tasks could reach another account's Drive.
 */
let signInPending = false;

/** Debounced background sync after local edits. Never opens a Google popup. */
export function scheduleSync(delayMs = 1200): void {
  if (!getSettings().googleEmail || signInPending) return;
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
  // With long sessions this leaves the page for Google and finishes in finishRedirectSignIn().
  const result = await signInWithDriveScope();
  if (!result.ok) {
    patchSettings({ lastSyncError: result.message });
    return result.message;
  }
  const token = await getAccessToken({ interactive: false });
  if (!token) return 'Sign-in failed';
  return finishSignIn(token);
}

/** Page load after Google redirected back. Returns a message for a snackbar, or null. */
export async function finishRedirectSignIn(): Promise<string | null> {
  const r = await completeRedirectSignIn();
  if (!r) return null;
  if (!r.ok) {
    return r.error === 'cancelled' ? 'Sign-in cancelled' : r.error === 'offline' ? "You're offline — try signing in again" : 'Sign-in failed. Please try again.';
  }
  if (!r.tokens.scope.includes(DRIVE_APPDATA_SCOPE)) {
    if (r.tokens.refresh_token) await revokeToken(r.tokens.refresh_token);
    // Google lets people untick Drive on the consent screen; explain and let them retry.
    if (await showDriveScopePrompt()) {
      await signInWithDriveScope();
    }
    return 'Drive permission is needed to sync';
  }
  // The new tokens are only stored once the user has settled the local tasks (finishSignIn).
  return finishSignIn(r.tokens.access_token, { expiresIn: r.tokens.expires_in, refreshToken: r.tokens.refresh_token });
}

/** Tasks here that aren't tutorial demos or tombstones. */
async function localUserTasks() {
  return (await db.getAllTasksIncludingDeleted()).filter(
    (t) => t.deletedAt === 0 && !t.taskUuid.startsWith(TUTORIAL_UUID_PREFIX)
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Before the first sync with [email]: never silently pour one account's tasks into another's
 * Drive. Returns false when the user cancels the sign-in.
 */
async function settleLocalData(email: string): Promise<boolean> {
  const s = getSettings();
  const owner = s.dataOwnerEmail;
  if (owner && owner.toLowerCase() === email.toLowerCase()) return true;
  const local = await localUserTasks();
  if (local.length === 0) {
    await db.wipeAllTasks(); // only tombstones/demos from before: start clean
    await reload();
    return true;
  }
  const n = plural(local.length, 'task');
  const choice = await askChoice({
    title: 'Tasks already on this device',
    body: owner
      ? `This device has ${n} from ${owner}. You're signing in as ${email}.`
      : `This device has ${n} that aren't backed up to any Google account yet. You're signing in as ${email}.`,
    options: owner
      ? [
          { id: 'replace', label: `Use only ${email}'s tasks`, detail: `Removes ${owner}'s tasks from this device. They stay safe in ${owner}'s Drive.`, tone: 'primary', recommended: true },
          { id: 'merge', label: `Add them to ${email}`, detail: `Copies these ${n} into ${email}'s Drive as well.` }
        ]
      : [
          { id: 'merge', label: `Add them to ${email}`, detail: `Backs up these ${n} to ${email}'s Drive and keeps them in sync.`, tone: 'primary', recommended: true },
          { id: 'replace', label: `Use only ${email}'s tasks`, detail: `Deletes these ${n} from this device. They aren't backed up anywhere.`, tone: 'danger' }
        ],
    cancelLabel: 'Cancel sign-in'
  });
  if (!choice) return false;
  if (choice === 'replace') {
    // Edits made after the last sync with the previous owner exist only here.
    const since = s.ownerSyncedAt;
    const unsynced = owner
      ? (await db.getAllTasksIncludingDeleted()).filter((t) => !t.taskUuid.startsWith(TUTORIAL_UUID_PREFIX) && effectiveTimestamp(t) > since).length
      : 0;
    if (unsynced > 0) {
      const sure = await askChoice({
        title: `${plural(unsynced, 'change')} never reached ${owner}'s Drive`,
        body: `They were made on this device after it last synced with ${owner}. Removing the tasks now would lose them.`,
        options: [
          { id: 'merge', label: `Add everything to ${email} instead`, tone: 'primary', recommended: true },
          { id: 'wipe', label: 'Remove anyway', detail: 'Those changes will be lost.', tone: 'danger' }
        ],
        cancelLabel: 'Cancel sign-in'
      });
      if (!sure) return false;
      if (sure === 'merge') return true;
    }
    await db.wipeAllTasks();
    await reload();
  }
  return true;
}

/**
 * [pending] carries tokens from the redirect sign-in that are not stored yet; without it (popup
 * sign-in) the token is already live.
 */
async function finishSignIn(token: string, pending?: { expiresIn: number; refreshToken?: string }): Promise<string> {
  signInPending = true;
  let profile: Awaited<ReturnType<typeof fetchGoogleProfile>>;
  try {
    profile = await fetchGoogleProfile(token);
    if (!profile.email) throw new Error('no email');
  } catch {
    signInPending = false;
    if (pending?.refreshToken) await revokeToken(pending.refreshToken);
    else clearToken();
    return 'Could not read Google account';
  }
  let settled = false;
  try {
    settled = await settleLocalData(profile.email);
  } finally {
    signInPending = false;
  }
  if (!settled) {
    // Only the new sign-in is undone; the previous account's session is left as it was.
    if (pending?.refreshToken) await revokeToken(pending.refreshToken);
    if (!pending) clearToken();
    return 'Sign-in cancelled';
  }
  const prev = getSettings().googleEmail;
  if (pending) {
    setToken(token, pending.expiresIn);
    if (pending.refreshToken) await commitRefreshToken(pending.refreshToken);
    else if (prev.toLowerCase() !== profile.email.toLowerCase()) await clearRefreshToken(); // never keep another account's
  }
  patchSettings({
    googleEmail: profile.email,
    googlePhotoUrl: profile.picture,
    displayName: getSettings().displayName || profile.name,
    lastSyncError: '',
    dataOwnerEmail: profile.email,
    ...(prev !== profile.email ? { driveFileId: '', lastSuccessTime: 0 } : {})
  });
  const sync = await runSync();
  return sync.ok ? `Signed in as ${profile.email}` : sync.message;
}

export async function signIn(): Promise<boolean> {
  return (await signInMessage()).startsWith('Signed in');
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

/** Changes on this device newer than the last successful sync. */
async function unsyncedCount(): Promise<number> {
  const since = getSettings().lastSuccessTime;
  return (await db.getAllTasksIncludingDeleted()).filter(
    (t) => !t.taskUuid.startsWith(TUTORIAL_UUID_PREFIX) && effectiveTimestamp(t) > since
  ).length;
}

/**
 * Sign out, asking what happens to the tasks on this device. Returns a snackbar message, or
 * null if the user backed out.
 */
export async function signOutFlow(): Promise<string | null> {
  const email = getSettings().googleEmail;
  if (!email) return null;
  const choice = await askChoice({
    title: `Sign out of ${email}?`,
    body: 'Your tasks are safe in Google Drive. What should stay on this device?',
    options: [
      { id: 'remove', label: 'Remove tasks from this device', detail: 'Best on a shared or work computer. Sign in again any time to get them back.', tone: 'primary', recommended: true },
      { id: 'keep', label: 'Keep a copy on this device', detail: `They stay here but won't sync until you sign in to ${email} again.` }
    ]
  });
  if (!choice) return null;
  if (choice === 'remove') {
    // Make sure nothing is lost: push pending edits to Drive first.
    if ((await unsyncedCount()) > 0) {
      const r = await runSync({ background: true });
      const left = r.ok ? 0 : await unsyncedCount();
      if (left > 0) {
        const go = await askChoice({
          title: "Some changes haven't synced",
          body: `${plural(left, 'change')} on this device couldn't reach Google Drive (${r.message}). Removing now would lose them.`,
          options: [
            { id: 'keep', label: 'Keep a copy on this device instead', tone: 'primary', recommended: true },
            { id: 'remove', label: 'Remove anyway', detail: 'Unsynced changes will be lost.', tone: 'danger' }
          ],
          cancelLabel: 'Stay signed in'
        });
        if (!go) return null;
        if (go === 'keep') return signOutFinish('keep');
      }
    }
  }
  return signOutFinish(choice as 'remove' | 'keep');
}

async function signOutFinish(choice: 'remove' | 'keep'): Promise<string> {
  clearToken();
  await revokeRefreshToken();
  const owner = getSettings().googleEmail;
  patchSettings({
    googleEmail: '',
    googlePhotoUrl: '',
    driveFileId: '',
    lastSyncError: '',
    lastSuccessTime: 0,
    ...(choice === 'remove' ? { ownerSyncedAt: 0 } : {}),
    // Kept tasks still belong to that account, so signing in to it again just syncs.
    dataOwnerEmail: choice === 'keep' ? owner : ''
  });
  if (choice === 'remove') {
    await db.wipeAllTasks();
    await reload(); // reminders re-publish from the (now empty) task list
    return 'Signed out · tasks removed from this device';
  }
  return 'Signed out · tasks kept on this device';
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
  if (signInPending) return { ok: false, message: 'Finishing sign-in…' };
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
    if (!navigator.onLine) return { ok: false, message: "You're offline — changes will sync when you're back" };
    token = await ensureDriveToken();
    if (!token && (await hasRefreshToken())) {
      return { ok: false, message: "Couldn't reach Google Drive. Try again in a moment." };
    }
    if (!token) {
      return {
        ok: false,
        message: 'Drive permission required. Enable “See, create, and delete” when signing in with Google.',
        needsReconnect: true
      };
    }
  }

  const s = getSettings();
  // The token must belong to the signed-in account (e.g. someone picked another account on
  // Google's screen during a reconnect): never sync one account's tasks into another's Drive.
  const who = await tokenEmail(token);
  if (who && who.toLowerCase() !== s.googleEmail.toLowerCase()) {
    clearToken();
    return { ok: false, message: `Google signed in as ${who}, not ${s.googleEmail}. Sign in again with ${s.googleEmail}.`, needsReconnect: true };
  }
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

  const done = Date.now();
  patchSettings({ driveFileId: fileId, lastSuccessTime: done, ownerSyncedAt: done, lastSyncError: '' });
  const pulled = merge.downloaded > 0 ? ` · ${merge.downloaded} from Drive` : '';
  return { ok: true, message: `Synced${pulled}` };
}

export function isSyncing(): boolean {
  return syncing;
}
