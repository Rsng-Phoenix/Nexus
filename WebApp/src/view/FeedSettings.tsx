import { useEffect, useState } from 'preact/hooks';
import { disableFeed, enableFeed, feedLinks, feedStatus, publishFeed, resetFeed, setFeedNotes, syncFeedCreds } from '../calendar/feed';
import { haptic } from '../lib/haptics';
import { getSettings, settingsSig } from '../settings/store';
import { askChoice } from '../state/prompts';
import { showSnack } from '../state/toasts';
import { getAccessToken } from '../sync/auth';
import { Icon } from './icons';
import { Switch } from './kit';

/** A Drive token when signed in (the feed is then shared with your other devices), else null. */
const driveToken = async () => (getSettings().googleEmail ? getAccessToken({ interactive: false }).catch(() => null) : null);

const ago = (at: number) => {
  if (!at) return 'Not sent yet';
  const m = Math.floor((Date.now() - at) / 60_000);
  return m < 1 ? 'Updated just now' : m < 60 ? `Updated ${m} min ago` : m < 1440 ? `Updated ${Math.floor(m / 60)} h ago` : `Updated ${Math.floor(m / 1440)} d ago`;
};

/** Settings → Calendar: "Show Nexus in your calendar apps" (the live iCal feed). */
export function FeedSettings() {
  const c = settingsSig.value.calendarFeed;
  const st = feedStatus.value;
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      showSnack(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () =>
    run(async () => {
      await enableFeed(false);
      const token = await driveToken();
      // Signed in: share it through Drive so your other devices keep it up to date too.
      if (token) await syncFeedCreds(token);
      haptic('CHECK');
      showSnack('Calendar link ready · add it to Google, Apple or Outlook below');
    });
  const turnOff = () =>
    run(async () => {
      const ok = await askChoice({
        title: 'Stop showing Nexus in your calendars?',
        body: 'The link stops working in every calendar app you added it to, on all your devices. Your tasks stay in Nexus.',
        options: [{ id: 'off', label: 'Turn off', tone: 'danger' }],
        cancelLabel: 'Keep it'
      });
      if (ok !== 'off') return;
      await disableFeed(await driveToken());
      showSnack('Calendar link turned off');
    });
  const newLink = () =>
    run(async () => {
      const ok = await askChoice({
        title: 'Make a new link?',
        body: 'Use this if the link was shared by mistake. The old link stops working, so add the new one to your calendar apps again.',
        options: [{ id: 'new', label: 'Make a new link', tone: 'primary' }],
        cancelLabel: 'Cancel'
      });
      if (ok !== 'new') return;
      await resetFeed(await driveToken());
      showSnack('New link ready · add it to your calendar apps again');
    });

  if (!c) {
    return (
      <div class="nx-feed off">
        <div class="head">
          <span class="ic"><Icon name="event" size={20} /></span>
          <span class="txt">
            <b>Show Nexus in your calendar apps</b>
            <small>Your deadlines and reminders appear in Google, Apple or Outlook Calendar and stay up to date as you add, change or finish tasks.</small>
          </span>
          <Switch label="Show Nexus in your calendar apps" checked={false} onChange={() => void turnOn()} />
        </div>
      </div>
    );
  }

  const links = feedLinks(c);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(links.https);
      haptic('CHECK');
      showSnack('Link copied · paste it into “Add calendar from URL”');
    } catch {
      showSnack('Select the link and copy it');
    }
  };
  return (
    <div class="nx-feed">
      <div class="head">
        <span class="ic on"><Icon name="event" size={20} /></span>
        <span class="txt">
          <b>Show Nexus in your calendar apps</b>
          <small class={st.error ? 'err' : ''}>
            {st.error ? st.error : ago(st.at)} · {c.shared ? 'kept up to date by all your devices' : 'kept up to date by this device'}
          </small>
        </span>
        <Switch label="Show Nexus in your calendar apps" checked onChange={() => void turnOff()} />
      </div>
      <div class="adds">
        <a class="add google press" href={links.google} target="_blank" rel="noopener noreferrer">
          <b>Google Calendar</b>
          <small>Updates every few hours (Google's pace)</small>
        </a>
        <a class="add apple press" href={links.webcal}>
          <b>Apple Calendar</b>
          <small>iPhone, iPad, Mac · set “Auto-refresh” to every 5 minutes</small>
        </a>
        <a class="add outlook press" href={links.outlook} target="_blank" rel="noopener noreferrer">
          <b>Outlook</b>
          <small>Outlook.com and Microsoft 365</small>
        </a>
      </div>
      <div class="link">
        <code title={links.https}>{links.https}</code>
        <button class="press" onClick={() => void copy()} aria-label="Copy the calendar link" title="Copy">
          <Icon name="copy" size={16} />
        </button>
      </div>
      <label class="opt">
        <span>
          <b>Include task notes</b>
          <small>Off: calendar apps see only titles and dates</small>
        </span>
        <Switch label="Include task notes" checked={!!c.notes} onChange={(v) => void run(async () => setFeedNotes(v, await driveToken()))} />
      </label>
      <div class="foot">
        <button class="nx-text-btn press" disabled={busy} onClick={() => void run(() => publishFeed(true))}>
          <Icon name="sync" size={15} /> Update now
        </button>
        <button class="nx-text-btn press" disabled={busy} onClick={() => void newLink()}>
          Make a new link
        </button>
      </div>
      <p class="note">
        Open tasks with a deadline or reminder are shown, read-only. Finished tasks drop off. Anyone with the link can see those titles and dates, so keep it private, the same as your calendar's own private link.
      </p>
    </div>
  );
}
