import { signal } from '@preact/signals';

/** True when the window is wide enough for the desktop layout (side panel, floating sheets). */
const mq = typeof matchMedia !== 'undefined' ? matchMedia('(min-width: 1024px)') : null;
export const isWide = signal(mq?.matches ?? false);
mq?.addEventListener('change', (e) => (isWide.value = e.matches));

/**
 * A computer: mouse/trackpad is the main pointer and there is no touch screen. Phones and
 * tablets (even with a keyboard attached) keep the + button; everyone gets Enter to add.
 */
const pcQuery = '(hover: hover) and (pointer: fine)';
const touchQuery = '(any-pointer: coarse)';
const pcMq = typeof matchMedia !== 'undefined' ? matchMedia(pcQuery) : null;
const touchMq = typeof matchMedia !== 'undefined' ? matchMedia(touchQuery) : null;
const computePc = () => !!pcMq?.matches && !touchMq?.matches;
export const isPc = signal(computePc());
pcMq?.addEventListener('change', () => (isPc.value = computePc()));
touchMq?.addEventListener('change', () => (isPc.value = computePc()));
