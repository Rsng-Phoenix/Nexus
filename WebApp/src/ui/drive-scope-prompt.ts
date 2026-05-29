/** Ask user to enable Drive app-data permission on Google's consent screen. */
export function showDriveScopePrompt(opts?: {
  finalAttempt?: boolean;
}): Promise<boolean> {
  const finalAttempt = opts?.finalAttempt ?? false;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'nx-overlay';
    overlay.innerHTML = `
      <div class="nx-sheet" role="dialog" style="max-width:400px">
        <div class="nx-sheet-head">
          <strong>Google Drive permission</strong>
        </div>
        <div class="nx-sheet-body">
          <p style="font-size:14px;color:var(--nx-textSec);line-height:1.55;margin:0 0 12px">
            Nexus needs <strong style="color:var(--nx-textPri)">See, create, and delete</strong>
            access to its hidden app folder in Google Drive so tasks can sync with the Android app.
          </p>
          <p style="font-size:13px;color:var(--nx-textTer);line-height:1.5;margin:0 0 16px">
            On the Google sign-in screen, expand Google Drive (if needed) and
            <strong style="color:var(--nx-textSec)">turn on that permission</strong>.
            Google cannot pre-check it for you.
          </p>
          ${
            finalAttempt
              ? `<p style="font-size:13px;color:#ff4060;line-height:1.45;margin:0 0 12px">
                   Permission still missing. Sign in again and enable Drive access to sync.
                 </p>`
              : ''
          }
          <button type="button" class="nx-btn" data-retry style="width:100%">
            ${finalAttempt ? 'Try sign-in again' : 'Open Google sign-in'}
          </button>
          <button type="button" class="nx-btn ghost" data-cancel style="width:100%;margin-top:8px">
            Not now
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    const done = (retry: boolean) => {
      overlay.remove();
      resolve(retry);
    };
    overlay.querySelector('[data-retry]')?.addEventListener('click', () => done(true));
    overlay.querySelector('[data-cancel]')?.addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(false);
    });
  });
}
