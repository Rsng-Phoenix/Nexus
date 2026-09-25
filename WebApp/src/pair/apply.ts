import { refreshLinked } from '../calendar/linked';
import { refreshSheets } from '../import/liveSheet';
import * as nav from '../state/nav';
import { getSettings, patchSettings, type LinkedCalendar } from '../settings/store';
import { newCalendars, newSheets, type SetupPayload } from './pair';

export type ApplyChoice = { calendars: boolean; prefs: boolean; sheets?: boolean };

/** Adds the calendars this device doesn't have and copies the preferences. Returns calendars added. */
export function applySetup(p: SetupPayload, choice: ApplyChoice): number {
  const s = getSettings();
  const added: LinkedCalendar[] = choice.calendars
    ? newCalendars(p, s.linkedCalendars).map((c) => ({ id: crypto.randomUUID(), name: c.name || 'Calendar', url: c.url, color: c.color, enabled: c.enabled, updatedAt: Date.now() }))
    : [];
  // Linked sheets: this device reads each sheet itself (same task ids as the sender, so no duplicates).
  const sheets = choice.sheets
    ? newSheets(p, s.linkedSheets).map((x) => ({ id: crypto.randomUUID(), ...x, enabled: true, lastSyncAt: 0, lastError: '' }))
    : [];
  patchSettings({
    ...(choice.prefs ? p.prefs : {}),
    ...(sheets.length ? { linkedSheets: [...s.linkedSheets, ...sheets] } : {}),
    ...(added.length ? { linkedCalendars: [...s.linkedCalendars, ...added], linkedRemoved: s.linkedRemoved.filter((r) => !added.some((c) => c.url === r.url)) } : {}),
    // Someone setting up this way has used Nexus before: skip the first-run screens.
    profileOnboardingDone: true,
    tutorialDone: true
  });
  nav.closeKind('onboarding');
  if (added.length) void refreshLinked(true);
  if (sheets.length) void refreshSheets(true);
  return added.length + sheets.length;
}
