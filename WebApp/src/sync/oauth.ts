import { PUSH_WORKER_URL } from '../config';
import { deleteMeta, getMetaValue, setMetaValue } from '../db/tasks';

/**
 * Sign-in that lasts. Google gives browser apps only 1-hour tokens, so on its own the web app
 * "logs out" every hour. Here the app does a normal OAuth redirect (PKCE, offline access); the
 * Nexus worker adds the client secret to swap the one-time code for a refresh token, which is
 * returned to this device only (the worker stores nothing). The refresh token is kept in
 * IndexedDB encrypted with a non-extractable AES key, so it can't be copied off the device.
 * If the worker has no client secret configured, everything falls back to the hourly popup flow.
 */

const FLOW_KEY = 'nexus_oauth_flow';
const RT_KEY = 'g_rt';
const RT_CRYPTO_KEY = 'g_rt_key';
const CONFIG_KEY = 'nexus_oauth_cfg';

type Flow = { state: string; verifier: string; redirect: string; at: number };
export type TokenSet = { access_token: string; expires_in: number; scope: string; refresh_token?: string };

let configured: Promise<boolean> | null = null;

/** True when the worker can mint refresh tokens (GOOGLE_CLIENT_SECRET is set). */
export function longSessionsAvailable(): Promise<boolean> {
  if (!PUSH_WORKER_URL) return Promise.resolve(false);
  configured ??= (async () => {
    try {
      const cached = sessionStorage.getItem(CONFIG_KEY);
      if (cached) return cached === '1';
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch(`${PUSH_WORKER_URL}/oauth/config`, { signal: AbortSignal.timeout(6000) });
      const on = res.ok && ((await res.json()) as { enabled?: boolean }).enabled === true;
      try {
        sessionStorage.setItem(CONFIG_KEY, on ? '1' : '0');
      } catch {
        /* ignore */
      }
      return on;
    } catch {
      configured = null; // offline: ask again next time
      return false;
    }
  })();
  return configured;
}

/** The app's own URL (what Google redirects back to). Must be an Authorized redirect URI. */
export function redirectUri(): string {
  return `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
}

function b64u(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Leaves the page for Google's sign-in; `completeRedirectSignIn` finishes on return. */
export async function startRedirectSignIn(clientId: string, scope: string, loginHint?: string): Promise<never> {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const flow: Flow = { state: b64u(crypto.getRandomValues(new Uint8Array(18))), verifier, redirect: redirectUri(), at: Date.now() };
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow));
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: flow.redirect,
    response_type: 'code',
    scope,
    access_type: 'offline',
    // consent: Google only issues a refresh token when the consent screen is shown.
    prompt: loginHint ? 'consent' : 'consent select_account',
    include_granted_scopes: 'true',
    state: flow.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(loginHint ? { login_hint: loginHint } : {})
  }).toString();
  location.assign(u.toString());
  return new Promise<never>(() => undefined);
}

export type RedirectResult = { ok: true; tokens: TokenSet } | { ok: false; error: string };

/** On page load: finish a sign-in Google redirected back from. null = not returning from one. */
export async function completeRedirectSignIn(): Promise<RedirectResult | null> {
  const q = new URLSearchParams(location.search);
  const state = q.get('state');
  if (!state || (!q.has('code') && !q.has('error'))) return null;
  let flow: Flow | null = null;
  try {
    flow = JSON.parse(sessionStorage.getItem(FLOW_KEY) ?? 'null') as Flow | null;
    sessionStorage.removeItem(FLOW_KEY);
  } catch {
    /* ignore */
  }
  // Never leave the code in the address bar or history.
  history.replaceState(history.state, '', `${location.pathname}${location.hash}`);
  if (!flow || flow.state !== state || Date.now() - flow.at > 15 * 60_000) return { ok: false, error: 'expired' };
  const err = q.get('error');
  if (err) return { ok: false, error: err === 'access_denied' ? 'cancelled' : err };
  try {
    const res = await fetch(`${PUSH_WORKER_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: q.get('code'), code_verifier: flow.verifier, redirect_uri: flow.redirect })
    });
    const out = (await res.json()) as Partial<TokenSet> & { refresh_token?: string; error?: string };
    if (!res.ok || !out.access_token) return { ok: false, error: out.error ?? 'token_error' };
    // Nothing is stored yet: the caller commits the tokens only once the user has decided what
    // happens to the tasks already on this device (so another account can't sync meanwhile).
    return {
      ok: true,
      tokens: { access_token: out.access_token, expires_in: Number(out.expires_in ?? 3600), scope: out.scope ?? '', refresh_token: out.refresh_token }
    };
  } catch {
    return { ok: false, error: 'offline' };
  }
}

async function cryptoKey(): Promise<CryptoKey> {
  let k = await getMetaValue<CryptoKey>(RT_CRYPTO_KEY);
  if (!k) {
    k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await setMetaValue(RT_CRYPTO_KEY, k);
  }
  return k;
}

/** Store a refresh token from a finished sign-in (replaces any previous account's). */
export async function commitRefreshToken(rt: string): Promise<void> {
  await saveRefreshToken(rt);
}

async function saveRefreshToken(rt: string): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(), new TextEncoder().encode(rt));
  await setMetaValue(RT_KEY, { iv, ct });
}

async function loadRefreshToken(): Promise<string | null> {
  try {
    const box = await getMetaValue<{ iv: Uint8Array; ct: ArrayBuffer }>(RT_KEY);
    if (!box) return null;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv as BufferSource }, await cryptoKey(), box.ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function hasRefreshToken(): Promise<boolean> {
  return !!(await loadRefreshToken());
}

let refreshing: Promise<TokenSet | 'revoked' | null> | null = null;

/** A fresh 1-hour token without any popup. 'revoked' = the user removed access; sign in again. */
export function refreshAccessToken(): Promise<TokenSet | 'revoked' | null> {
  refreshing ??= (async () => {
    const rt = await loadRefreshToken();
    if (!rt || !PUSH_WORKER_URL) return null;
    try {
      const res = await fetch(`${PUSH_WORKER_URL}/oauth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt })
      });
      const out = (await res.json().catch(() => ({}))) as Partial<TokenSet> & { error?: string };
      if (res.status === 400 && (out.error === 'invalid_grant' || out.error === 'unauthorized_client')) {
        await clearRefreshToken();
        return 'revoked';
      }
      if (!res.ok || !out.access_token) return null;
      return { access_token: out.access_token, expires_in: Number(out.expires_in ?? 3600), scope: out.scope ?? '' };
    } catch {
      return null; // offline: try again later, stay signed in
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function clearRefreshToken(): Promise<void> {
  await deleteMeta(RT_KEY).catch(() => undefined);
}

/** Sign out: tell Google to forget this device's refresh token, then drop it. */
export async function revokeRefreshToken(): Promise<void> {
  const rt = await loadRefreshToken();
  await clearRefreshToken();
  if (rt) await revokeToken(rt);
}

/** Ask Google to revoke one token (e.g. an abandoned sign-in's). Never throws. */
export async function revokeToken(rt: string): Promise<void> {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: rt }).toString()
    });
  } catch {
    /* offline: the token is gone from this device either way */
  }
}
