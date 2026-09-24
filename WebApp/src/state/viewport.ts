import { signal } from '@preact/signals';

/** True when the window is wide enough for the desktop layout (side panel, floating sheets). */
const mq = typeof matchMedia !== 'undefined' ? matchMedia('(min-width: 1024px)') : null;
export const isWide = signal(mq?.matches ?? false);
mq?.addEventListener('change', (e) => (isWide.value = e.matches));
