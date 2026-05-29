import { NexusApp } from './app';
import { showSplash } from './ui/splash';

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app missing');

showSplash(() => {
  new NexusApp(appEl);
});

if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
