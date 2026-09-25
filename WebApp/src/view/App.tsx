import { useEffect, useRef } from 'preact/hooks';
import { getSettings, settingsSig } from '../settings/store';
import * as nav from '../state/nav';
import type { LayerEntry } from '../state/nav';
import { purgeExpired, reload } from '../state/store';
import { showSnack, showSyncPill } from '../state/toasts';
import { onSyncState, runSync } from '../sync/manager';
import { AboutSheet, ChangelogDialog } from './AboutSheet';
import { AddTaskSheet } from './AddTaskSheet';
import { FullScreenQuadrant } from './FullScreen';
import { Matrix } from './Matrix';
import { Onboarding } from './Onboarding';
import { ProfileSheet } from './ProfileSheet';
import { PriorityPicker } from './QuickAdd';
import { PromptHost } from './PromptHost';
import { activePrompt } from '../state/prompts';
import { closeMiniWindow, miniOpen, miniSupported, openMiniWindow } from './MiniWindow';
import { ReminderWizard } from './ReminderWizard';
import { DeadlineSheet } from './DeadlineSheet';
import { CalendarPage } from './CalendarPage';
import { LinkedCalendarsSheet } from './LinkedCalendarsSheet';
import { ClashSheet } from './ClashSheet';
import { PairSheet } from './PairSheet';
import { IcsImportSheet } from './IcsImportSheet';
import { SheetImportPage } from './SheetImportPage';
import { SettingsPage } from './SettingsPage';
import { ShareSheet } from './ShareSheet';
import { Fab, Toasts, TopBar, usePullToSync } from './Shell';
import { TaskDetailSheet } from './TaskDetailSheet';
import { TourOverlay, startTour } from './Tour';
import { VaultPage } from './VaultPage';
import { isPc } from '../state/viewport';
import { tour } from './tour-state';
import { Palette } from './Palette';
import { isMac, ShortcutsDialog, shortcutsOpen } from './Shortcuts';
import { handleMatrixKey, moveFocusedTo } from './keynav';

/** Props every layer component receives. */
export type LayerProps = {
  id: number;
  leaving: boolean;
  onExited: () => void;
  onDismiss: () => void;
};

export function App() {
  const shell = useRef<HTMLDivElement>(null);
  usePullToSync(shell, () => {
    if (!getSettings().googleEmail) {
      showSnack('Sign in with Google to sync', { label: 'Sign in', run: () => nav.open({ kind: 'profile' }) });
      return;
    }
    void runSync();
  });

  useEffect(() => {
    void purgeExpired();
    const s = getSettings();
    // A scanned "Scan to set up" code opens its own sheet instead of the first-run screen / tour.
    if (nav.has('pair')) {
      /* setting up from another device */
    } else if (!s.profileOnboardingDone) nav.open({ kind: 'onboarding' });
    else if (!s.tutorialDone) startTour();
    if (s.googleEmail) void runSync({ background: true });
    // Pull remote changes into the UI when a sync finishes.
    let reconnectShown = false;
    const off = onSyncState((busy, result) => {
      if (busy || !result) return;
      void reload();
      if (result.needsReconnect && !result.ok) {
        // Once per session: background syncs must not nag every few minutes.
        if (reconnectShown) return;
        reconnectShown = true;
        showSnack('Google Drive needs you to sign in again', { label: 'Reconnect', run: () => void runSync() }, 6000);
      } else if (result.ok && result.message !== 'Synced') {
        showSyncPill(result.message.replace('Synced · ', '↓ '));
      }
    });
    const every15 = window.setInterval(() => void runSync({ background: true }), 15 * 60_000);
    // Keyboard (any device with one): ⌘K palette, Enter or N new task, 1–4 open a quadrant, S sync,
    // comma settings, ? shortcuts; arrows / hjkl highlight a task (view/keynav.ts). Full list in Shortcuts.tsx.
    const keys = (e: KeyboardEvent) => {
      const t = e.target;
      if (activePrompt.value) return;
      const top = nav.top.value;
      // ⌘K / Ctrl+K toggles the palette from the matrix, a quadrant or the calendar (not inside a sheet).
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        if (top?.kind === 'palette') nav.back();
        else if (!top || top.kind === 'full' || top.kind === 'calendar') nav.open({ kind: 'palette' });
        else return;
        e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || top || shortcutsOpen.value) return;
      if (t instanceof Element && t.closest('input, textarea, [contenteditable="true"]')) return;
      const digit = ({ Digit1: 'HIGH', Digit2: 'MEDIUM', Digit3: 'LOW', Digit4: 'NONE' } as const)[e.code as 'Digit1'];
      if (e.altKey) {
        // ⌥1–4 moves the highlighted task (e.code: on a Mac ⌥1 types "¡", so e.key is no use).
        if (digit && moveFocusedTo(digit)) e.preventDefault();
        return;
      }
      if (handleMatrixKey(e)) return;
      const quad = ({ '1': 'HIGH', '2': 'MEDIUM', '3': 'LOW', '4': 'NONE' } as const)[e.key as '1'];
      const onControl = t instanceof Element && t.closest('button, a, [role="button"], select');
      if ((e.key === 'Enter' && !onControl && !e.repeat) || e.key === 'n' || e.key === 'N') {
        if (!tour.allows('ADD')) return;
        e.preventDefault();
        nav.open({ kind: 'pick' });
      } else if (quad) nav.open({ kind: 'full', priority: quad });
      else if (e.key === 'c' || e.key === 'C') nav.open({ kind: 'calendar' });
      else if ((e.key === 'm' || e.key === 'M') && miniSupported()) void (miniOpen.value ? closeMiniWindow() : openMiniWindow());
      else if (e.key === 's' && getSettings().googleEmail) void runSync();
      else if (e.key === ',') nav.open({ kind: 'settings' });
      else if (e.key === '/') {
        e.preventDefault();
        nav.open({ kind: 'palette' });
      } else if (e.key === '?') shortcutsOpen.value = true;
    };
    window.addEventListener('keydown', keys);
    return () => {
      off();
      clearInterval(every15);
      window.removeEventListener('keydown', keys);
    };
  }, []);

  settingsSig.value; // theme / font scale re-render
  return (
    <div class="nx-app" ref={shell}>
      <TopBar onBrand={() => nav.open({ kind: 'about' })} />
      <Matrix />
      {!isPc.value && <Fab onAdd={(p) => nav.open({ kind: 'add', priority: p })} />}
      <LayerHost />
      <Toasts />
      <TourOverlay />
      <PromptHost />
      <ShortcutsDialog />
    </div>
  );
}

