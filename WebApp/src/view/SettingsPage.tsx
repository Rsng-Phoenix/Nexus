import { enableNotifications, needsHomeScreenInstall, notificationState, sendTestPush } from '../reminders/push';
import '../styles/settings.css';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { getAllTasksIncludingDeleted, mergeRestoreTasks, replaceAllTasks } from '../db/tasks';
import { canVibrate, haptic } from '../lib/haptics';
import {
  CALENDAR_REFRESH_CHOICES,
  CLASH_MIN_CHOICES,
  clashMinLabel,
  MEETING_LEAD_CHOICES,
  meetingLeadLabel,
  refreshLabel,
  CHECK_IN_DAYS_RANGE,
  MAX_PER_HOUR_RANGE,
  profileLastSyncedLabel,
  patchSettings,
  resetSettings,
  settingsSig,
  SNOOZE_CHOICES,
  TRASH_DAYS_RANGE,
  type StartView
} from '../settings/store';
import * as nav from '../state/nav';
import { activeTasks, archivedTasks, isDemo, purgeExpired, recentlyDeleted, reload } from '../state/store';
import { showSnack } from '../state/toasts';
import { exportFullBackup, parseFullBackup, previewRestore } from '../sync/backup';
import { runSync, scheduleSync, signOutFlow } from '../sync/manager';
import { hasRefreshToken } from '../sync/oauth';
import { DUE_OFFSET_CHOICES, formatAlertTime } from '../calendar/deadline';
import { SHORTCUTS_SUMMARY, shortcutsOpen } from './Shortcuts';
import { formatDueAlerts, parseDueAlerts } from '../calendar/due';
import { canInstall, isStandalone, promptInstall } from '../state/install';
import { isPc, isWide } from '../state/viewport';
import { APP_VERSION } from '../config';
import { downloadIcs } from './addToCalendar';
import { FeedSettings } from './FeedSettings';
import { LinkedSheets } from './LinkedSheets';
import { Icon, type IconName } from './icons';
import { miniSupported, openMiniWindow } from './MiniWindow';
import { Avatar } from './Shell';
import type { Task, ThemeMode } from '../types';
import type { LayerProps } from './App';
import {
  Chevron,
  Dialog,
  GroupDivider,
  IconTile,
  Page,
  PageHeader,
  SectionHeader,
  Segmented,
  SettingsGroup,
  SettingsRow,
  Slider,
  Stepper,
  Switch,
  TextButton
} from './kit';

// Same tints as NexusHubSheet.kt
const Amber = '#FFAA00';
const Green = '#00D084';
const Blue = '#3B9EFF';
const Red = '#FF4060';
const Accent = 'var(--nx-accent)';


/**
 * Settings are grouped into categories. Phone / tablet: a list of categories, each opening its
 * own page (so the back gesture returns to the list). Desktop: categories on the left, the chosen
 * one on the right.
 */
type CatId = 'account' | 'general' | 'notifications' | 'reminders' | 'calendar' | 'tasks' | 'appearance' | 'desktop' | 'backup' | 'about';
type Cat = { id: CatId; label: string; icon: IconName; tint: string };
const CATS: Cat[] = [
  { id: 'account', label: 'Account & sync', icon: 'cloud', tint: Blue },
  { id: 'general', label: 'General', icon: 'tune', tint: Accent },
  { id: 'notifications', label: 'Notifications', icon: 'bell', tint: Red },
  { id: 'reminders', label: 'Reminders & deadlines', icon: 'schedule', tint: Amber },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', tint: Blue },
  { id: 'tasks', label: 'Tasks & trash', icon: 'checklist', tint: Green },
  { id: 'appearance', label: 'Appearance & feel', icon: 'palette', tint: Accent },
  { id: 'desktop', label: 'Desktop & widgets', icon: 'widgets', tint: Blue },
  { id: 'backup', label: 'Backup & restore', icon: 'storage', tint: Green },
  { id: 'about', label: 'Help & about', icon: 'info', tint: Accent }
];
const GROUPS: [string, CatId[]][] = [
  ['Everyday', ['general', 'notifications', 'reminders', 'calendar']],
  ['Your tasks', ['tasks', 'backup']],
  ['Look & devices', ['appearance', 'desktop']],
  ['Help', ['about']]
];
const catOf = (id: string | undefined) => CATS.find((c) => c.id === id);

function pauseLabel(until: number): string {
  if (until >= Number.MAX_SAFE_INTEGER) return 'Until you turn them back on';
  const d = new Date(until);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? `Until ${time}` : `Until ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

function installHint(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'Safari: Share → Add to Home Screen';
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return 'Safari on Mac: File → Add to Dock';
  return 'Browser menu → Install Nexus (or the install icon in the address bar)';
}

const daysLabel = (d: number) => (d === 1 ? '1 day' : `${d} days`);

function hourLabel(h: number): string {
  const hr = ((h + 11) % 12) + 1;
  return `${hr} ${h < 12 ? 'AM' : 'PM'}`;
}

function snoozeLabel(m: number): string {
  return m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`;
}

/** Local value while dragging; re-syncs when the stored setting changes (reset, other tab). */
function useDraft<T>(stored: T): [T, (v: T) => void] {
  const [v, setV] = useState(stored);
  useEffect(() => setV(stored), [stored]);
  return [v, setV];
}

