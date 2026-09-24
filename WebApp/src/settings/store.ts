import { signal } from '@preact/signals';
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
  profileOnboardingDone: boolean;
  /** Same scale as Android: 0.1 (light) – 1 (strong). */
  vibrationStrength: number;
  vibrationEnabled: boolean;
  checkInEnabled: boolean;
  checkInDays: number;
  snoozeMinutes: number;
  windowStart: number;
  windowEnd: number;
  /** How long Recently deleted shows a task (sync keeps tombstones 90 days regardless). */
  trashDays: number;
  /** Settings schema version, for one-time migrations. */
  schema: number;
}

// Mirrors Android AppSettings.DEFAULT_* so both apps start out identical.
export const DEFAULTS = {
  retentionDays: 15,
  vibrationStrength: 0.65,
  checkInDays: 3,
  snoozeMinutes: 10,
  windowStart: 8,
  windowEnd: 22,
  trashDays: 30
} as const;
export const CHECK_IN_DAYS_RANGE = [1, 14] as const;
export const SNOOZE_CHOICES = [5, 10, 15, 30, 60] as const;
export const TRASH_DAYS_RANGE = [7, 90] as const;

const defaults: Settings = {
  themeMode: 'SYSTEM',
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
  tutorialDone: false,
  profileOnboardingDone: false,
  vibrationStrength: DEFAULTS.vibrationStrength,
  vibrationEnabled: true,
  checkInEnabled: true,
  checkInDays: DEFAULTS.checkInDays,
  snoozeMinutes: DEFAULTS.snoozeMinutes,
  windowStart: DEFAULTS.windowStart,
  windowEnd: DEFAULTS.windowEnd,
  trashDays: DEFAULTS.trashDays,
  schema: 2
};

function loadRaw(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const s = { ...defaults, ...parsed };
    if (!parsed.schema || parsed.schema < 2) {
      // v1 stored haptics as 0–100; Android uses 0.1–1.
      const v = Number(parsed.vibrationStrength ?? 100);
      s.vibrationEnabled = v > 0;
      s.vibrationStrength = v > 1 ? Math.max(0.1, Math.min(1, v / 100)) : DEFAULTS.vibrationStrength;
      s.schema = 2;
    }
    return s;
  } catch {
    return { ...defaults };
  }
}

export function resetSettings(): void {
  patchSettings({
    themeMode: 'SYSTEM',
    fontScale: 1,
    autoArrange: true,
    retentionDays: DEFAULTS.retentionDays,
    vibrationStrength: DEFAULTS.vibrationStrength,
    vibrationEnabled: true,
    checkInEnabled: true,
    checkInDays: DEFAULTS.checkInDays,
    snoozeMinutes: DEFAULTS.snoozeMinutes,
    windowStart: DEFAULTS.windowStart,
    windowEnd: DEFAULTS.windowEnd,
    trashDays: DEFAULTS.trashDays
  });
}

let settings = loadRaw();
const listeners = new Set<() => void>();
/** Reactive view of the settings for components. Write through patchSettings(). */
export const settingsSig = signal<Settings>(settings);

export function getSettings(): Settings {
  return settings;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode: keep in memory */
  }
  settingsSig.value = settings;
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
  return window.innerWidth >= 1024 ? 'desktop' : 'phone';
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
  return profileLastSyncedLabel(now);
}

/** Profile sheet: always show last successful sync, not a generic failure line. */
export function profileLastSyncedLabel(now = Date.now()): string {
  if (!settings.googleEmail) return 'Offline';
  if (settings.lastSuccessTime <= 0) return 'Not synced yet';
  const mins = Math.floor((now - settings.lastSuccessTime) / 60000);
  if (mins < 1) return 'Last synced just now';
  if (mins < 60) return `Last synced ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Last synced ${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'Last synced 1 day ago' : `Last synced ${days} days ago`;
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
