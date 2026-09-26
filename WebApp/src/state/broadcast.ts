/**
 * Cross-window announcements on this device: a second tab, the mini window, the Desk's widget,
 * Quick Add panel and full window all share one IndexedDB, so whoever writes tells the others to
 * reload at once instead of waiting for the next sync. Carried by a BroadcastChannel('nexus');
 * environments without one (old WebViews, tests) simply never hear anything.
 */

export type AnnounceKind = 'tasks' | 'settings' | 'sync';
type Envelope = { kind: AnnounceKind; from: string };
type Channel = { postMessage(m: unknown): void; addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void };

/** This window's id: its own announcements are ignored even if a channel echoes them. */
const SELF = Math.random().toString(36).slice(2);
const listeners = new Map<AnnounceKind, Set<() => void>>();
let channel: Channel | null | undefined;

function open(): Channel | null {
  if (channel !== undefined) return channel;
  const BC = (globalThis as { BroadcastChannel?: new (name: string) => Channel }).BroadcastChannel;
  if (!BC) return (channel = null);
  try {
    channel = new BC('nexus');
    channel.addEventListener('message', (e) => {
      const m = e.data as Envelope | null;
      if (!m || m.from === SELF || !listeners.has(m.kind)) return;
      listeners.get(m.kind)!.forEach((fn) => fn());
    });
  } catch {
    channel = null;
  }
  return channel;
}

/** Tell the other Nexus windows that [kind] changed here. */
export function announce(kind: AnnounceKind): void {
  try {
    open()?.postMessage({ kind, from: SELF } satisfies Envelope);
  } catch {
    /* channel closed */
  }
}

/** Run [fn] when another window announces [kind]. Returns the unsubscribe. */
export function onAnnounce(kind: AnnounceKind, fn: () => void): () => void {
  open();
  if (!listeners.has(kind)) listeners.set(kind, new Set());
  listeners.get(kind)!.add(fn);
  return () => void listeners.get(kind)?.delete(fn);
}

/** Tests only: forget the channel so the next call picks up a fresh BroadcastChannel. */
export function resetBroadcastForTests(): void {
  channel = undefined;
  listeners.clear();
}
