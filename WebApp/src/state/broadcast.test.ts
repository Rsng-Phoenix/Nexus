import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce, onAnnounce, resetBroadcastForTests } from './broadcast';

/** Stand-in for BroadcastChannel: every instance with the same name hears every post (self included). */
class FakeChannel {
  static all: FakeChannel[] = [];
  static posted: unknown[] = [];
  private fns: Array<(e: { data: unknown }) => void> = [];
  constructor(public name: string) {
    FakeChannel.all.push(this);
  }
  addEventListener(_: 'message', fn: (e: { data: unknown }) => void) {
    this.fns.push(fn);
  }
  postMessage(m: unknown) {
    FakeChannel.posted.push(m);
    for (const c of FakeChannel.all) if (c.name === this.name) c.fns.forEach((f) => f({ data: m }));
  }
  /** A message from some other window. */
  static fromPeer(data: unknown) {
    for (const c of FakeChannel.all) c.fns.forEach((f) => f({ data }));
  }
}

describe('broadcast', () => {
  beforeEach(() => {
    FakeChannel.all = [];
    FakeChannel.posted = [];
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    resetBroadcastForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('announce posts an envelope on the "nexus" channel', () => {
    announce('tasks');
    expect(FakeChannel.all.map((c) => c.name)).toEqual(['nexus']);
    expect(FakeChannel.posted).toHaveLength(1);
    expect(FakeChannel.posted[0]).toMatchObject({ kind: 'tasks' });
  });

  it('onAnnounce hears peers of the same kind only', () => {
    const tasks = vi.fn();
    const settings = vi.fn();
    onAnnounce('tasks', tasks);
    onAnnounce('settings', settings);
    FakeChannel.fromPeer({ kind: 'tasks', from: 'peer' });
    FakeChannel.fromPeer({ kind: 'sync', from: 'peer' });
    FakeChannel.fromPeer(null);
    expect(tasks).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled();
  });

  it('ignores its own announcements even when the channel echoes them', () => {
    const fn = vi.fn();
    onAnnounce('tasks', fn);
    announce('tasks');
    expect(fn).not.toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const fn = vi.fn();
    const off = onAnnounce('sync', fn);
    off();
    FakeChannel.fromPeer({ kind: 'sync', from: 'peer' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('is inert without BroadcastChannel', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    resetBroadcastForTests();
    expect(() => announce('tasks')).not.toThrow();
    expect(() => onAnnounce('tasks', () => {})()).not.toThrow();
  });
});
