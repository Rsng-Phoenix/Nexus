import { showDriveScopePrompt } from '../ui/drive-scope-prompt';
import {
  clearToken,
  fetchGoogleProfile,
  getAccessToken,
  hasDriveAppDataAccess
} from './auth';

export type SignInResult =
  | { ok: true; email: string }
  | { ok: false; message: string };

const NO_SCOPE_MSG =
  'Drive permission was not granted. Enable “See, create, and delete” on the Google screen to sync.';

/**
 * Sign in with Google and ensure Drive app-data scope (retry consent once if missing).
 */
export async function signInWithDriveScope(): Promise<SignInResult> {
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
