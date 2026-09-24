import { calendarSlot, googleCalendarUrl, outlookCalendarUrl } from '../calendar/addto';
import { todayIso } from '../calendar/deadline';
import { exportIcs } from '../calendar/ics';
import { fromStorage, toPlainText } from '../notes/codec';
import { askChoice } from '../state/prompts';
import { showSnack } from '../state/toasts';
import type { Task } from '../types';

/** Save tasks as an .ics file (Apple Calendar, Outlook desktop and most others open it). */
export function downloadIcs(tasks: Task[], fileName = `nexus-${todayIso()}.ics`): void {
  const text = exportIcs(tasks, { now: Date.now(), calName: 'Nexus', notesToText: (n) => toPlainText(fromStorage(n)) });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Ask which calendar, then open its prefilled "new event" screen (or save an .ics). */
export async function addTaskToCalendar(t: Task): Promise<void> {
  const slot = calendarSlot(t);
  if (!slot) {
    showSnack('Add a deadline or a reminder time first');
    return;
  }
  const choice = await askChoice({
    title: 'Add to your calendar',
    body: `“${t.description}” opens in your calendar ready to save. Nexus doesn't get access to that calendar, and later changes here aren't copied there.`,
    options: [
      { id: 'google', label: 'Google Calendar', tone: 'primary' },
      { id: 'outlook', label: 'Outlook.com', tone: 'plain' },
      { id: 'ics', label: 'Apple Calendar or other (.ics file)', tone: 'plain' }
    ],
    cancelLabel: 'Cancel'
  });
  if (!choice) return;
  const details = [toPlainText(fromStorage(t.notes)).trim(), 'Added from Nexus'].filter(Boolean).join('\n\n');
  if (choice === 'ics') {
    downloadIcs([t], `${t.description.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'nexus-task'}.ics`);
    showSnack('Saved · open the file to add it to your calendar', undefined, 4000);
    return;
  }
  const url = choice === 'google' ? googleCalendarUrl(t.description, details, slot) : outlookCalendarUrl(t.description, details, slot);
  window.open(url, '_blank', 'noopener');
}
