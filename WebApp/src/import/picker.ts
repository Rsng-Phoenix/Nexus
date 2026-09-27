import { GOOGLE_PICKER_API_KEY, GOOGLE_PROJECT_NUMBER } from '../config';
import { getSettings } from '../settings/store';
import { DRIVE_FILE_SCOPE, getAccessToken, GOOGLE_CLIENT_ID, SCOPE, tokenHasScope } from '../sync/auth';
import { longSessionsAvailable, startRedirectSignIn } from '../sync/oauth';
import type { SheetRef } from './liveSheet';

/**
 * "Choose in Google Drive": the Google Picker, opened once for a sheet Nexus may not read (private
 * to an organisation). Picking a file grants this app the non-sensitive `drive.file` scope for that
 * file only, for this Google account and Cloud project, so afterwards every Nexus (this browser,
 * Nexus Desk, the phone) reads it through the Sheets API (import/sheetsApi.ts). The Picker is a
 * browser API that needs a public API key (config.ts GOOGLE_PICKER_API_KEY); without one the
 * button stays hidden and the sharing instructions apply.
 *
 * Loaded lazily from https://apis.google.com/js/api.js the first time it is needed, never at start.
 */

const GAPI_SRC = 'https://apis.google.com/js/api.js';
const LOAD_TIMEOUT_MS = 15_000;
const PENDING_KEY = 'nexus_pending_sheet';

export class PickerError extends Error {}

/** Whether the Picker is configured (see config.ts). */
export const pickerAvailable = () => GOOGLE_PICKER_API_KEY !== '';

// Only the pieces of the Picker API Nexus uses (no @types package; typed loosely on purpose).
type PickerDoc = { id?: string; name?: string; mimeType?: string };
type PickerResponse = { action?: string; docs?: PickerDoc[] };
type PickerBuilder = {
  setOAuthToken(t: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  setOrigin(o: string): PickerBuilder;
  setTitle(t: string): PickerBuilder;
  addView(v: unknown): PickerBuilder;
  setCallback(cb: (r: PickerResponse) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void; dispose?(): void };
};
type PickerNs = {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId: string) => { setMode(m: string): unknown; setIncludeFolders?(b: boolean): unknown };
  ViewId: { SPREADSHEETS: string };
  DocsViewMode: { LIST: string };
  Action: { PICKED: string; CANCEL: string };
};
type Gapi = { load(name: string, cb: () => void): void };
const pickerNs = () => (window as unknown as { google?: { picker?: PickerNs } }).google?.picker;
const gapi = () => (window as unknown as { gapi?: Gapi }).gapi;

let loading: Promise<PickerNs> | null = null;

/** Loads api.js (once) and the picker module; rejects with a plain message when it can't. */
function loadPicker(): Promise<PickerNs> {
  if (loading) return loading;
  loading = new Promise<PickerNs>((resolve, reject) => {
    const fail = (why: string) => {
      loading = null;
      reject(new PickerError(why));
    };
    const timer = setTimeout(() => fail('Google Drive’s file picker didn’t load. Check your connection and try again.'), LOAD_TIMEOUT_MS);
    const onGapi = () => {
      const g = gapi();
      if (!g) return fail('Google Drive’s file picker didn’t load. Try again.');
      g.load('picker', () => {
        clearTimeout(timer);
        const ns = pickerNs();
        if (ns) resolve(ns);
        else fail('Google Drive’s file picker didn’t load. Try again.');
      });
    };
    if (gapi()) return onGapi();
    const s = document.createElement('script');
    s.src = GAPI_SRC;
    s.async = true;
    s.onload = onGapi;
    s.onerror = () => {
      clearTimeout(timer);
      fail('Google Drive’s file picker is blocked here (network or content policy).');
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Remembers the sheet link the user was importing across a full-page sign-in (long sessions re-consent
 * by leaving the page); SheetImportPage picks it up on its next open.
 */
export function rememberPendingSheet(link: string): void {
  try {
    sessionStorage.setItem(PENDING_KEY, link);
  } catch {
    /* ignore */
  }
}
export function takePendingSheet(): string {
  try {
    const v = sessionStorage.getItem(PENDING_KEY) ?? '';
    sessionStorage.removeItem(PENDING_KEY);
    return v;
  } catch {
    return '';
  }
}

/**
 * A token that carries drive.file. Sessions from before that scope re-consent once (incremental:
 * what was granted stays); null when the user backed out.
 */
export async function ensureSheetsScope(pendingLink?: string): Promise<string | null> {
  const quiet = await getAccessToken({ interactive: false });
  if (quiet && (await tokenHasScope(quiet, DRIVE_FILE_SCOPE))) return quiet;
  if (await longSessionsAvailable()) {
    // The refresh token was minted with the old scopes: only Google's sign-in page can widen it.
    if (pendingLink) rememberPendingSheet(pendingLink);
    await startRedirectSignIn(GOOGLE_CLIENT_ID, SCOPE, getSettings().googleEmail || undefined);
  }
  const fresh = await getAccessToken(true);
  if (fresh && (await tokenHasScope(fresh, DRIVE_FILE_SCOPE))) return fresh;
  return null;
}

/** Opens the Picker on the user's spreadsheets; resolves with the picked file, or null when closed. */
export async function openPicker(token: string): Promise<PickerDoc | null> {
  if (!pickerAvailable()) throw new PickerError('Choosing a sheet in Google Drive isn’t set up here (GOOGLE_PICKER_API_KEY in config.ts). Share the sheet as “Anyone with the link” instead.');
  const ns = await loadPicker();
  return new Promise<PickerDoc | null>((resolve) => {
    // LIST mode: thumbnails would need drive.readonly, which Nexus never asks for.
    const view = new ns.DocsView(ns.ViewId.SPREADSHEETS);
    view.setMode(ns.DocsViewMode.LIST);
    const picker = new ns.PickerBuilder()
      .setOAuthToken(token)
      .setAppId(GOOGLE_PROJECT_NUMBER)
      .setDeveloperKey(GOOGLE_PICKER_API_KEY)
      .setOrigin(`${location.protocol}//${location.host}`)
      .setTitle('Choose the sheet Nexus may read')
      .addView(view)
      .setCallback((r) => {
        if (r.action === ns.Action.PICKED) resolve(r.docs?.[0] ?? null);
        else if (r.action === ns.Action.CANCEL) resolve(null);
      })
      .build();
    picker.setVisible(true);
  });
}

/**
 * The whole "Choose in Google Drive" step for [ref]: scope, Picker, and a check that the file picked
 * is the one from the link (the grant is per file). true = picked; false = the user backed out.
 */
export async function chooseSheetInDrive(ref: SheetRef, pendingLink?: string): Promise<boolean> {
  const token = await ensureSheetsScope(pendingLink);
  if (!token) return false;
  const doc = await openPicker(token);
  if (!doc) return false;
  if (doc.id !== ref.sheetId) throw new PickerError(`You chose “${doc.name ?? 'another file'}”, not the sheet from the link. Choose that one so Nexus may read it.`);
  return true;
}
