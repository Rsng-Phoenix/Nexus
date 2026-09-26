import { clearToken, getAccessToken, isDriveScopeError } from '../sync/auth';
import { IMPORT_MAX_COLS, IMPORT_MAX_ROWS, type Cell } from './cell';

/**
 * Reading a Google Sheet through the Sheets API v4 with the signed-in account's token, for sheets
 * whose CSV export is refused (private to an organisation, or simply not shared with the link).
 * The API accepts the non-sensitive `drive.file` scope, which covers exactly the files the user
 * chose in the Google Picker (import/picker.ts); sheets.googleapis.com answers CORS requests with a
 * bearer token, docs.google.com's export does not.
 *
 * Two requests: the spreadsheet's tabs (to turn the link's gid into a tab title), then that tab's
 * values as the user sees them (FORMATTED_VALUE: dates and numbers as text, like the CSV export),
 * so the same column choices and task ids come out as from the public CSV.
 */

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Something Google said about the request, in the same wording as the CSV path's SheetError. */
export class SheetApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}
/** The account may not read this file yet: it has to be chosen in the Google Picker once. */
export class SheetNeedsPickError extends SheetApiError {}

export type TabInfo = { sheetId: number; title: string };

/** `GET spreadsheets/{id}?fields=sheets.properties(sheetId,title)` → the tabs, in sheet order. */
export function parseTabs(json: unknown): TabInfo[] {
  const o = json as { sheets?: { properties?: { sheetId?: unknown; title?: unknown } }[] } | null;
  const out: TabInfo[] = [];
  for (const s of Array.isArray(o?.sheets) ? o.sheets : []) {
    const p = s?.properties;
    if (!p || typeof p.title !== 'string') continue;
    const id = Number(p.sheetId);
    if (!Number.isFinite(id)) continue;
    out.push({ sheetId: id, title: p.title });
  }
  return out;
}

/** The tab a link's gid names ('' = the first tab, as the CSV export does); null when there is no such tab. */
export function tabTitleFor(tabs: TabInfo[], gid: string): string | null {
  if (!tabs.length) return null;
  if (gid === '') return tabs[0].title;
  const n = Number(gid);
  return tabs.find((t) => t.sheetId === n)?.title ?? null;
}

/** A1 range for a whole tab; the title is quoted, with quotes doubled, so any tab name works. */
export const tabRange = (title: string) => `'${title.replace(/'/g, "''")}'`;

/** `values.get` → cells, the same shape the CSV reader gives (blank = null), within the import caps. */
export function valuesToCells(json: unknown): Cell[][] {
  const values = (json as { values?: unknown } | null)?.values;
  if (!Array.isArray(values)) return [];
  return values.slice(0, IMPORT_MAX_ROWS).map((row) =>
    (Array.isArray(row) ? row : []).slice(0, IMPORT_MAX_COLS).map((v): Cell => {
      const s = v == null ? '' : String(v);
      return { v: s.trim() === '' ? null : s };
    })
  );
}

/** The permission problems the Picker fixes: no drive.file grant for this file (or no scope at all). */
export function isAccessRefusal(status: number, body: string): boolean {
  return status === 403 && (isDriveScopeError(body) || /PERMISSION_DENIED|does not have permission|insufficient/i.test(body));
}

/** What Google's answer means for the user, in the same words the CSV path uses. */
export function apiErrorMessage(status: number, body: string): string {
  if (status === 404) return 'That sheet was not found. Was it deleted, or is the link incomplete?';
  if (status === 400) return 'Google couldn’t export that tab. Open the tab you want in Google Sheets and copy the link again.';
  if (status === 429) return 'Google Sheets is busy right now. Nexus will try again at the next refresh.';
  if (status === 401 || status === 403) return 'Nexus can’t read this sheet with your Google account. Ask its owner for access, or share it as “Anyone with the link” (Viewer).';
  return `Google Sheets answered ${status}. Try again in a minute.`;
}

const OFFLINE = "You're offline. Nexus will read the sheet when you're back online.";

export type ApiOptions = {
  /** A fresh token after Google refused the current one (default: this device's refresh token; null = none). */
  renew?: () => Promise<string | null>;
  fetch?: typeof fetch;
};

const defaultRenew = async () => {
  // The token Google just rejected must not be handed out again.
  clearToken();
  return getAccessToken({ interactive: false });
};

/** The token in use for one read; a renewal after a 401 carries over to the next request. */
type Session = { token: string };

async function apiGet(url: string, s: Session, o: ApiOptions): Promise<unknown> {
  const f = o.fetch ?? fetch;
  const renew = o.renew ?? defaultRenew;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(url, { headers: { Authorization: `Bearer ${s.token}` }, cache: 'no-store' });
    } catch {
      throw new SheetApiError(typeof navigator !== 'undefined' && navigator.onLine === false ? OFFLINE : 'Couldn’t reach Google Sheets. Check your connection.');
    }
    if (res.ok) return res.json();
    const body = await res.text().catch(() => '');
    // An expired token: renew once, quietly, then try again.
    if (res.status === 401 && attempt === 0) {
      const fresh = await renew();
      if (fresh) {
        s.token = fresh;
        continue;
      }
    }
    if (isAccessRefusal(res.status, body)) throw new SheetNeedsPickError(apiErrorMessage(res.status, body), res.status);
    throw new SheetApiError(apiErrorMessage(res.status, body), res.status);
  }
}

/** The rows of one tab (gid '' = the first), as the CSV export would give them. */
export async function readRowsViaApi(token: string, sheetId: string, gid: string, o: ApiOptions = {}): Promise<Cell[][]> {
  const id = encodeURIComponent(sheetId);
  const s: Session = { token };
  const tabs = parseTabs(await apiGet(`${API}/${id}?fields=sheets.properties(sheetId,title)`, s, o));
  const title = tabTitleFor(tabs, gid);
  if (title === null) throw new SheetApiError(apiErrorMessage(400, ''), 400);
  const values = await apiGet(`${API}/${id}/values/${encodeURIComponent(tabRange(title))}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`, s, o);
  return valuesToCells(values);
}
