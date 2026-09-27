import { beforeAll, describe, expect, it, vi } from 'vitest';

// Widget, full app and Quick Add are separate web views sharing one localStorage: a minimal
// browser (storage, window, document) is enough to check that they don't undo each other.
const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k)
};
const handlers: Record<string, ((e: unknown) => void)[]> = {};
const root = { dataset: {} as Record<string, string>, style: { setProperty: () => {} } };

let store: typeof import('./store');

beforeAll(async () => {
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', {
    innerWidth: 1280,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] ??= []).push(fn)
  });
  vi.stubGlobal('document', {
    documentElement: root,
    head: { appendChild: () => {} },
    createElement: () => ({})
  });
  store = await import('./store');
  store.initSettings();
});

/** What another window does: write the key, then this window hears a 'storage' event. */
function otherWindowWrites(patch: Record<string, unknown>) {
  const cur = JSON.parse(mem.get('nexus_settings') ?? '{}');
  mem.set('nexus_settings', JSON.stringify({ ...cur, ...patch }));
  for (const fn of handlers.storage ?? []) fn({ key: 'nexus_settings', storageArea: storage });
}

describe('settings across windows', () => {
  it('patches merge onto what is stored, not a stale in-memory copy', () => {
    store.patchSettings({ displayName: 'Asha' });
    // Another window changes a different setting without this one hearing about it.
    const cur = JSON.parse(mem.get('nexus_settings')!);
    mem.set('nexus_settings', JSON.stringify({ ...cur, weekStart: 0 }));
    store.patchSettings({ snoozeMinutes: 30 });
    const saved = JSON.parse(mem.get('nexus_settings')!);
    expect(saved).toMatchObject({ displayName: 'Asha', weekStart: 0, snoozeMinutes: 30 });
  });

  it("takes over another window's change: signal, subscribers, theme and motion", () => {
    const seen = vi.fn();
    const off = store.subscribeSettings(seen);
    otherWindowWrites({ motion: 'reduced', themeMode: 'DARK', displayName: 'Ravi' });
    expect(store.getSettings().displayName).toBe('Ravi');
    expect(store.settingsSig.value.motion).toBe('reduced');
    expect(seen).toHaveBeenCalled();
    expect(root.dataset.motion).toBe('reduced');
    expect(root.dataset.theme).toBe('dark');
    off();
  });

  it('ignores other keys', () => {
    const seen = vi.fn();
    const off = store.subscribeSettings(seen);
    for (const fn of handlers.storage ?? []) fn({ key: 'nexus_mini_tab', storageArea: storage });
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});
