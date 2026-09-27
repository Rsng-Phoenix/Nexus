import { signal } from '@preact/signals';
import type { LayoutMode, Priority, ThemeMode } from '../types';
import { applyPalette, darkPalette, lightPalette, resolveDark } from '../theme/palette';
import { installMotionTokens } from '../view/motion';

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
  // ── Notifications (same keys and defaults as Android AppSettings) ──
  notifyReminders: boolean;
  notifyDeadlines: boolean;
  /** Offsets (days) pre-selected when adding a deadline, e.g. "-1,0". */
  defaultDueAlerts: string;
  /** Minutes after midnight deadline alerts ring by default. */
  defaultDueAlertTime: number;
  groupNotifications: boolean;
  /** Safety cap: rings beyond this in a rolling hour are folded into one summary. */
  maxNotificationsPerHour: number;
  /** Nothing rings before this time (0 = not paused). Missed rings are not replayed. */
  pauseNotificationsUntil: number;
  /** Google account the tasks on this device belong to ('' = only on this device). */
  dataOwnerEmail: string;
  /** Last successful sync with dataOwnerEmail's Drive (kept after sign-out, unlike lastSuccessTime). */
  ownerSyncedAt: number;
  /** Private iCal links shown read-only in the calendar. Shared with your other devices through Drive. */
  linkedCalendars: LinkedCalendar[];
  /** Links removed here (by address), so a sync removes them on your other devices too. */
  linkedRemoved: LinkedRemoval[];
  /** Google Sheets that keep updating their tasks (import/liveSheet.ts). */
  linkedSheets: LinkedSheet[];
  /** How often linked sheets are re-read (minutes; one of SHEET_REFRESH_CHOICES). */
  sheetRefreshMinutes: number;
  /** A sheet change that arrives after its alert time (before its day is over) alerts once right away. */
  sheetLateAlerts: boolean;
  /** 1 = weeks start on Monday, 0 = Sunday. */
  weekStart: 0 | 1;
  /** How often linked calendars are re-checked (minutes; one of CALENDAR_REFRESH_CHOICES). */
  calendarRefreshMinutes: number;
  /** Heads-up before timed events from linked calendars (off until the user turns it on). */
  notifyMeetings: boolean;
  /** How long before a meeting it rings, minutes (0 = when it starts); one of MEETING_LEAD_CHOICES. */
  meetingLeadMinutes: number;
  /** Clash radar: flag meetings from linked calendars that overlap. */
  clashRadar: boolean;
  /** Overlaps shorter than this (minutes) are not called clashes; one of CLASH_MIN_CHOICES. */
  clashMinMinutes: number;
  /** Clashes the user chose to ignore (ids from clashId), newest last. */
  ignoredClashes: string[];
  /** "Show Nexus in your calendar apps": the live feed's address and write key (null = off). */
  calendarFeed: FeedCreds | null;
  /** Which screen Nexus opens on: the matrix, or the calendar for people who plan by date. */
  startView: StartView;
  /** Appearance → Motion: 'reduced' turns every spring into an ≤ 80 ms fade (html[data-motion]). */
  motion: MotionMode;
  /** Settings schema version, for one-time migrations. */
  schema: number;
}

export type StartView = 'matrix' | 'calendar';
export type MotionMode = 'full' | 'reduced';

/** A live calendar feed. [shared]: this copy came from / was written to Drive (not stored there). */
export type FeedCreds = { v: 1; id: string; key: string; createdAt: number; notes: boolean; shared?: boolean };

/** [updatedAt]: last add/rename/colour/switch, so the newest change wins between devices (0 = older than sync). */
export type LinkedCalendar = { id: string; name: string; url: string; color: string; enabled: boolean; updatedAt?: number };
export type LinkedRemoval = { url: string; at: number };

/** How a linked Google Sheet's rows become tasks: the choices made in the import wizard. */
export type SheetMapping = {
  headerRow: number;
  titleCols: number[];
  /** The same words at the start of every task's title (e.g. "Appointment"); '' = columns only. */
  titleText?: string;
  dateCol: number;
  notesCols: number[];
  priority: Priority | { col: number; fallback?: Priority };
  offsets: number[];
  alertTime: number;
  dayFirst: boolean;
};
export type LinkedSheet = {
  id: string;
  name: string;
  sheetId: string;
  gid: string;
  mapping: SheetMapping;
  enabled: boolean;
  lastSyncAt: number;
  lastError: string;
};
/** 0 = only when you tap Update now (no automatic reads at all). */
export const SHEET_REFRESH_CHOICES = [0, 5, 15, 30, 60, 180] as const;
export const sheetRefreshLabel = (m: number) => (m === 0 ? 'Only when I tap Update' : refreshLabel(m));

