import { signal } from '@preact/signals';
import type { Priority } from '../types';

/**
 * Nexus Desk bridge (Mac / Windows). The Desk injects `window.__nexusDeskInfo` at document
 * start and registers the `nexusDesk` message handler on every web view it owns; the page
 * talks back with `deskPost`. Outside the Desk everything here is inert (see docs/premium-desk-architecture.md §2.5).
 */

export type DeskInfo = {
  platform: 'mac' | 'windows';
  version: string;
  /** Shortcut label, e.g. "⌃⌥N". */
  hotkey: string;
  hotkeyOn: boolean;
  /** What the global shortcut opens. */
  quickAddStyle: 'panel' | 'widget';
  /** Reminders as native notifications. */
  notify: boolean;
  /** Start at login. */
  login: boolean;
  mode: string;
  corner: string;
  fullWindow: boolean;
  /** Extras this Desk build supports, e.g. "pickImages" (older Desks send none). */
  caps?: string[];
};

export type DeskMessage =
  | { open: 'full'; task?: string; page?: 'calendar' | 'settings' | 'quadrant'; p?: Priority }
  | { open: 'quickadd' }
  | { close: 'quickadd'; added?: boolean }
  | { resize: { height: number } }
  | { set: { key: string; value: unknown } }
  | { hotkey: 'change' }
  | { categories: { snooze: string } }
  | { openUrl: string }
  | { focus: 'widget' }
  /** A page's window.__nexus* hooks are installed: the Desk may call them from now on. */
  | { ready: 'widget' | 'quickadd' | 'full' }
  /** Ask the Desk to choose pictures natively; it answers via window.__nexusDeskImages(req, items). */
  | { pickImages: string };

type Handler = { postMessage(m: unknown): void };
type DeskWindow = Window & {
  webkit?: { messageHandlers?: Record<string, Handler | undefined> };
  __nexusDeskInfo?: Partial<DeskInfo>;
  __nexusDeskInfoChanged?: (info: Partial<DeskInfo>) => void;
};
const win = (): DeskWindow | null => (typeof window === 'undefined' ? null : (window as DeskWindow));

const handler = (): Handler | null => win()?.webkit?.messageHandlers?.nexusDesk ?? null;

/** What the Desk told us about itself (null in a browser). Re-read whenever the Desk re-injects it. */
export const deskInfo = signal<Partial<DeskInfo> | null>(win()?.__nexusDeskInfo ?? null);
const w = win();
if (w) {
  w.__nexusDeskInfoChanged = (info) => (deskInfo.value = info ?? w.__nexusDeskInfo ?? null);
  // Fallback: the Desk re-injects __nexusDeskInfo and announces it with a 'nexusdesk' event.
  w.addEventListener?.('nexusdesk', () => (deskInfo.value = w.__nexusDeskInfo ?? null));
}

/** Running inside a Nexus Desk web view (the bridge exists, or the Desk announced itself). */
export const inNexusDesk = (): boolean => !!handler() || !!win()?.__nexusDeskInfo;

/** Send a message to the Desk. Returns false (and does nothing) outside the Desk. */
export function deskPost(msg: DeskMessage): boolean {
  const h = handler();
  if (!h) return false;
  try {
    h.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

/** Show the full Nexus window in the Desk, optionally on a task (uuid) or a page. */
export function openFullInDesk(o: { task?: string; page?: 'calendar' | 'settings' | 'quadrant'; p?: Priority } = {}): boolean {
  const msg: DeskMessage = { open: 'full' };
  if (o.task) msg.task = o.task;
  if (o.page) msg.page = o.page;
  if (o.p) msg.p = o.p;
  return deskPost(msg);
}

type DeskImage = { name: string; type: string; b64: string };
const imageRequests = new Map<string, (files: File[]) => void>();

/**
 * Pictures chosen with the Mac Desk's own open panel. A WKWebView ignores `<input type=file>`
 * unless the app runs the panel itself, so inside a Desk that can ("pickImages" cap) the choice is
 * made natively and the files come back here. Null when not available: use a file input then.
 */
export function deskPickImages(): Promise<File[]> | null {
  if (!deskInfo.value?.caps?.includes('pickImages')) return null;
  const req = `img${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const w = window as Window & { __nexusDeskImages?: (req: string, items: DeskImage[]) => void };
  w.__nexusDeskImages = (id, items) => {
    const done = imageRequests.get(id);
    if (!done) return;
    imageRequests.delete(id);
    done(
      (items ?? []).map((it) => {
        const bin = atob(it.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new File([bytes], it.name, { type: it.type });
      })
    );
  };
  return new Promise<File[]>((resolve) => {
    imageRequests.set(req, resolve);
    if (!deskPost({ pickImages: req })) {
      imageRequests.delete(req);
      resolve([]);
    }
  });
}
