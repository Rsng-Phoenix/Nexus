import type { LayoutMode, ThemeMode } from '../types';
import { applyPalette, darkPalette, lightPalette, resolveDark } from '../theme/palette';

const KEY = 'nexus_settings';

export interface Settings {
  themeMode: ThemeMode;
  fontScale: number;
  autoArrange: boolean;
  retentionDays: number;
  displayName: string;
  googleEmail: string;
  googlePhotoUrl: string;
  driveFileId: string;
  lastSyncTime: number;
  lastSuccessTime: number;
  lastSyncError: string;
  layoutMode: LayoutMode;
  tutorialDone: boolean;
}

const defaults: Settings = {
  themeMode: 'DARK',
  fontScale: 1,
  autoArrange: true,
  retentionDays: 15,
  displayName: '',
  googleEmail: '',
  googlePhotoUrl: '',
  driveFileId: '',
  lastSyncTime: 0,
  lastSuccessTime: 0,
  lastSyncError: '',
  layoutMode: 'auto',
  tutorialDone: false
};

function loadRaw(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

let settings = loadRaw();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return settings;
}

function save(): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
  listeners.forEach((l) => l());
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function patchSettings(p: Partial<Settings>): void {
  settings = { ...settings, ...p };
  save();
  applyTheme();
  applyFontScale();
  applyLayout();
}

export function applyTheme(): void {
  const dark = resolveDark(settings.themeMode);
  applyPalette(dark ? darkPalette : lightPalette);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function applyFontScale(): void {
  document.documentElement.style.setProperty(
    '--nx-font-scale',
    String(settings.fontScale)
  );
}

export function resolvedLayout(): 'phone' | 'desktop' {
  if (settings.layoutMode === 'phone') return 'phone';
  if (settings.layoutMode === 'desktop') return 'desktop';
  return window.innerWidth >= 900 ? 'desktop' : 'phone';
}

export function applyLayout(): void {
  document.documentElement.dataset.layout = resolvedLayout();
}

export function topBarGreeting(): string {
  const n = sanitizeNickname(settings.displayName);
  if (!n) return 'Hey User';
  const short = n.length > 10 ? `${n.slice(0, 9)}…` : n;
  return `Hey, ${short}`;
}

export function sanitizeNickname(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .slice(0, 12)
    .trim();
}

export function syncStatusLabel(now = Date.now()): string {
  if (settings.lastSyncError) return 'Sync failed';
  if (!settings.googleEmail) return 'Offline';
  if (settings.lastSuccessTime <= 0) return 'Not synced yet';
  const mins = Math.floor((now - settings.lastSuccessTime) / 60000);
  if (mins < 1) return 'Synced just now';
  if (mins < 60) return `Last synced ${mins} min ago`;
  return `Last synced ${Math.floor(mins / 60)} hr ago`;
}

export function isSignedIn(): boolean {
  return !!settings.googleEmail;
}

export function initSettings(): void {
  settings.fontScale = Math.min(1.45, Math.max(0.85, settings.fontScale));
  applyTheme();
  applyFontScale();
  applyLayout();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.themeMode === 'SYSTEM') applyTheme();
  });
  window.addEventListener('resize', applyLayout);
}
