import { signal } from '@preact/signals';

/** "Install app" (Chrome, Edge, Brave on Windows/Mac/Android). Safari uses Share → Add to Dock / Home Screen. */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallEvent | null = null;
export const canInstall = signal(false);
export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  matchMedia('(display-mode: window-controls-overlay)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    canInstall.value = true;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    canInstall.value = false;
  });
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  canInstall.value = false;
  return outcome === 'accepted';
}