// Mirrors Android AppSettings.DEFAULT_* so both apps start out identical.
export const DEFAULTS = {
  retentionDays: 15,
  vibrationStrength: 0.65,
  checkInDays: 3,
  snoozeMinutes: 10,
  windowStart: 8,
  windowEnd: 22,
  trashDays: 30,
  defaultDueAlerts: '-1,0',
  defaultDueAlertTime: 540,
  maxNotificationsPerHour: 12,
  calendarRefreshMinutes: 15
} as const;
export const CLASH_MIN_CHOICES = [1, 5, 10, 15, 30] as const;
export const clashMinLabel = (m: number) => (m <= 1 ? 'Any overlap' : `${m} min or more`);
/** Only the newest ignored clashes are kept. */
export const MAX_IGNORED_CLASHES = 300;
export const MEETING_LEAD_CHOICES = [0, 1, 5, 10, 15, 30] as const;
export const meetingLeadLabel = (m: number) => (m === 0 ? 'When it starts' : `${m} min before`);
export const CALENDAR_REFRESH_CHOICES = [5, 10, 15, 30, 60, 180, 360] as const;
/** "15 min", "1 hour", "6 hours". */
export const refreshLabel = (m: number) => (m < 60 ? `${m} min` : m === 60 ? '1 hour' : `${m / 60} hours`);
const nearestRefresh = (m: number) =>
  CALENDAR_REFRESH_CHOICES.reduce((best, c) => (Math.abs(c - m) < Math.abs(best - m) ? c : best), DEFAULTS.calendarRefreshMinutes as number);
export const MAX_PER_HOUR_RANGE = [3, 60] as const;
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
  notifyReminders: true,
  notifyDeadlines: true,
  defaultDueAlerts: DEFAULTS.defaultDueAlerts,
  defaultDueAlertTime: DEFAULTS.defaultDueAlertTime,
  groupNotifications: true,
  maxNotificationsPerHour: DEFAULTS.maxNotificationsPerHour,
  pauseNotificationsUntil: 0,
  dataOwnerEmail: '',
  ownerSyncedAt: 0,
  linkedCalendars: [],
  linkedRemoved: [],
  linkedSheets: [],
  sheetRefreshMinutes: 15,
  sheetLateAlerts: true,
  weekStart: 1,
  calendarRefreshMinutes: DEFAULTS.calendarRefreshMinutes,
  notifyMeetings: false,
  meetingLeadMinutes: 10,
  clashRadar: true,
  clashMinMinutes: 1,
  ignoredClashes: [],
  calendarFeed: null,
  startView: 'matrix',
  motion: 'full',
  schema: 4
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
    if (s.schema < 3) {
      // 3.7: tasks already on a signed-in device belong to that account.
      s.dataOwnerEmail = s.googleEmail;
      s.ownerSyncedAt = s.lastSuccessTime;
      s.schema = 3;
    }
    if (s.schema < 4) {
      // 3.7: linked calendars are checked in minutes; the old 6-hour default becomes 15 minutes.
      const hours = Number((parsed as { calendarRefreshHours?: number }).calendarRefreshHours ?? 6);
      s.calendarRefreshMinutes = hours === 6 ? DEFAULTS.calendarRefreshMinutes : nearestRefresh(hours * 60);
      delete (s as { calendarRefreshHours?: number }).calendarRefreshHours;
      s.schema = 4;
    }
    s.calendarRefreshMinutes = nearestRefresh(Number(s.calendarRefreshMinutes) || DEFAULTS.calendarRefreshMinutes);
    if (!MEETING_LEAD_CHOICES.includes(s.meetingLeadMinutes as (typeof MEETING_LEAD_CHOICES)[number])) s.meetingLeadMinutes = 10;
    if (s.startView !== 'calendar') s.startView = 'matrix';
    if (s.motion !== 'reduced') s.motion = 'full';
    if (!CLASH_MIN_CHOICES.includes(s.clashMinMinutes as (typeof CLASH_MIN_CHOICES)[number])) s.clashMinMinutes = 1;
    if (!Array.isArray(s.ignoredClashes)) s.ignoredClashes = [];
    if (!Array.isArray(s.linkedRemoved)) s.linkedRemoved = [];
    if (!Array.isArray(s.linkedSheets)) s.linkedSheets = [];
    if (typeof s.sheetLateAlerts !== 'boolean') s.sheetLateAlerts = true;
    if (!SHEET_REFRESH_CHOICES.includes(s.sheetRefreshMinutes as (typeof SHEET_REFRESH_CHOICES)[number])) s.sheetRefreshMinutes = 15;
    if (s.calendarFeed && !(typeof s.calendarFeed.id === 'string' && typeof s.calendarFeed.key === 'string')) s.calendarFeed = null;
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
    trashDays: DEFAULTS.trashDays,
    notifyReminders: true,
    notifyDeadlines: true,
    defaultDueAlerts: DEFAULTS.defaultDueAlerts,
    defaultDueAlertTime: DEFAULTS.defaultDueAlertTime,
    groupNotifications: true,
    maxNotificationsPerHour: DEFAULTS.maxNotificationsPerHour,
    pauseNotificationsUntil: 0,
    weekStart: 1,
    calendarRefreshMinutes: DEFAULTS.calendarRefreshMinutes,
    startView: 'matrix',
    motion: 'full',
    notifyMeetings: false,
    meetingLeadMinutes: 10,
    clashRadar: true,
    clashMinMinutes: 1
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
  applyMotion();
}

/** Mirrors the Motion setting as `html[data-motion]`, which the stylesheets and motion.ts read. */
export function applyMotion(): void {
  document.documentElement.dataset.motion = settings.motion === 'reduced' ? 'reduced' : 'full';
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
  applyMotion();
  installMotionTokens();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.themeMode === 'SYSTEM') applyTheme();
  });
  window.addEventListener('resize', applyLayout);
}
