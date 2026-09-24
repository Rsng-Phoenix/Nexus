import { useEffect, useState } from 'preact/hooks';
import {
  addLinkedCalendar,
  CALENDAR_COLORS,
  calendarProvider,
  linkedState,
  normaliseCalendarUrl,
  refreshLinked,
  removeLinkedCalendar,
  updateLinkedCalendar
} from '../calendar/linked';
import { enableNotifications, workerAuth } from '../reminders/push';
import { refreshLabel, settingsSig } from '../settings/store';
import { showSnack } from '../state/toasts';
import type { LayerProps } from './App';
import { Icon } from './icons';
import { IconButton, PrimaryButton, Sheet, Switch } from './kit';

const HOW_TO: { name: string; steps: string }[] = [
  { name: 'Google Calendar', steps: 'calendar.google.com → Settings → pick your calendar → Integrate calendar → copy “Secret address in iCal format”.' },
  { name: 'Apple iCloud', steps: 'Calendar app → the calendar’s share button → turn on Public Calendar → copy the link (webcal://…).' },
  { name: 'Zoho Calendar', steps: 'Settings → My Calendars → the calendar → Export / Share → copy the private ICS URL.' },
  { name: 'Outlook', steps: 'outlook.com → Settings → Calendar → Shared calendars → Publish a calendar → copy the ICS link.' }
];

const ago = (ms: number) => {
  if (!ms) return 'not loaded yet';
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return 'updated just now';
  if (m < 60) return `updated ${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `updated ${h} h ago` : `updated ${Math.round(h / 24)} d ago`;
};

/** Read-only calendars from Google / iCloud / Zoho / Outlook shown inside the Nexus calendar. */
export function LinkedCalendarsSheet(p: LayerProps) {
  const cals = settingsSig.value.linkedCalendars;
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    void workerAuth().then((a) => setRegistered(!!a));
    void refreshLinked();
  }, []);

  const add = () => {
    const clean = normaliseCalendarUrl(url);
    if (!clean) {
      setErr('Paste the full https:// or webcal:// link from your calendar app.');
      return;
    }
    if (cals.some((c) => c.url === clean)) {
      setErr('That calendar is already linked.');
      return;
    }
    addLinkedCalendar(name || calendarProvider(clean).label, clean);
    setName('');
    setUrl('');
    setErr('');
    showSnack('Calendar linked');
  };

  return (
    <Sheet leaving={p.leaving} onExited={p.onExited} onDismiss={p.onDismiss} class="nx-linked" maxHeight="94%">
      <div class="nx-linked-body">
        <h2>Linked calendars</h2>
        <p class="lead">
          See your Google, iCloud, Zoho or Outlook events next to your tasks, each labelled with where it came from. Nexus reads the calendar's
          private iCal link — the same way Apple Calendar and Outlook subscribe to calendars. Nexus checks it every{' '}
          {refreshLabel(settingsSig.value.calendarRefreshMinutes)} and whenever you open it; meeting links get a Join button. Read-only: Nexus never
          changes your events. The link stays on this device.
        </p>

        {registered === false && (
          <div class="nx-linked-note">
            <Icon name="bell" size={18} />
            <span>Linked calendars are fetched through the Nexus relay, which needs notifications turned on for this device.</span>
            <button
              class="nx-text-btn press"
              onClick={async () => {
                const r = await enableNotifications();
                setRegistered(r === 'on');
                if (r !== 'on') showSnack(r === 'denied' ? 'Notifications are blocked in your browser settings' : 'Could not turn on notifications');
                else void refreshLinked(true);
              }}
            >
              Turn on
            </button>
          </div>
        )}

        {cals.length > 0 && (
          <ul class="nx-linked-list">
            {cals.map((c) => {
              const st = linkedState.value[c.id];
              return (
                <li key={c.id}>
                  <button
                    class="swatch press"
                    style={{ background: c.color }}
                    aria-label="Change colour"
                    onClick={() => updateLinkedCalendar(c.id, { color: CALENDAR_COLORS[(CALENDAR_COLORS.indexOf(c.color) + 1) % CALENDAR_COLORS.length] })}
                  />
                  <span class="txt">
                    <b>
                      {c.name}
                      <em class="prov">{calendarProvider(c.url).label}</em>
                    </b>
                    <small class={st?.error ? 'err' : ''}>
                      {st?.loading ? 'Loading…' : st?.error ?? `${st?.events.length ?? 0} events · ${ago(st?.fetchedAt ?? 0)}`}
                    </small>
                  </span>
                  <Switch checked={c.enabled} label={`Show ${c.name}`} onChange={(v) => updateLinkedCalendar(c.id, { enabled: v })} />
                  <IconButton icon="delete" label={`Remove ${c.name}`} size={20} onClick={() => void removeLinkedCalendar(c.id)} />
                </li>
              );
            })}
          </ul>
        )}

        <div class="nx-linked-form">
          <input class="nx-input" placeholder={`Name (e.g. Work)${url && normaliseCalendarUrl(url) ? ` · ${calendarProvider(normaliseCalendarUrl(url)!).label} calendar` : ''}`} value={name} maxLength={40} onInput={(e) => setName(e.currentTarget.value)} />
          <input
            class="nx-input"
            placeholder="Private iCal link (https:// or webcal://)"
            value={url}
            inputMode="url"
            autoComplete="off"
            spellcheck={false}
            onInput={(e) => {
              setUrl(e.currentTarget.value);
              setErr('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          {err && <p class="err">{err}</p>}
          <PrimaryButton icon="link" onClick={add} disabled={!url.trim()}>
            Link calendar
          </PrimaryButton>
        </div>

        <button class="nx-linked-help-toggle press" onClick={() => setHelp(!help)} aria-expanded={help}>
          Where do I find the link?
          <Icon name="expandMore" size={18} style={{ transform: help ? 'rotate(180deg)' : 'none' }} />
        </button>
        {help && (
          <dl class="nx-linked-help">
            {HOW_TO.map((h) => (
              <div key={h.name}>
                <dt>{h.name}</dt>
                <dd>{h.steps}</dd>
              </div>
            ))}
            <p>Treat that link like a password: anyone with it can see that calendar. To stop sharing, reset the link in your calendar app.</p>
          </dl>
        )}
      </div>
    </Sheet>
  );
}
