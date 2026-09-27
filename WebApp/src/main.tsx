import { render } from 'preact';
import './styles/nexus.css';
import './styles/views.css';
import * as db from './db/tasks';
import { startLinkedAutoRefresh } from './calendar/linked';
import { startSheetAutoRefresh } from './import/liveSheet';
import { startClashRadar } from './calendar/radar';
import { parsePairLink } from './pair/pair';
import { loadFeedStatus, publishFeed, schedulePublishFeed } from './calendar/feed';
import { initReminders } from './reminders/push';
import { onAnnounce } from './state/broadcast';
import { inNexusDesk } from './state/desk';
import * as nav from './state/nav';
import { allTasks, onTasksWritten, reload } from './state/store';
import { finishRedirectSignIn, onSyncState, runSync, scheduleSync } from './sync/manager';
import { showSnack } from './state/toasts';
import { ensureOAuthClientConsistency } from './sync/auth';
import { getSettings, initSettings, patchSettings } from './settings/store';
import { App } from './view/App';
import { MiniApp } from './view/MiniWindow';
import { PromptHost } from './view/PromptHost';
import { QuickAddWindow } from './view/QuickAddWindow';
import { Toasts } from './view/Shell';
import { Splash } from './view/Splash';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

initSettings();
ensureOAuthClientConsistency(() => patchSettings({ driveFileId: '', lastSyncError: '' }));

// Load tasks while the splash plays, so the matrix appears fully drawn.
const ready = reload();

/**
 * Boot modes (docs/premium-desk-architecture.md §4.1):
 * - ?mode=quickadd: the Desk's Quick Add panel (and the same page in a plain tab). Nothing but the composer.
 * - ?mode=widget: the page Nexus Desk shows in its floating window on Mac and Windows. Compact,
 *   no splash or tour, and no notifications of its own unless it is the Desk's ringing window.
 *   Remembered for the tab so a Google sign-in round trip comes back to the widget.
 * - otherwise the full app.
 */
const quickAddMode = new URLSearchParams(location.search).get('mode') === 'quickadd';
const WIDGET_KEY = 'nexus_widget_mode';
const widgetMode =
  !quickAddMode &&
  (() => {
    const on = new URLSearchParams(location.search).get('mode') === 'widget';
    try {
      if (on) sessionStorage.setItem(WIDGET_KEY, '1');
      return on || sessionStorage.getItem(WIDGET_KEY) === '1';
    } catch {
      return on;
    }
  })();

/** ?view=calendar|matrix|today: a Desk window dedicated to one view (e.g. a separate calendar window). */
const widgetView = (() => {
  const q = new URLSearchParams(location.search);
  const v = q.get('view');
  try {
    // Opened by the Desk (mode=widget in the address): the address decides, even "no view".
    // Back from Google's sign-in (no mode in the address): the remembered view is kept.
    if (q.get('mode') === 'widget') {
      if (v) sessionStorage.setItem('nexus_widget_view', v);
      else sessionStorage.removeItem('nexus_widget_view');
    }
    const w = v ?? sessionStorage.getItem('nexus_widget_view');
    return w === 'calendar' || w === 'matrix' || w === 'today' ? w : undefined;
  } catch {
    return v === 'calendar' || v === 'matrix' || v === 'today' ? v : undefined;
  }
})();

// Another Nexus window on this device wrote tasks (or finished a sync): show them at once.
let announceTimer = 0;
const reloadSoon = () => {
  clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => void reload(), 150);
};
onAnnounce('tasks', reloadSoon);
onAnnounce('sync', reloadSoon);

if (quickAddMode) bootQuickAdd();
else if (widgetMode) bootWidget();
else bootApp();

function bootQuickAdd() {
  document.title = 'Quick Add · Nexus';
  document.body.classList.add('nx-mini-body', 'nx-quickadd-page');
  // Inside the Desk the page is see-through so the panel's vibrancy shows around the card.
  if (inNexusDesk()) document.body.classList.add('nx-in-desk');
  void ready.then(() => {
    render(
      <>
        <QuickAddWindow />
        <PromptHost />
        <Toasts />
      </>,
      root!
    );
    if (import.meta.env.DEV) void installDevHook();
  });
}

function bootWidget() {
  document.title = widgetView === 'calendar' ? 'Nexus Calendar Widget' : 'Nexus Widget';
  document.body.classList.add('nx-mini-body', 'nx-widget-page');
  void ready.then(() => {
    render(
      <>
        <MiniApp win={window} widget only={widgetView} />
        <PromptHost />
        <Toasts />
      </>,
      root!
    );
    void finishRedirectSignIn().then((msg) => msg && showSnack(msg, undefined, 4000));
    startLinkedAutoRefresh();
    startSheetAutoRefresh();
    startClashRadar();
    // Nexus Desk for Mac rings reminders as macOS notifications (its main window only, so the
    // separate calendar window doesn't ring them twice).
    if (inNexusDesk() && widgetView !== 'calendar') initReminders();
    if (import.meta.env.DEV) void installDevHook();
    // Edits made in the widget reach "Show Nexus in your calendar apps" too.
    void loadFeedStatus();
    onTasksWritten(schedulePublishFeed);
    // Show what each sync brought down (the full app does this in App.tsx).
    onSyncState((busy, result) => {
      if (!busy && result) void reload();
    });
    const sync = () => void (getSettings().googleEmail && runSync({ background: true }));
    sync();
    // Changes from the phone or the full app show up within minutes, and at once when focused.
    window.setInterval(sync, 5 * 60_000);
    window.addEventListener('focus', () => scheduleSync(400));
    // The Desk says when the Mac wakes from sleep or its display comes back.
    (window as Window & { __nexusWake?: () => void }).__nexusWake = () => scheduleSync(2000);
  });
}

