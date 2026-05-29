import { NexusApp } from './app';
import { ensureOAuthClientConsistency } from './sync/auth';
import { initSettings, patchSettings } from './settings/store';
import { showSplash } from './ui/splash';

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app missing');

initSettings();
ensureOAuthClientConsistency(() => {
  patchSettings({ driveFileId: '', lastSyncError: '' });
});

showSplash(() => {
  new NexusApp(appEl);
});

if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