/** AnimatedVisibility(expandVertically() + fadeIn()). Content stays mounted, inert while closed. */
function Collapse({ open, children }: { open: boolean; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (el) el.inert = !open;
  }, [open]);
  return (
    <div ref={ref} class={`nx-collapse ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div>{children}</div>
    </div>
  );
}

function InlineSetting({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="nx-inline">
      <span class="lbl">{label}</span>
      {children}
    </div>
  );
}

type Perm = 'on' | 'local' | 'off' | 'blocked' | 'unsupported' | 'install';

function notifSubtitle(p: Perm): string {
  switch (p) {
    case 'on':
      return 'On · reminders ring even when Nexus is closed';
    case 'local':
      return 'Only while Nexus is open · tap to finish setup';
    case 'blocked':
      return 'Blocked in browser settings';
    case 'install':
      return 'On iPhone: Share → Add to Home Screen, then open Nexus from there';
    case 'unsupported':
      return 'Not supported by this browser';
    default:
      return 'Off · tap to allow';
  }
}

// ─── Nexus Desk (Mac / Windows companion) ───────────────────────────────────

const DEFAULT_SITE = 'https://rsng-phoenix.github.io/Nexus/';
const siteUrl = () => new URL('./', location.href).toString();

function deskCommands() {
  const site = siteUrl();
  const custom = site !== DEFAULT_SITE;
  return {
    mac: `curl -fsSL ${site}desktop/install-mac.sh | ${custom ? `NEXUS_URL=${site} ` : ''}bash`,
    macRemove: `curl -fsSL ${site}desktop/install-mac.sh | bash -s -- --uninstall`,
    windows: `${custom ? `$env:NEXUS_URL='${site}'; ` : ''}irm ${site}desktop/install-windows.ps1 | iex`
  };
}

const platform = (): 'mac' | 'windows' | 'other' => {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|Android/.test(ua)) return 'other';
  if (/Mac/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return 'other';
};

function CommandBox({ label, cmd, hint }: { label: string; cmd: string; hint: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      haptic('CHECK');
      showSnack(`Copied · ${hint}`, undefined, 4000);
    } catch {
      showSnack('Select the command and copy it');
    }
  };
  return (
    <div class="nx-cmd">
      <span class="lbl">{label}</span>
      <div class="box">
        <code>{cmd}</code>
        <button class="press" onClick={() => void copy()} aria-label={`Copy the ${label} command`} title="Copy">
          <Icon name="copy" size={16} />
        </button>
      </div>
    </div>
  );
}

function DeskCard({ os }: { os: 'mac' | 'windows' }) {
  const c = deskCommands();
  const mac = os === 'mac';
  return (
    <div class="nx-desk">
      <div class="head">
        <IconTile icon="desktop" tint={Accent} size={36} />
        <div>
          <b>Nexus Desk for {mac ? 'Mac' : 'Windows'}</b>
          <small>{mac ? 'Menu-bar app · macOS 11 or later' : 'Tray app · Windows 10 and 11'}</small>
        </div>
      </div>
      <ul class="feats">
        <li>A small Nexus window that {mac ? 'floats over every app or sits on the desktop like a widget' : 'stays on top of every app'}</li>
        <li>Hot corner: push the pointer into a corner you pick to show or hide it · uses no power while it waits</li>
        <li>Matrix, Today and a calendar with meetings and clashes · open a task to rename it, tick its checklist, move it or set a deadline</li>
        <li>Choose what the main window shows, or add a separate calendar window</li>
        <li>Size presets{mac ? ', transparency' : ''} and start {mac ? 'at login' : 'with Windows'} · uninstall from its menu</li>
      </ul>
      <CommandBox
        label={mac ? 'Paste in Terminal' : 'Paste in PowerShell'}
        cmd={mac ? c.mac : c.windows}
        hint={mac ? 'open Terminal (⌘ Space → Terminal), paste and press Return' : 'open PowerShell (Start → PowerShell), paste and press Enter'}
      />
      <p class="note">
        {mac
          ? 'Builds a tiny app on your Mac from a short, readable script — no admin password, nothing from the App Store. First time: sign in with Google inside its window.'
          : 'Opens Nexus as an app window of Edge, Chrome or Brave, so you stay signed in as you are there. No admin rights needed.'}
        {mac && (
          <>
            {' '}To remove it: <code>{c.macRemove}</code>
          </>
        )}
      </p>
    </div>
  );
}

type RestorePending = {
  incoming: Task[];
  existingCount: number;
  uniqueCount: number;
  duplicateCount: number;
};

export function SettingsPage(p: LayerProps & { cat?: string }) {
  const s = settingsSig.value;
  const wide = isWide.value;
  const archivedCount = archivedTasks.value.length;
  const deletedCount = recentlyDeleted.value.length;
  const deviceCount = activeTasks.value.filter((t) => !isDemo(t)).length;

  const [trash, setTrash] = useDraft(s.trashDays);
  const [retention, setRetention] = useDraft(s.retentionDays);
  const [fontScale, setFontScale] = useDraft(s.fontScale);
  const [strength, setStrength] = useDraft(s.vibrationStrength);
  const [confirmReset, setConfirmReset] = useState(false);
  const [restore, setRestore] = useState<RestorePending | null>(null);
  const [perm, setPerm] = useState<Perm>('off');
  const readPerm = async (): Promise<Perm> => (needsHomeScreenInstall() ? 'install' : await notificationState());
  const fileInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [widgetsHelp, setWidgetsHelp] = useState(false);
  const [longSession, setLongSession] = useState(false);
  useEffect(() => void hasRefreshToken().then(setLongSession), [s.googleEmail]);
  // Keep the dialog's text while it animates out after the choice clears `restore`.
  const lastRestore = useRef<RestorePending | null>(null);
  if (restore) lastRestore.current = restore;
  const shown = restore ?? lastRestore.current;

  // Which category: a phone page opened for one category shows only that; desktop shows the
  // chosen one next to the list; otherwise the category list itself.
  const fixed = catOf(p.cat)?.id;
  const [picked, setPicked] = useState<CatId>(fixed ?? 'account');
  const mode: 'list' | 'single' | 'split' = wide ? 'split' : fixed ? 'single' : 'list';
  const current = mode === 'single' ? fixed! : picked;
  const scroller = useRef<HTMLDivElement>(null);
  const openCat = (id: CatId) => {
    haptic('DRAG_TICK');
    if (mode === 'split') {
      setPicked(id);
      scroller.current?.scrollTo({ top: 0 });
    } else nav.open({ kind: 'settings', cat: id });
  };

  useEffect(() => {
    const refresh = () => void readPerm().then(setPerm);
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, []);

  const requestNotifications = async () => {
    const r = await enableNotifications();
    if (r === 'error') showSnack("Couldn't reach the reminder service. Try again in a moment.");
    if (r === 'denied') showSnack('Notifications are blocked for this site in your browser settings.');
    setPerm(await readPerm());
  };
  const testNotification = async () => {
    const ok = await sendTestPush();
    showSnack(ok ? 'Test sent. It should appear in a few seconds.' : "Test couldn't be sent. Tap the row to set up again.");
  };

  const exportBackup = async () => {
    try {
      const json = exportFullBackup(await getAllTasksIncludingDeleted());
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `nexus_backup_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      showSnack(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const incoming = parseFullBackup(await file.text());
      const existing = activeTasks.value.filter((t) => !isDemo(t));
      const pv = previewRestore(existing, incoming);
      setRestore({ incoming, existingCount: existing.length, ...pv });
    } catch (err) {
      showSnack(err instanceof Error ? err.message : 'Could not read that file');
    }
  };

  const runRestore = async (m: 'merge' | 'replace') => {
    const r = restore;
    setRestore(null);
    if (!r) return;
    try {
      let n: number;
      if (m === 'merge') n = await mergeRestoreTasks(r.incoming);
      else {
        await replaceAllTasks(r.incoming);
        n = r.incoming.length;
      }
      await reload();
      scheduleSync();
      haptic('SYNC_SUCCESS');
      showSnack(`Restored ${n} tasks`);
    } catch (err) {
      showSnack(err instanceof Error ? err.message : 'Restore failed');
    }
  };

  const hapticsOn = canVibrate && s.vibrationEnabled;

  const now = Date.now();
  const paused = s.pauseNotificationsUntil > now;
  const pauseFor = (m: 'hour' | 'tomorrow' | 'forever' | 'off') => {
    const until =
      m === 'off'
        ? 0
        : m === 'hour'
          ? now + 3_600_000
          : m === 'forever'
            ? Number.MAX_SAFE_INTEGER
            : new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1, s.windowStart).getTime();
    patchSettings({ pauseNotificationsUntil: until });
    showSnack(m === 'off' ? 'Notifications resumed' : `Notifications paused ${pauseLabel(until).toLowerCase()}`);
  };
  const dueDefaults = parseDueAlerts(s.defaultDueAlerts);
  const toggleDefaultOffset = (o: number) =>
    patchSettings({ defaultDueAlerts: formatDueAlerts(dueDefaults.includes(o) ? dueDefaults.filter((x) => x !== o) : [...dueDefaults, o]) });

  /** One line under each category: what it's set to right now. */
  const summary = (id: CatId): string => {
    switch (id) {
      case 'account':
        return s.googleEmail ? `${profileLastSyncedLabel()}${longSession ? ' · stays signed in' : ''}` : 'Not signed in · back up with Google Drive';
      case 'general':
        return `Opens on ${s.startView === 'calendar' ? 'Calendar' : 'Matrix'}`;
      case 'notifications':
        if (paused) return `Paused · ${pauseLabel(s.pauseNotificationsUntil).toLowerCase()}`;
        return perm === 'on'
          ? `On · at most ${s.maxNotificationsPerHour} an hour`
          : perm === 'local'
            ? 'Only while Nexus is open'
            : perm === 'blocked'
              ? 'Blocked in browser settings'
              : perm === 'install'
                ? 'Add to Home Screen first'
                : perm === 'unsupported'
                  ? 'Not supported here'
                  : 'Off';
      case 'reminders':
        return `Snooze ${snoozeLabel(s.snoozeMinutes)} · ${dueDefaults.length ? `${dueDefaults.length} deadline alert${dueDefaults.length === 1 ? '' : 's'} at ${formatAlertTime(s.defaultDueAlertTime)}` : 'no deadline alerts'}`;
      case 'calendar':
        return `${s.linkedCalendars.length ? `${s.linkedCalendars.length} linked · checked every ${refreshLabel(s.calendarRefreshMinutes)}` : 'No linked calendars'} · clash radar ${s.clashRadar ? 'on' : 'off'}${s.calendarFeed ? ' · shown in your calendar apps' : ''}`;
      case 'tasks':
        return `${archivedCount} archived · ${deletedCount} recently deleted`;
      case 'appearance':
        return `${s.themeMode === 'SYSTEM' ? 'System' : s.themeMode === 'DARK' ? 'Dark' : 'Light'} theme · text ${Math.round(s.fontScale * 100)}%`;
      case 'desktop':
        return platform() === 'other' ? 'Widgets and home screen' : 'Nexus Desk, mini window, widgets';
      case 'backup':
        return 'Save or restore a backup file';
      case 'about':
        return `Nexus ${APP_VERSION} · what's new, tour, shortcuts`;
    }
  };

  const catRow = (c: Cat) => (
    <SettingsRow key={c.id} icon={c.icon} title={c.label} subtitle={summary(c.id)} tint={c.tint} onClick={() => openCat(c.id)} trailing={<Chevron />} />
  );

  const accountCard = (compact: boolean) => (
    <button class={`nx-set-account press ${compact ? 'compact' : ''} ${mode === 'split' && current === 'account' ? 'on' : ''}`} onClick={() => openCat('account')}>
      {s.googleEmail ? <Avatar size={compact ? 32 : 44} /> : <IconTile icon="person" tint={Blue} size={compact ? 32 : 44} />}
      <span class="txt">
        <b>{s.googleEmail ? s.displayName || s.googleEmail.split('@')[0] : 'Sign in with Google'}</b>
        <small>{s.googleEmail ? s.googleEmail : 'Back up and sync with your other devices'}</small>
      </span>
      <Chevron />
    </button>
  );

  const body = (id: CatId) => {
    switch (id) {
      case 'account':
        return (
          <>
            <SettingsGroup>
              {s.googleEmail ? (
                <>
                  <SettingsRow
                    icon="sync"
                    title={s.googleEmail}
                    subtitle={profileLastSyncedLabel()}
                    tint={Blue}
                    onClick={() => void runSync().then((r) => showSnack(r.message))}
                    trailing={<TextButton onClick={() => void runSync().then((r) => showSnack(r.message))}>Sync now</TextButton>}
                  />
                  <GroupDivider />
                  <SettingsRow
                    icon="lock"
                    title={longSession ? 'Stays signed in on this device' : 'Google asks again about every hour'}
                    subtitle={
                      longSession
                        ? 'Nexus renews its Google access by itself, even after weeks'
                        : "Tap Reconnect when Nexus asks — it's one click, your tasks are safe meanwhile"
                    }
                    tint={longSession ? Green : Amber}
                  />
                  <GroupDivider />
                  <SettingsRow
                    icon="person"
                    title="Profile"
                    subtitle="Name, sync details and what's in your Drive backup"
                    tint={Accent}
                    onClick={() => nav.open({ kind: 'profile' })}
                  />
                  <GroupDivider />
                  <SettingsRow
                    icon="logout"
                    title="Sign out"
                    subtitle="You choose whether tasks stay on this device"
                    tint={Red}
                    titleColor={Red}
                    onClick={() => void signOutFlow().then((m) => m && showSnack(m))}
                  />
                </>
              ) : (
                <SettingsRow
                  icon="cloud"
                  title="Back up with Google Drive"
                  subtitle="Sync with your Android phone and other devices"
                  tint={Blue}
                  onClick={() => nav.open({ kind: 'profile' })}
                  trailing={<Chevron />}
                />
              )}
            </SettingsGroup>
            <SettingsGroup>
              <SettingsRow
                icon="qrScan"
                title="Set up another device"
                subtitle="Scan a code to copy your linked calendars and settings to a phone, tablet or computer"
                tint={Accent}
                onClick={() => nav.open({ kind: 'pair' })}
                trailing={<Chevron />}
              />
            </SettingsGroup>
            <p class="nx-set-note">
              Nexus stores your tasks in a private Nexus-only folder of your own Google Drive. It can't see any of your other files.
            </p>
          </>
        );

      case 'general':
        return (
          <>
            <SettingsGroup>
              <SettingsRow icon="today" title="Open Nexus on" subtitle="The first screen you see. The other one is one tap away." tint={Accent} />
              <div class="nx-settings-seg">
                <Segmented<StartView>
                  options={[
                    ['matrix', 'Matrix'],
                    ['calendar', 'Calendar']
                  ]}
                  value={s.startView}
                  onChange={(v) => patchSettings({ startView: v })}
                />
              </div>
            </SettingsGroup>
            <SectionHeader>Help</SectionHeader>
            <SettingsGroup>
              {isPc.value && (
                <>
                  <SettingsRow icon="keyboard" title="Keyboard shortcuts" subtitle={SHORTCUTS_SUMMARY} tint={Amber} onClick={() => (shortcutsOpen.value = true)} trailing={<Chevron />} />
                  <GroupDivider />
                </>
              )}
              <SettingsRow
                icon="school"
                title="Replay the tour"
                tint={Accent}
                onClick={() => {
                  nav.closeKind('settings');
                  setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:start-tour')), 60);
                }}
              />
            </SettingsGroup>
            <SectionHeader>Reset</SectionHeader>
            <SettingsGroup>
              <SettingsRow icon="restart" title="Reset settings" subtitle="Every setting back to its default. Your tasks are not touched." tint={Red} titleColor={Red} onClick={() => setConfirmReset(true)} />
            </SettingsGroup>
          </>
        );

      case 'notifications':
        return (
          <>
            <SettingsGroup>
              <SettingsRow
                icon="bell"
                title="Notifications on this device"
                subtitle={notifSubtitle(perm)}
                tint={Blue}
                onClick={perm === 'off' || perm === 'local' ? () => void requestNotifications() : undefined}
                trailing={
                  perm === 'on' ? (
                    <TextButton onClick={() => void testNotification()}>Send test</TextButton>
                  ) : perm === 'off' || perm === 'local' ? (
                    <Chevron />
                  ) : null
                }
              />
              <GroupDivider />
              <SettingsRow
                icon="pause"
                title={paused ? `Paused ${pauseLabel(s.pauseNotificationsUntil).toLowerCase()}` : 'Pause notifications'}
                subtitle={paused ? 'Nothing rings until then. Missed alerts are not replayed.' : 'Quiet everything for a while (focus, meetings, sleep)'}
                tint={paused ? Amber : Accent}
                trailing={paused ? <TextButton onClick={() => pauseFor('off')}>Resume</TextButton> : undefined}
              />
              {!paused && (
                <div class="nx-settings-seg">
                  <div class="nx-pause-row">
                    <button class="nx-imp-chip press" onClick={() => pauseFor('hour')}>1 hour</button>
                    <button class="nx-imp-chip press" onClick={() => pauseFor('tomorrow')}>Until tomorrow {hourLabel(s.windowStart)}</button>
                    <button class="nx-imp-chip press" onClick={() => pauseFor('forever')}>Until I turn them on</button>
                  </div>
                </div>
              )}
            </SettingsGroup>

            <SectionHeader>What can notify you</SectionHeader>
            <SettingsGroup>
              <SettingsRow
                icon="bellRing"
                title="Task reminders"
                subtitle="The times you set on tasks"
                tint={Blue}
                trailing={<Switch label="Task reminders" checked={s.notifyReminders} onChange={(v) => patchSettings({ notifyReminders: v })} />}
              />
              <GroupDivider />
              <SettingsRow
                icon="calendar"
                title="Deadline alerts"
                subtitle="Days before, on and after a task's deadline"
                tint={Red}
                trailing={<Switch label="Deadline alerts" checked={s.notifyDeadlines} onChange={(v) => patchSettings({ notifyDeadlines: v })} />}
              />
              <GroupDivider />
              <SettingsRow
                icon="video"
                title="Meetings from linked calendars"
                subtitle={
                  s.linkedCalendars.length
                    ? 'A heads-up before timed events, with a Join button for Meet, Zoom and Teams'
                    : 'Link a calendar first (Calendar → Linked calendars)'
                }
                tint={Blue}
                trailing={<Switch label="Meetings from linked calendars" checked={s.notifyMeetings} onChange={(v) => patchSettings({ notifyMeetings: v })} />}
              />
              <Collapse open={s.notifyMeetings}>
                <InlineSetting label="Notify me">
                  <Stepper
                    value={Math.max(0, MEETING_LEAD_CHOICES.indexOf(s.meetingLeadMinutes as (typeof MEETING_LEAD_CHOICES)[number]))}
                    min={0}
                    max={MEETING_LEAD_CHOICES.length - 1}
                    format={(i) => meetingLeadLabel(MEETING_LEAD_CHOICES[i])}
                    onChange={(i) => patchSettings({ meetingLeadMinutes: MEETING_LEAD_CHOICES[i] })}
                  />
                </InlineSetting>
              </Collapse>
              <GroupDivider />
              <SettingsRow
                icon="bellRing"
                title="Check-in when I'm away"
                subtitle={`A summary of pending tasks if you don't open Nexus for ${daysLabel(s.checkInDays)}`}
                tint={Amber}
                trailing={<Switch label="Check-in when I'm away" checked={s.checkInEnabled} onChange={(v) => patchSettings({ checkInEnabled: v })} />}
              />
              <Collapse open={s.checkInEnabled}>
                <InlineSetting label="Remind me after">
                  <Stepper
                    value={s.checkInDays}
                    min={CHECK_IN_DAYS_RANGE[0]}
                    max={CHECK_IN_DAYS_RANGE[1]}
                    format={daysLabel}
                    onChange={(v) => patchSettings({ checkInDays: v })}
                  />
                </InlineSetting>
              </Collapse>
            </SettingsGroup>

            <SectionHeader>Keep it calm</SectionHeader>
            <SettingsGroup>
              <SettingsRow
                icon="checklist"
                title="Group alerts that arrive together"
                subtitle="Several tasks due at the same time show as one notification listing all of them"
                tint={Green}
                trailing={<Switch label="Group alerts" checked={s.groupNotifications} onChange={(v) => patchSettings({ groupNotifications: v })} />}
              />
              <GroupDivider />
              <SettingsRow
                icon="timer"
                title="Most notifications per hour"
                subtitle="A safety limit: anything over it is folded into one quiet “N more” notification"
                tint={Amber}
              />
              <InlineSetting label="Limit">
                <Stepper
                  value={s.maxNotificationsPerHour}
                  min={MAX_PER_HOUR_RANGE[0]}
                  max={MAX_PER_HOUR_RANGE[1]}
                  format={(v) => `${v} / hour`}
                  onChange={(v) => patchSettings({ maxNotificationsPerHour: v })}
                />
              </InlineSetting>
            </SettingsGroup>
            <p class="nx-set-note">The same alert never rings twice, even with Nexus open on several devices.</p>
          </>
        );

      case 'reminders':
        return (
          <>
            <SettingsGroup>
              <SettingsRow icon="snooze" title="Snooze length" subtitle="Used by the Snooze button on notifications" tint={Blue} />
              <div class="nx-settings-seg">
                <Segmented<number>
                  options={SNOOZE_CHOICES.map((m) => [m, snoozeLabel(m)] as [number, string])}
                  value={s.snoozeMinutes}
                  onChange={(v) => patchSettings({ snoozeMinutes: v })}
                />
              </div>
            </SettingsGroup>

            <SectionHeader>Repeating reminders</SectionHeader>
            <SettingsGroup>
              <SettingsRow
                icon="schedule"
                title="Ring between"
                subtitle={`All-day and date-range reminders ring between ${hourLabel(s.windowStart)} and ${hourLabel(s.windowEnd)}`}
                tint={Green}
              />
              <InlineSetting label="From">
                <Stepper value={s.windowStart} min={0} max={s.windowEnd - 1} format={hourLabel} onChange={(v) => patchSettings({ windowStart: v })} />
              </InlineSetting>
              <InlineSetting label="Until">
                <Stepper value={s.windowEnd} min={s.windowStart + 1} max={23} format={hourLabel} onChange={(v) => patchSettings({ windowEnd: v })} />
              </InlineSetting>
              <div class="nx-settings-gap" />
            </SettingsGroup>

            <SectionHeader>New deadlines</SectionHeader>
            <SettingsGroup>
              <SettingsRow icon="calendar" title="Remind me" subtitle="Pre-selected when you add a deadline or import a sheet" tint={Red} />
              <div class="nx-settings-seg">
                <div class="nx-pause-row">
                  {DUE_OFFSET_CHOICES.map((c) => (
                    <button
                      key={c.offset}
                      role="checkbox"
                      aria-checked={dueDefaults.includes(c.offset)}
                      class={`nx-imp-chip press ${dueDefaults.includes(c.offset) ? 'on' : ''}`}
                      onClick={() => toggleDefaultOffset(c.offset)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
              <InlineSetting label="At">
                <Stepper
                  value={s.defaultDueAlertTime / 15}
                  min={0}
                  max={95}
                  format={(v) => formatAlertTime(v * 15)}
                  onChange={(v) => patchSettings({ defaultDueAlertTime: v * 15 })}
                />
              </InlineSetting>
              <div class="nx-settings-gap" />
            </SettingsGroup>
          </>
        );

      case 'calendar':
        return (
          <>
            <SettingsGroup>
              <SettingsRow icon="calendar" title="Open calendar" subtitle="Deadlines, reminders and linked calendars (C)" tint={Accent} onClick={() => nav.open({ kind: 'calendar' })} trailing={<Chevron />} />
              <GroupDivider />
              <SettingsRow icon="today" title="Week starts on" tint={Green} />
              <div class="nx-settings-seg">
                <Segmented<0 | 1> options={[[1, 'Monday'], [0, 'Sunday']]} value={s.weekStart} onChange={(v) => patchSettings({ weekStart: v })} />
              </div>
            </SettingsGroup>

            <SectionHeader>Your other calendars</SectionHeader>
            <SettingsGroup>
              <SettingsRow
                icon="link"
                title="Linked calendars"
                subtitle={
                  s.linkedCalendars.length
                    ? `${s.linkedCalendars.length} linked · each event shows which calendar it's from`
                    : 'Show Google, iCloud, Zoho or Outlook events next to your tasks (read-only)'
                }
                tint={Blue}
                onClick={() => nav.open({ kind: 'calendars' })}
                trailing={<Chevron badge={s.linkedCalendars.length ? String(s.linkedCalendars.length) : null} />}
              />
              <InlineSetting label="Check them every">
                <Stepper
                  value={Math.max(0, CALENDAR_REFRESH_CHOICES.indexOf(s.calendarRefreshMinutes as (typeof CALENDAR_REFRESH_CHOICES)[number]))}
                  min={0}
                  max={CALENDAR_REFRESH_CHOICES.length - 1}
                  format={(i) => refreshLabel(CALENDAR_REFRESH_CHOICES[i])}
                  onChange={(i) => patchSettings({ calendarRefreshMinutes: CALENDAR_REFRESH_CHOICES[i] })}
                />
              </InlineSetting>
              <p class="nx-set-inline-note">Also checked every time you open Nexus or the calendar.</p>
            </SettingsGroup>

            <SectionHeader>Your calendar apps</SectionHeader>
            <FeedSettings />

            <SectionHeader>Clash radar</SectionHeader>
            <SettingsGroup>
              <SettingsRow
                icon="radar"
                title="Clash radar"
                subtitle="Spots meetings that overlap across Google, Zoho, iCloud and Outlook · the same invite in two calendars counts once"
                tint={Red}
                trailing={<Switch label="Clash radar" checked={s.clashRadar} onChange={(v) => patchSettings({ clashRadar: v })} />}
              />
              <Collapse open={s.clashRadar}>
                <InlineSetting label="Count it as a clash">
                  <Stepper
                    value={Math.max(0, CLASH_MIN_CHOICES.indexOf(s.clashMinMinutes as (typeof CLASH_MIN_CHOICES)[number]))}
                    min={0}
                    max={CLASH_MIN_CHOICES.length - 1}
                    format={(i) => clashMinLabel(CLASH_MIN_CHOICES[i])}
                    onChange={(i) => patchSettings({ clashMinMinutes: CLASH_MIN_CHOICES[i] })}
                  />
                </InlineSetting>
                <GroupDivider />
                <SettingsRow
                  icon="radar"
                  title="See clashes"
                  subtitle={s.ignoredClashes.length ? `${s.ignoredClashes.length} ignored` : 'Free, declined and all-day events never clash'}
                  tint={Red}
                  onClick={() => nav.open({ kind: 'clashes' })}
                  trailing={<Chevron />}
                />
              </Collapse>
            </SettingsGroup>

            <SectionHeader>Import & export</SectionHeader>
            <SettingsGroup>
              <SettingsRow
                icon="table"
                title="Import from Excel, CSV or a calendar file"
                subtitle="Each row with a date becomes a task with deadline alerts · the file stays on this device"
                tint={Green}
                onClick={() => importInput.current?.click()}
              />
              <input
                ref={importInput}
                type="file"
                hidden
                accept=".ics,.xlsx,.csv,.tsv,text/calendar,text/csv"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  e.currentTarget.value = '';
                  if (!f) return;
                  if (/\.ics$/i.test(f.name)) void f.text().then((text) => nav.open({ kind: 'icsImport', fileName: f.name, text }));
                  else nav.open({ kind: 'sheetImport', file: f });
                }}
              />
              <GroupDivider />
              <SettingsRow
                icon="link"
                title="Link a Google Sheet"
                subtitle="Rows with a date become tasks and keep updating as the sheet changes"
                tint={Green}
                onClick={() => nav.open({ kind: 'sheetImport' })}
              />
              <LinkedSheets />
              <GroupDivider />
              <SettingsRow
                icon="event"
                title="Put Nexus deadlines in your calendar"
                subtitle="Saves an .ics file · Google, Apple and Outlook Calendar can import it. One task: its menu → Add to calendar."
                tint={Blue}
                onClick={() => {
                  downloadIcs(activeTasks.value.filter((t) => !isDemo(t)));
                  showSnack('Saved · open or import the .ics file in your calendar', undefined, 5000);
                }}
              />
            </SettingsGroup>
          </>
        );

      case 'tasks':
        return (
          <>
            <SettingsGroup>
              <SettingsRow
                icon="archive"
                title="Archived"
                subtitle="Hidden from the matrix, kept forever"
                tint={Blue}
                onClick={() => nav.open({ kind: 'vault', which: 'archived' })}
                trailing={<Chevron badge={archivedCount > 0 ? String(archivedCount) : null} />}
              />
              <GroupDivider />
              <SettingsRow
                icon="deleteOutline"
                title="Recently deleted"
                subtitle={`Restore anything from the last ${s.trashDays} days`}
                tint={Red}
                onClick={() => nav.open({ kind: 'vault', which: 'deleted' })}
                trailing={<Chevron badge={deletedCount > 0 ? String(deletedCount) : null} />}
              />
            </SettingsGroup>

            <SectionHeader>Cleaning up</SectionHeader>
            <SettingsGroup>
              <SettingsRow icon="timer" title="Keep deleted tasks" subtitle={`In Recently deleted for ${daysLabel(trash)}`} tint={Red} />
              <div class="nx-slider-row">
                <Slider
                  label="Keep deleted tasks, days"
                  value={trash}
                  min={TRASH_DAYS_RANGE[0]}
                  max={TRASH_DAYS_RANGE[1]}
                  onInput={setTrash}
                  onCommit={(v) => patchSettings({ trashDays: v })}
                />
              </div>
              <GroupDivider />
              <SettingsRow icon="autoDelete" title="Auto-delete done tasks" subtitle={`Completed & won't-do, after ${daysLabel(retention)}`} tint={Amber} />
              <div class="nx-slider-row">
                <Slider
                  label="Auto-delete done tasks, days"
                  value={retention}
                  min={1}
                  max={90}
                  onInput={setRetention}
                  onCommit={(v) => {
                    patchSettings({ retentionDays: v });
                    void purgeExpired();
                  }}
                />
              </div>
            </SettingsGroup>

            <SectionHeader>Task notes</SectionHeader>
            <SettingsGroup>
              <SettingsRow
                icon="checklist"
                title="Checked items sink to the bottom"
                subtitle="In task descriptions"
                tint={Green}
                trailing={<Switch label="Checked items sink to the bottom" checked={s.autoArrange} onChange={(v) => patchSettings({ autoArrange: v })} />}
              />
            </SettingsGroup>
          </>
        );

      case 'appearance':
        return (
          <SettingsGroup>
            <SettingsRow icon="palette" title="Theme" tint={Accent} />
            <div class="nx-settings-seg">
              <Segmented<ThemeMode>
                options={[
                  ['SYSTEM', 'System'],
                  ['LIGHT', 'Light'],
                  ['DARK', 'Dark']
                ]}
                value={s.themeMode}
                onChange={(v) => patchSettings({ themeMode: v })}
              />
            </div>
            <GroupDivider />
            <SettingsRow icon="formatSize" title="Text size" subtitle={`Task titles and notes · ${Math.round(fontScale * 100)}%`} tint={Accent} />
            <div class="nx-slider-row">
              <Slider label="Text size" value={fontScale} min={0.85} max={1.45} step={0.01} onInput={setFontScale} onCommit={(v) => patchSettings({ fontScale: v })} />
            </div>
            <GroupDivider />
            <SettingsRow
              icon="vibration"
              title="Haptics"
              subtitle={canVibrate ? 'Taps, drags, completions' : 'Not supported by this browser (iPhone) · visual feedback only'}
              tint={Accent}
              trailing={
                canVibrate ? (
                  <Switch label="Haptics" checked={s.vibrationEnabled} onChange={(v) => patchSettings({ vibrationEnabled: v })} />
                ) : (
                  <button role="switch" aria-checked={false} aria-label="Haptics" disabled class="nx-switch nx-switch-disabled">
                    <span class="thumb" />
                  </button>
                )
              }
            />
            <Collapse open={hapticsOn}>
              <div class="nx-slider-row split">
                <span class="nx-slider-end">Light</span>
                <Slider
                  label="Haptic strength"
                  value={strength}
                  min={0.1}
                  max={1}
                  step={0.05}
                  onInput={setStrength}
                  onCommit={(v) => {
                    patchSettings({ vibrationStrength: v });
                    haptic('DRAG_DROP');
                  }}
                />
                <span class="nx-slider-end">Strong</span>
              </div>
            </Collapse>
          </SettingsGroup>
        );

      case 'desktop': {
        const os = platform();
        const order: ('mac' | 'windows')[] = os === 'windows' ? ['windows', 'mac'] : ['mac', 'windows'];
        return (
          <>
            {os !== 'other' && (
              <>
                <DeskCard os={order[0]} />
                <details class="nx-desk-other">
                  <summary>Nexus Desk for {order[1] === 'mac' ? 'Mac' : 'Windows'}</summary>
                  <DeskCard os={order[1]} />
                </details>
              </>
            )}
            <SectionHeader>{os === 'other' ? 'On this device' : 'In the browser'}</SectionHeader>
            <SettingsGroup>
              {miniSupported() && (
                <>
                  <SettingsRow
                    icon="pip"
                    title="Mini window"
                    subtitle="A small Nexus that stays on top of every other app, without installing anything (M)"
                    tint={Accent}
                    onClick={() => void openMiniWindow().then((ok) => !ok && showSnack("This browser couldn't open the mini window"))}
                    trailing={<Chevron />}
                  />
                  <GroupDivider />
                </>
              )}
              {!isStandalone() && (
                <>
                  <SettingsRow
                    icon="install"
                    title="Install Nexus as an app"
                    subtitle={canInstall.value ? 'Own window, Dock / taskbar icon, works offline' : installHint()}
                    tint={Green}
                    onClick={canInstall.value ? () => void promptInstall() : undefined}
                    trailing={canInstall.value ? <Chevron /> : undefined}
                  />
                  <GroupDivider />
                </>
              )}
              <SettingsRow icon="widgets" title="Widgets on each device" subtitle="Android home screen, Windows 11 widgets board, Mac, iPhone" tint={Blue} onClick={() => setWidgetsHelp(true)} trailing={<Chevron />} />
            </SettingsGroup>
          </>
        );
      }

      case 'backup':
        return (
          <>
            <SettingsGroup>
              <SettingsRow icon="upload" title="Export backup" subtitle="Save every task as a JSON file" tint={Green} onClick={() => void exportBackup()} />
              <GroupDivider />
              <SettingsRow icon="download" title="Restore from file" subtitle="Choose how to merge before anything changes" tint={Blue} onClick={() => fileInput.current?.click()} />
              <input ref={fileInput} type="file" accept=".json,application/json,text/plain" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => void onFile(e)} />
            </SettingsGroup>
            <p class="nx-set-note">
              {s.googleEmail
                ? `Signed in: your tasks are also backed up to your Google Drive automatically (${profileLastSyncedLabel().toLowerCase()}).`
                : 'Not signed in: your tasks live only on this device. Export a backup now and then, or sign in with Google.'}
            </p>
          </>
        );

      case 'about':
        return (
          <>
            <SettingsGroup>
              <SettingsRow icon="info" title={`Nexus ${APP_VERSION}`} subtitle={`${deviceCount} task${deviceCount === 1 ? '' : 's'} on this device`} tint={Accent} onClick={() => nav.open({ kind: 'about' })} trailing={<Chevron />} />
              <GroupDivider />
              <SettingsRow icon="bellRing" title="What's new" tint={Green} onClick={() => nav.open({ kind: 'changelog' })} trailing={<Chevron />} />
              <GroupDivider />
              <SettingsRow
                icon="school"
                title="Replay the tour"
                tint={Accent}
                onClick={() => {
                  nav.closeKind('settings');
                  setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:start-tour')), 60);
                }}
              />
              {isPc.value && (
                <>
                  <GroupDivider />
                  <SettingsRow icon="keyboard" title="Keyboard shortcuts" subtitle={SHORTCUTS_SUMMARY} tint={Amber} onClick={() => (shortcutsOpen.value = true)} trailing={<Chevron />} />
                </>
              )}
            </SettingsGroup>
          </>
        );
    }
  };

  const title = mode === 'single' ? catOf(fixed)!.label : 'Settings';

  return (
    <Page leaving={p.leaving} onExited={p.onExited} onDismiss={p.onDismiss} class={`nx-settings ${mode}`}>
      <PageHeader title={title} onBack={p.onDismiss} />
      {mode === 'list' && (
        <div class="nx-page-scroll narrow">
          {accountCard(false)}
          {GROUPS.map(([label, ids]) => (
            <div key={label}>
              <SectionHeader>{label}</SectionHeader>
              <SettingsGroup>
                {ids.map((id, i) => (
                  <div key={id}>
                    {i > 0 && <GroupDivider />}
                    {catRow(catOf(id)!)}
                  </div>
                ))}
              </SettingsGroup>
            </div>
          ))}
          <p class="nx-settings-footer">
            Nexus v{APP_VERSION} · {deviceCount} tasks on this device
          </p>
        </div>
      )}
      {mode === 'single' && (
        <div ref={scroller} class="nx-page-scroll narrow nx-set-one">
          {body(current)}
        </div>
      )}
      {mode === 'split' && (
        <div class="nx-set-layout">
          <nav class="nx-set-nav" aria-label="Settings categories">
            {accountCard(true)}
            {GROUPS.map(([label, ids]) => (
              <div key={label} class="grp">
                <span class="glabel">{label}</span>
                {ids.map((id) => {
                  const c = catOf(id)!;
                  return (
                    <button key={id} class={`press ${current === id ? 'on' : ''}`} aria-current={current === id ? 'page' : undefined} onClick={() => openCat(id)}>
                      <Icon name={c.icon} size={18} />
                      {c.label}
                    </button>
                  );
                })}
              </div>
            ))}
            <p class="nx-settings-footer">Nexus v{APP_VERSION}</p>
          </nav>
          <div ref={scroller} class="nx-page-scroll narrow nx-set-scroll">
            <header class="nx-set-head">
              <IconTile icon={catOf(current)!.icon} tint={catOf(current)!.tint} size={36} />
              <div>
                <h2>{catOf(current)!.label}</h2>
                <p>{summary(current)}</p>
              </div>
            </header>
            {body(current)}
          </div>
        </div>
      )}

      <Dialog open={widgetsHelp} onClose={() => setWidgetsHelp(false)} title="Widgets" wide actions={<TextButton onClick={() => setWidgetsHelp(false)}>Done</TextButton>}>
        <div class="nx-help">
          <h3>Android</h3>
          <p>Long-press your home screen → Widgets → Nexus. Pick Matrix, Today, Quick add, Next up or a single quadrant. Tick tasks off right from the widget.</p>
          <h3>Mac</h3>
          <p>
            Install Nexus Desk (Settings → Desktop & widgets): a menu-bar app whose small Nexus window floats over your apps or sits on the desktop like a widget, with a
            hot corner to show or hide it. Without installing anything, the Mini window (M) also floats on top in Chrome, Edge and Brave.
          </p>
          <h3>Windows</h3>
          <p>
            Install Nexus Desk (one PowerShell command, no admin rights) for a Nexus window that stays on top, with a hot corner and a tray icon. For the Windows 11 widgets
            board: open Nexus in Microsoft Edge → ⋯ → Apps → Install Nexus, then press Win + W → + Add widgets → Nexus (Today or Matrix).
          </p>
          <h3>iPhone & iPad</h3>
          <p>Apple doesn't let web apps add home-screen widgets. Add Nexus to your Home Screen (Safari → Share → Add to Home Screen) for a full-screen app and reminders as notifications.</p>
        </div>
      </Dialog>

      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset all settings?"
        actions={
          <>
            <TextButton color="var(--nx-textSec)" onClick={() => setConfirmReset(false)}>
              Cancel
            </TextButton>
            <TextButton
              color={Red}
              onClick={() => {
                resetSettings();
                void purgeExpired();
                setConfirmReset(false);
              }}
            >
              Reset
            </TextButton>
          </>
        }
      >
        Theme, text size, haptics, start screen, notification, reminder, calendar, check-in and auto-delete settings go back to defaults. Tasks, your account and linked calendars
        stay.
      </Dialog>

      <Dialog
        open={restore !== null}
        onClose={() => setRestore(null)}
        title="Restore backup"
        actions={
          shown && (
            <div class="nx-restore-actions">
              <TextButton onClick={() => void runRestore('merge')}>Add {shown.uniqueCount} new tasks</TextButton>
              <TextButton color={Red} onClick={() => void runRestore('replace')}>
                Replace everything
              </TextButton>
              <TextButton color="var(--nx-textSec)" onClick={() => setRestore(null)}>
                Cancel
              </TextButton>
            </div>
          )
        }
      >
        {shown && (
          <div class="nx-restore-body">
            <span>
              The file has {shown.incoming.length} tasks. You have {shown.existingCount} now.
            </span>
            <span class="strong">
              {shown.uniqueCount} new · {shown.duplicateCount} already here
            </span>
            <span class="small">Adding never removes your current tasks.</span>
          </div>
        )}
      </Dialog>
    </Page>
  );
}
