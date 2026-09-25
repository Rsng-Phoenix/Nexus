import { refreshLinked } from '../calendar/linked';
import * as nav from '../state/nav';
import { getSettings, patchSettings, type LinkedCalendar } from '../settings/store';
import { newCalendars, type SetupPayload } from './pair';

export type ApplyChoice = { calendars: boolean; prefs: boolean };

/** Adds the calendars this device doesn't have and copies the preferences. Returns calendars added. */
export function applySetup(p: SetupPayload, choice: ApplyChoice): number {
  const s = getSettings();
  const added: LinkedCalendar[] = choice.calendars
    ? newCalendars(p, s.linkedCalendars).map((c) => ({ id: crypto.randomUUID(), name: c.name || 'Calendar', url: c.url, color: c.color, enabled: c.enabled, updatedAt: Date.now() }))
    : [];
  patchSettings({
    ...(choice.prefs ? p.prefs : {}),
    ...(added.length ? { linkedCalendars: [...s.linkedCalendars, ...added], linkedRemoved: s.linkedRemoved.filter((r) => !added.some((c) => c.url === r.url)) } : {}),
    // Someone setting up this way has used Nexus before: skip the first-run screens.
    profileOnboardingDone: true,
    tutorialDone: true
  });
  nav.closeKind('onboarding');
  if (added.length) void refreshLinked(true);
  return added.length;
}
