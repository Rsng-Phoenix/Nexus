/**
 * Must match Android `default_web_client_id` in app/src/main/res/values/strings.xml
 * so both clients share the same Drive appDataFolder for nexus_backup.json.
 * Add your deployed origin under Authorized JavaScript origins in Google Cloud Console.
 */
export const GOOGLE_CLIENT_ID =
  '273347997748-6nmu1ji56r2of8f7604fpcbr94hu9qm9.apps.googleusercontent.com';

const OAUTH_CLIENT_STORAGE_KEY = 'nexus_oauth_client_id';

/** Clears cached Drive file id when the OAuth client changes (different appDataFolder). */
export function ensureOAuthClientConsistency(
  onClientChanged: () => void
): void {
  try {
    const prev = localStorage.getItem(OAUTH_CLIENT_STORAGE_KEY);
    if (prev && prev !== GOOGLE_CLIENT_ID) onClientChanged();
    localStorage.setItem(OAUTH_CLIENT_STORAGE_KEY, GOOGLE_CLIENT_ID);
  } catch {
    /* ignore */
  }
}

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SCOPE = `${DRIVE_APPDATA_SCOPE} openid email profile`;

let tokenClient: {
  requestAccessToken: (o?: { prompt?: string }) => void;
} | null = null;
let accessToken: string | null = null;
let tokenExpires = 0;

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: {
            client_id: string;
            scope: string;
            callback: (r: { access_token?: string; expires_in?: number; error?: string }) => void;
          }) => { requestAccessToken: (o?: { prompt?: string }) => void };
        };
      };
    };
  }
}

function waitForGsi(): Promise<void> {
  return new Promise((resolve) => {
    if (window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const t = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(t);
        resolve();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(t);
      resolve();
    }, 8000);
  });
}

export type GetAccessTokenOptions = {
  force?: boolean;
  /** When false, never opens the Google account popup (silent refresh only). */
  interactive?: boolean;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
};

let pendingTokenResolve: ((token: string | null) => void) | null = null;

function ensureTokenClient(): void {
  if (tokenClient) return;
  tokenClient = window.google!.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: (resp: TokenResponse) => {
      const resolve = pendingTokenResolve;
      pendingTokenResolve = null;
      if (!resolve) return;
      if (resp.error || !resp.access_token) {
        resolve(null);
        return;
      }
      accessToken = resp.access_token;
      tokenExpires = Date.now() + (resp.expires_in ?? 3600) * 1000;
      resolve(accessToken);
    }
  });
}

export async function getAccessToken(
  opts: GetAccessTokenOptions | boolean = {}
): Promise<string | null> {
  const o: GetAccessTokenOptions =
    typeof opts === 'boolean' ? { force: opts, interactive: true } : opts;
  const force = o.force ?? false;
  const interactive = o.interactive ?? true;

  if (!force && accessToken && Date.now() < tokenExpires - 60000) {
    return accessToken;
  }

  if (!interactive) {
    return null;
  }

  await waitForGsi();
  if (!window.google?.accounts?.oauth2) return null;

  return new Promise((resolve) => {
    ensureTokenClient();
    pendingTokenResolve = resolve;
    const prompt = force ? 'consent' : '';
    tokenClient!.requestAccessToken({ prompt });
  });
}

export function clearToken(): void {
  accessToken = null;
  tokenExpires = 0;
  pendingTokenResolve = null;
}

/** True if token can read the Drive app data folder (see / create / delete app backup). */
export async function hasDriveAppDataAccess(token: string): Promise<boolean> {
  try {
    const info = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`
    );
    if (info.ok) {
      const data = (await info.json()) as { scope?: string; error?: string };
      if (!data.error && (data.scope ?? '').includes('drive.appdata')) return true;
    }
  } catch {
    /* fall through to probe */
  }
  try {
    const probe = await fetch(
      'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&pageSize=1&fields=files(id)',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return probe.ok;
  } catch {
    return false;
  }
}

export function isDriveScopeError(message: string): boolean {
  return /insufficient|403|access_not_configured|scope|forbidden/i.test(message);
}

export async function fetchGoogleProfile(token: string): Promise<{
  email: string;
  name: string;
  picture: string;
}> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('profile fetch failed');
  const u = (await res.json()) as {
    email?: string;
    name?: string;
    picture?: string;
  };
  return {
    email: u.email ?? '',
    name: u.name ?? '',
    picture: u.picture ?? ''
  };
}
