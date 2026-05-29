import { topBarGreeting, syncStatusLabel } from '../settings/store';
import { signInMessage, signOut, runSync } from '../sync/manager';

export function showProfileSheet(opts: {
  localTaskCount: number;
  driveTaskCount: number | null;
  onOpenSettings: () => void;
  onReload: () => void | Promise<void>;
  snack: (msg: string) => void;
}): { setDriveTaskCount: (count: number) => void } {
  const overlay = document.createElement('div');
  overlay.className = 'nx-overlay';
  overlay.innerHTML = `
    <div class="nx-sheet" role="dialog">
      <div class="nx-sheet-head">
        <strong>${escape(topBarGreeting())}</strong>
        <button class="nx-btn ghost" data-x type="button">✕</button>
      </div>
      <div class="nx-sheet-body nx-profile-body">
        <p class="nx-profile-counts">${opts.localTaskCount} tasks on this device</p>
        <p class="nx-profile-counts" data-drive-count hidden></p>
        <p class="nx-profile-sync-label">${escape(syncStatusLabel())}</p>
        <button type="button" class="nx-btn" data-sync style="width:100%;margin-top:12px">Sync now</button>
        <button type="button" class="nx-btn ghost" data-signout style="width:100%;margin-top:8px">Sign out</button>
        <button type="button" class="nx-btn ghost nx-profile-settings-link" data-settings>⚙ Open settings</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-x]')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  overlay.querySelector('[data-settings]')?.addEventListener('click', () => {
    close();
    opts.onOpenSettings();
  });
  overlay.querySelector('[data-signout]')?.addEventListener('click', () => {
    signOut();
    close();
    void opts.onReload();
  });
  overlay.querySelector('[data-sync]')?.addEventListener('click', async () => {
    const r = await runSync();
    await opts.onReload();
    opts.snack(r.message);
    close();
  });

  const driveEl = overlay.querySelector('[data-drive-count]') as HTMLElement | null;
  if (opts.driveTaskCount !== null) {
    setDriveTaskCount(opts.driveTaskCount);
  }

  function setDriveTaskCount(count: number): void {
    if (!driveEl || !overlay.isConnected) return;
    driveEl.hidden = false;
    driveEl.textContent = `${count} tasks in Google Drive`;
  }

  return { setDriveTaskCount };
}

export function showProfileSignInSheet(opts: {
  onOpenSettings: () => void;
  onReload: () => void | Promise<void>;
  snack: (msg: string) => void;
}): void {
  const overlay = document.createElement('div');
  overlay.className = 'nx-overlay';
  overlay.innerHTML = `
    <div class="nx-sheet" role="dialog">
      <div class="nx-sheet-head">
        <strong>${escape(topBarGreeting())}</strong>
        <button class="nx-btn ghost" data-x type="button">✕</button>
      </div>
      <div class="nx-sheet-body nx-profile-body">
        <p class="nx-profile-sync-label">Offline — sign in to sync with Android</p>
        <p style="font-size:12px;color:var(--nx-textTer);line-height:1.45;margin:10px 0 0">
          On Google’s screen, enable <strong style="color:var(--nx-textSec)">See, create, and delete</strong>
          for Drive so your tasks can sync.
        </p>
        <button type="button" class="nx-btn" data-signin style="width:100%;margin-top:14px">Sign in with Google</button>
        <button type="button" class="nx-btn ghost nx-profile-settings-link" data-settings>⚙ Open settings</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-x]')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('[data-settings]')?.addEventListener('click', () => {
    close();
    opts.onOpenSettings();
  });
  overlay.querySelector('[data-signin]')?.addEventListener('click', async () => {
    const msg = await signInMessage();
    opts.snack(msg);
    await opts.onReload();
    close();
  });
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