function LayerHost() {
  const live = nav.layers.value;
  const gone = nav.leaving.value;
  // Render in stack order; leaving layers keep their slot until the exit animation ends.
  const all = [...live.map((l) => ({ l, leaving: false })), ...gone.map((l) => ({ l, leaving: true }))].sort(
    (a, b) => a.l.id - b.l.id
  );
  return (
    <>
      {all.map(({ l, leaving }) => (
        <LayerView key={l.id} entry={l} leaving={leaving} />
      ))}
    </>
  );
}

function LayerView({ entry, leaving }: { entry: LayerEntry; leaving: boolean }) {
  const p: LayerProps = {
    id: entry.id,
    leaving,
    onExited: () => nav.finishLeave(entry.id),
    onDismiss: () => {
      if (leaving) return;
      if (nav.top.value?.id === entry.id) nav.back();
      else nav.closeFrom(entry.id);
    }
  };
  switch (entry.kind) {
    case 'add':
      return <AddTaskSheet {...p} priority={entry.priority} locked={entry.locked} text={entry.text} due={entry.due} notes={entry.notes} />;
    case 'pick':
      return <PriorityPicker {...p} />;
    case 'detail':
      return <TaskDetailSheet {...p} taskId={entry.taskId} />;
    case 'full':
      return <FullScreenQuadrant {...p} priority={entry.priority} folder={entry.folder} />;
    case 'settings':
      return <SettingsPage {...p} cat={entry.cat} />;
    case 'vault':
      return <VaultPage {...p} which={entry.which} />;
    case 'about':
      return <AboutSheet {...p} />;
    case 'changelog':
      return <ChangelogDialog {...p} />;
    case 'profile':
      return <ProfileSheet {...p} />;
    case 'share':
      return <ShareSheet {...p} payload={entry.payload} />;
    case 'reminder':
      return <ReminderWizard {...p} taskId={entry.taskId} />;
    case 'deadline':
      return <DeadlineSheet {...p} taskId={entry.taskId} presetDate={entry.presetDate} />;
    case 'onboarding':
      return <Onboarding {...p} />;
    case 'calendar':
      return <CalendarPage {...p} />;
    case 'calendars':
      return <LinkedCalendarsSheet {...p} />;
    case 'clashes':
      return <ClashSheet {...p} />;
    case 'pair':
      return <PairSheet {...p} link={entry.link} />;
    case 'icsImport':
      return <IcsImportSheet {...p} fileName={entry.fileName} text={entry.text} />;
    case 'sheetImport':
      return <SheetImportPage {...p} file={entry.file} />;
    case 'palette':
      return <Palette {...p} />;
    default:
      return null;
  }
}
