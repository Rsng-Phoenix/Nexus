/** Same OAuth Web client as Android strings.xml — add your GitHub Pages origin in Google Cloud Console. */
export const GOOGLE_CLIENT_ID =
  '273347997748-6nmu1ji56r2of8f7604fpcbr94hu9qm9.apps.googleusercontent.com';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata openid email profile';

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

export async function getAccessToken(force = false): Promise<string | null> {
  if (!force && accessToken && Date.now() < tokenExpires - 60000) {
    return accessToken;
  }
  await waitForGsi();
  if (!window.google?.accounts?.oauth2) return null;

  return new Promise((resolve) => {
    if (!tokenClient) {
      tokenClient = window.google!.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
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
    tokenClient.requestAccessToken({ prompt: force ? 'consent' : '' });
  });
}

export function clearToken(): void {
  accessToken = null;
  tokenExpires = 0;
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
