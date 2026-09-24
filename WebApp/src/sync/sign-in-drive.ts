import { showDriveScopePrompt } from '../ui/drive-scope-prompt';
import { getSettings } from '../settings/store';
import {
  clearToken,
  fetchGoogleProfile,
  getAccessToken,
  GOOGLE_CLIENT_ID,
  hasDriveAppDataAccess,
  SCOPE
} from './auth';
import { hasRefreshToken, longSessionsAvailable, startRedirectSignIn } from './oauth';

export type SignInResult =
  | { ok: true; email: string }
  | { ok: false; message: string };

const NO_SCOPE_MSG =
  'Drive permission was not granted. Enable “See, create, and delete” on the Google screen to sync.';

/**
 * Sign in with Google and ensure Drive app-data scope (retry consent once if missing).
 */
export async function signInWithDriveScope(hint?: string): Promise<SignInResult> {
  // Stay-signed-in flow: full-page redirect to Google (works in installed apps and on iPhone).
  if (await longSessionsAvailable()) await startRedirectSignIn(GOOGLE_CLIENT_ID, SCOPE, hint);
  for (let attempt = 0; attempt < 2; attempt++) {
    clearToken();
    const token = await getAccessToken(true);
    if (!token) {
      return { ok: false, message: 'Sign-in cancelled' };
    }

    if (await hasDriveAppDataAccess(token)) {
      const profile = await fetchGoogleProfile(token);
      if (!profile.email) {
        clearToken();
        return { ok: false, message: 'Could not read Google account' };
      }
      return { ok: true, email: profile.email };
    }

    clearToken();
    const retry = await showDriveScopePrompt({ finalAttempt: attempt === 1 });
    if (!retry) {
      return { ok: false, message: NO_SCOPE_MSG };
    }
  }

  return { ok: false, message: NO_SCOPE_MSG };
}

/** Returns a token with Drive scope, or null if user declines re-auth. */
export async function ensureDriveToken(): Promise<string | null> {
  if (await longSessionsAvailable()) {
    const quiet = await getAccessToken({ interactive: false });
    if (quiet && (await hasDriveAppDataAccess(quiet))) return quiet;
    // Still holding a refresh token = a temporary problem (offline, Google or the relay down):
    // don't leave the page. Only a revoked / missing token needs Google's sign-in again.
    if ((await hasRefreshToken()) || !navigator.onLine) return null;
    await startRedirectSignIn(GOOGLE_CLIENT_ID, SCOPE, getSettings().googleEmail || undefined);
  }
  let token = await getAccessToken();
  if (token && (await hasDriveAppDataAccess(token))) return token;

  if (token) clearToken();

  const retry = await showDriveScopePrompt();
  if (!retry) return null;

  clearToken();
  token = await getAccessToken(true);
  if (!token) return null;
  if (await hasDriveAppDataAccess(token)) return token;

  clearToken();
  await showDriveScopePrompt({ finalAttempt: true });
  return null;
}
