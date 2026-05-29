import { NexusApp } from './app';

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app missing');

new NexusApp(appEl);

if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
