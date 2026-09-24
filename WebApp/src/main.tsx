import { render } from 'preact';
import './styles/nexus.css';
import './styles/views.css';
import * as db from './db/tasks';
import { initReminders } from './reminders/push';
import * as nav from './state/nav';
import { allTasks, reload } from './state/store';
import { scheduleSync } from './sync/manager';
import { ensureOAuthClientConsistency } from './sync/auth';
import { initSettings, patchSettings } from './settings/store';
import { App } from './view/App';
import { Splash } from './view/Splash';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

initSettings();
ensureOAuthClientConsistency(() => patchSettings({ driveFileId: '', lastSyncError: '' }));

// Load tasks while the splash plays, so the matrix appears fully drawn.
const ready = reload();

function Boot() {
  return <App />;
}

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
  render(<Boot />, root);
  initReminders();
  // Changes made from a notification (Done) while the app was closed: sync them now.
  if ((await db.getMeta('pending_local_changes')) === '1') {
    await db.setMeta('pending_local_changes', '');
    scheduleSync(500);
  }
  // Opened from a notification tap.
  const ref = new URLSearchParams(location.search).get('task');
  if (ref) {
    history.replaceState(null, '', location.pathname);
    openTaskByUuid(ref);
  }
});

function openTaskByUuid(uuid: string) {
  const t = allTasks.value.find((x) => x.taskUuid === uuid && x.deletedAt === 0);
  if (t) nav.open({ kind: 'detail', taskId: t.id });
}

navigator.serviceWorker?.addEventListener('message', (e) => {
  const msg = e.data as { type?: string; ref?: string };
  if (msg.type === 'nexus:reload') {
    void reload();
    void db.setMeta('pending_local_changes', '').then(() => scheduleSync(300));
  } else if (msg.type === 'nexus:open-task' && msg.ref) openTaskByUuid(msg.ref);
});

if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}
