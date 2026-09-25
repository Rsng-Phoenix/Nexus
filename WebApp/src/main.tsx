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
import * as nav from './state/nav';
import { allTasks, onTasksWritten, reload } from './state/store';
import { finishRedirectSignIn, onSyncState, runSync, scheduleSync } from './sync/manager';
import { showSnack } from './state/toasts';
import { ensureOAuthClientConsistency } from './sync/auth';
import { getSettings, initSettings, patchSettings } from './settings/store';
import { App } from './view/App';
import { MiniApp } from './view/MiniWindow';
import { PromptHost } from './view/PromptHost';
import { Toasts } from './view/Shell';
import { Splash } from './view/Splash';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

initSettings();
ensureOAuthClientConsistency(() => patchSettings({ driveFileId: '', lastSyncError: '' }));

// Load tasks while the splash plays, so the matrix appears fully drawn.
const ready = reload();

/**
 * Desktop widget (?mode=widget): the page Nexus Desk shows in its floating window on Mac and
 * Windows. Compact, no splash or tour, and no notifications of its own (the full app or the
 * phone already rings, so a widget must never double them). Remembered for the tab so a
 * Google sign-in round trip comes back to the widget.
 */
const WIDGET_KEY = 'nexus_widget_mode';
const widgetMode = (() => {
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

if (widgetMode) bootWidget();
else bootApp();

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
    initReminders();
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
    // Opened from a notification, a widget or an app shortcut.
    const q = new URLSearchParams(location.search);
    const ref = q.get('task');
    const action = q.get('action');
    const openPage = q.get('open');
    if (ref || action || openPage) history.replaceState(null, '', location.pathname);
    if (pairLink) {
      nav.closeKind('onboarding');
      nav.open({ kind: 'pair', link: pairLink });
    }
    else if (ref) openTaskByUuid(ref);
    else if (action === 'add') nav.open({ kind: 'add', priority: 'HIGH' });
    else if (openPage === 'calendar') nav.open({ kind: 'calendar' });
    else if (openPage === 'quadrant') {
      const p = q.get('p');
      if (p === 'HIGH' || p === 'MEDIUM' || p === 'LOW' || p === 'NONE') nav.open({ kind: 'full', priority: p });
    } else if (getSettings().startView === 'calendar' && getSettings().profileOnboardingDone && getSettings().tutorialDone && !nav.top.value) {
      // "Open Nexus on: Calendar". Back from it shows the matrix.
      nav.open({ kind: 'calendar' });
    }
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

function openTaskByUuid(uuid: string) {
  const t = allTasks.value.find((x) => x.taskUuid === uuid && x.deletedAt === 0);
  if (t) nav.open({ kind: 'detail', taskId: t.id });
}

navigator.serviceWorker?.addEventListener('message', (e) => {
  const msg = e.data as { type?: string; ref?: string };
  if (msg.type === 'nexus:reload') {
    void reload();
    void db.setMeta('pending_local_changes', '').then(() => scheduleSync(300));
  } else if (msg.type === 'nexus:open-task' && msg.ref && !widgetMode) openTaskByUuid(msg.ref);
  else if (msg.type === 'nexus:open-calendar' && !widgetMode && !nav.has('calendar')) nav.open({ kind: 'calendar' });
});

if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}

/** Dev-only handle for scripted UI checks (tree-shaken out of production builds). */
async function installDevHook(): Promise<void> {
  const [store, settings, manager, prompts, linked, ics, pair, feed, sheet] = await Promise.all([
    import('./state/store'),
    import('./settings/store'),
    import('./sync/manager'),
    import('./state/prompts'),
    import('./calendar/linked'),
    import('./calendar/ics'),
    import('./pair/pair'),
    import('./calendar/feed'),
    import('./import/liveSheet')
  ]);
  Object.assign(window, { __nx: { nav, store, settings, manager, prompts, db, linked, ics, pair, feed, sheet } });
}