function bootApp() {
  // Scan to set up: read the one-time code, then wipe it (and its key) from the address bar and history.
  const pairLink = parsePairLink(location.href);
  if (pairLink) history.replaceState(null, '', location.pathname);
  const splashHost = document.createElement('div');
  document.body.appendChild(splashHost);
  render(
    <Splash
      onDone={() => {
        render(null, splashHost);
        splashHost.remove();
      }}
    />,
    splashHost
  );
  void ready.then(async () => {
    render(<App />, root!);
    if (import.meta.env.DEV) void installDevHook();
    // In the Desk the widget window rings the reminders; the full window must not double them.
    if (!inNexusDesk()) initReminders();
    startLinkedAutoRefresh();
    startSheetAutoRefresh();
    startClashRadar();
    // Back from Google's sign-in page: finish signing in (asks about local tasks if needed).
    void finishRedirectSignIn().then((msg) => msg && showSnack(msg, undefined, 4000));
    // Changes made from a notification (Done) while the app was closed: sync them now.
    if ((await db.getMeta('pending_local_changes')) === '1') {
      await db.setMeta('pending_local_changes', '');
      scheduleSync(500);
    }
    // Opened from a notification, a widget, an app shortcut or the Desk.
    const q = new URLSearchParams(location.search);
    if (q.has('task') || q.has('action') || q.has('open')) history.replaceState(null, '', location.pathname);
    if (pairLink) {
      nav.closeKind('onboarding');
      nav.open({ kind: 'pair', link: pairLink });
    } else if (!handleOpenQuery(q) && getSettings().startView === 'calendar' && getSettings().profileOnboardingDone && getSettings().tutorialDone && !nav.top.value) {
      // "Open Nexus on: Calendar". Back from it shows the matrix.
      nav.open({ kind: 'calendar' });
    }
    // The Desk deep-links an already open full window the same way (§2.5).
    (window as Window & { __nexusDeepLink?: (o: DeepLink) => boolean }).__nexusDeepLink = (o) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(o ?? {})) if (v != null && v !== '') p.set(k, String(v));
      return handleOpenQuery(p);
    };
    // Live calendar feed: resend a few seconds after the last change (only if the content changed).
    // Tasks ticked off from a notification while Nexus was closed: sent now (skipped if unchanged).
    void loadFeedStatus().then(() => publishFeed());
    onTasksWritten(schedulePublishFeed);
    // Windows widgets re-render from IndexedDB after every change.
    let widgetTimer = 0;
    onTasksWritten(() => {
      clearTimeout(widgetTimer);
      widgetTimer = window.setTimeout(() => navigator.serviceWorker?.controller?.postMessage({ type: 'nexus:widgets' }), 1500);
    });
  });
}

type DeepLink = { task?: string; action?: string; open?: string; p?: string };

/**
 * Deep links into the full app: `?task=<uuid>` opens a task, `?action=add` the add sheet,
 * `?open=calendar|settings|quadrant` (with `p=` for the quadrant) a page. Returns whether
 * anything was opened.
 */
function handleOpenQuery(q: URLSearchParams): boolean {
  const ref = q.get('task');
  const action = q.get('action');
  const openPage = q.get('open');
  if (ref) {
    openTaskByUuid(ref);
    return true;
  }
  if (action === 'add') {
    nav.open({ kind: 'add', priority: 'HIGH' });
    return true;
  }
  if (openPage === 'calendar') {
    if (!nav.has('calendar')) nav.open({ kind: 'calendar' });
    return true;
  }
  if (openPage === 'settings') {
    if (!nav.has('settings')) nav.open({ kind: 'settings' });
    return true;
  }
  if (openPage === 'quadrant') {
    const p = q.get('p');
    if (p === 'HIGH' || p === 'MEDIUM' || p === 'LOW' || p === 'NONE') {
      nav.open({ kind: 'full', priority: p });
      return true;
    }
  }
  return false;
}

function openTaskByUuid(uuid: string) {
  const t = allTasks.value.find((x) => x.taskUuid === uuid && x.deletedAt === 0);
  if (!t) return;
  // Already looking at it (a second notification tap): nothing to do.
  const top = nav.top.value;
  if (top?.kind === 'detail' && top.taskId === t.id) return;
  nav.open({ kind: 'detail', taskId: t.id });
}

navigator.serviceWorker?.addEventListener('message', (e) => {
  const msg = e.data as { type?: string; ref?: string };
  if (msg.type === 'nexus:reload') {
    void reload();
    void db.setMeta('pending_local_changes', '').then(() => scheduleSync(300));
  } else if (msg.type === 'nexus:open-task' && msg.ref && !widgetMode && !quickAddMode) openTaskByUuid(msg.ref);
  else if (msg.type === 'nexus:open-calendar' && !widgetMode && !quickAddMode && !nav.has('calendar')) nav.open({ kind: 'calendar' });
});

if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}

/** Dev-only handle for scripted UI checks (tree-shaken out of production builds). */
async function installDevHook(): Promise<void> {
  const [store, settings, manager, prompts, linked, ics, pair, feed, sheet, desk] = await Promise.all([
    import('./state/store'),
    import('./settings/store'),
    import('./sync/manager'),
    import('./state/prompts'),
    import('./calendar/linked'),
    import('./calendar/ics'),
    import('./pair/pair'),
    import('./calendar/feed'),
    import('./import/liveSheet'),
    import('./state/desk')
  ]);
  Object.assign(window, { __nx: { nav, store, settings, manager, prompts, db, linked, ics, pair, feed, sheet, desk } });
}
