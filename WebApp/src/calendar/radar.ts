import { computed, signal } from '@preact/signals';
import { getSettings, MAX_IGNORED_CLASHES, patchSettings, settingsSig } from '../settings/store';
import { upcomingClashes, type Clash } from './clashes';
import { linkedState } from './linked';

/** Advances every few minutes so clashes that are over drop off the radar. */
const tick = signal(Date.now());
let started = false;

export function startClashRadar(): void {
  if (started) return;
  started = true;
  const bump = () => (tick.value = Date.now());
  window.setInterval(bump, 5 * 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && bump());
}

/** Upcoming clashes between meetings in the linked calendars (empty when the radar is off). */
export const clashes = computed<Clash[]>(() => {
  const s = settingsSig.value;
  if (!s.clashRadar || s.linkedCalendars.length === 0) return [];
  const state = linkedState.value;
  const linked = s.linkedCalendars.map((c) => ({ calendar: c, events: state[c.id]?.events ?? [] }));
  return upcomingClashes(linked, s.clashMinMinutes, s.ignoredClashes, tick.value);
});

export function ignoreClash(id: string): void {
  const cur = getSettings().ignoredClashes.filter((x) => x !== id);
  patchSettings({ ignoredClashes: [...cur, id].slice(-MAX_IGNORED_CLASHES) });
}

export function unignoreClash(id: string): void {
  patchSettings({ ignoredClashes: getSettings().ignoredClashes.filter((x) => x !== id) });
}

export function unignoreAllClashes(): void {
  patchSettings({ ignoredClashes: [] });
}
