import type { JSX } from 'preact';
import { signal } from '@preact/signals';
import { CLASH_HORIZON_DAYS, type Busy, type Clash } from '../calendar/clashes';
import { dateToIso } from '../calendar/deadline';
import { calendarSourceLabel } from '../calendar/linked';
import { clashes, ignoreClash, unignoreAllClashes, unignoreClash } from '../calendar/radar';
import { haptic } from '../lib/haptics';
import { clashMinLabel, settingsSig } from '../settings/store';
import * as nav from '../state/nav';
import { showSnack } from '../state/toasts';
import type { LayerProps } from './App';
import { Icon } from './icons';
import { PrimaryButton, Sheet } from './kit';

/** Day the calendar should jump to (set by "Open day"; the calendar clears it). */
export const calendarFocusDay = signal<string | null>(null);

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const mins = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
};

/** The animated radar dish: rings, a sweeping beam and one blip per clash. */
export function RadarDish({ count, size = 72 }: { count: number; size?: number }) {
  const blips = Array.from({ length: Math.min(count, 5) }, (_, i) => {
    const a = (i * 137.5 + 40) * (Math.PI / 180);
    const r = 0.22 + ((i * 0.17) % 0.24);
    return { x: 50 + Math.cos(a) * r * 100, y: 50 + Math.sin(a) * r * 100, d: i * 0.35 };
  });
  return (
    <span class={`nx-radar ${count ? 'hot' : 'calm'}`} style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <span class="sweep" />
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="48" />
        <circle cx="50" cy="50" r="32" />
        <circle cx="50" cy="50" r="16" />
        <line x1="50" y1="2" x2="50" y2="98" />
        <line x1="2" y1="50" x2="98" y2="50" />
      </svg>
      {blips.map((b, i) => (
        <i key={i} style={{ left: `${b.x}%`, top: `${b.y}%`, animationDelay: `${b.d}s` }} />
      ))}
    </span>
  );
}

/** Clash radar: every place two meetings from your linked calendars overlap. */
export function ClashSheet(p: LayerProps) {
  const s = settingsSig.value;
  const list = clashes.value;
  const ignored = s.ignoredClashes.length;
  const enabled = s.linkedCalendars.filter((c) => c.enabled).length;

  const openDay = (c: Clash) => {
    calendarFocusDay.value = dateToIso(new Date(c.overlapStart));
    if (!nav.has('calendar')) nav.open({ kind: 'calendar' });
    p.onDismiss();
  };
  const ignore = (c: Clash) => {
    haptic('DRAG_DROP');
    ignoreClash(c.id);
    showSnack('Clash ignored', { label: 'Undo', run: () => unignoreClash(c.id) });
  };

  let lastDay = '';
  return (
    <Sheet leaving={p.leaving} onExited={p.onExited} onDismiss={p.onDismiss} class="nx-clash" maxHeight="94%">
      <div class="nx-clash-body">
        <header class="nx-clash-head">
          <RadarDish count={list.length} />
          <div>
            <h2>Clash radar</h2>
            <p>
              {!s.clashRadar
                ? 'Turned off in Settings → Calendar.'
                : list.length
                  ? `${list.length} clash${list.length === 1 ? '' : 'es'} in the next ${CLASH_HORIZON_DAYS} days`
                  : enabled
                    ? `All clear for the next ${CLASH_HORIZON_DAYS} days`
                    : 'Link a calendar to start scanning'}
            </p>
            {s.clashRadar && enabled > 0 && (
              <small>
                Scanning {s.linkedCalendars.filter((c) => c.enabled).map(calendarSourceLabel).join(', ')} · {clashMinLabel(s.clashMinMinutes).toLowerCase()}
              </small>
            )}
          </div>
        </header>

        {s.clashRadar && enabled === 0 && (
          <PrimaryButton icon="link" onClick={() => nav.replaceTop({ kind: 'calendars' })}>
            Link Google, Zoho, iCloud or Outlook
          </PrimaryButton>
        )}

        {list.length > 0 && (
          <ul class="nx-clash-list">
            {list.map((c, idx) => {
              const day = fmtDay(c.overlapStart);
              const head = day !== lastDay;
              lastDay = day;
              return (
                <li key={c.id} style={{ animationDelay: `${Math.min(idx, 8) * 40}ms` }}>
                  {head && <h3>{dateToIso(new Date(c.overlapStart)) === dateToIso(new Date()) ? 'Today' : day}</h3>}
                  <ClashCard c={c} onOpen={() => openDay(c)} onIgnore={() => ignore(c)} />
                </li>
              );
            })}
          </ul>
        )}

        {s.clashRadar && list.length === 0 && enabled > 0 && (
          <p class="nx-clash-clear">No meetings overlap. Nexus checks again every time your calendars refresh.</p>
        )}

        {ignored > 0 && (
          <button class="nx-text-btn press nx-clash-ignored" onClick={() => unignoreAllClashes()}>
            Show {ignored} ignored clash{ignored === 1 ? '' : 'es'} again
          </button>
        )}
      </div>
    </Sheet>
  );
}

function ClashCard({ c, onOpen, onIgnore }: { c: Clash; onOpen: () => void; onIgnore: () => void }) {
  const from = Math.min(c.a.start, c.b.start);
  const to = Math.max(c.a.end, c.b.end);
  const span = Math.max(1, to - from);
  const pct = (ms: number) => `${((ms - from) / span) * 100}%`;
  const bar = (b: Busy) => ({ left: pct(b.start), width: `${((b.end - b.start) / span) * 100}%`, '--c': b.calendar.color }) as JSX.CSSProperties;
  return (
    <div class="nx-clash-card">
      <div class="nx-clash-line" aria-hidden="true">
        <span class="overlap" style={{ left: pct(c.overlapStart), width: `${((c.overlapEnd - c.overlapStart) / span) * 100}%` }} />
        <span class="bar" style={bar(c.a)} />
        <span class="bar two" style={bar(c.b)} />
        <em class="t0">{fmtTime(from)}</em>
        <em class="t1">{fmtTime(to)}</em>
      </div>
      <Side b={c.a} />
      <Side b={c.b} />
      <footer>
        <span class="pill">
          <Icon name="warning" size={13} />
          {mins(c.overlapEnd - c.overlapStart)} overlap
        </span>
        <span class="grow" />
        <button class="nx-text-btn press" onClick={onIgnore}>Ignore</button>
        <button class="nx-text-btn press" onClick={onOpen}>Open day</button>
      </footer>
    </div>
  );
}

function Side({ b }: { b: Busy }) {
  const src = [calendarSourceLabel(b.calendar), ...b.alsoIn].join(' + ');
  return (
    <div class="nx-clash-side" style={{ '--c': b.calendar.color } as JSX.CSSProperties}>
      <i />
      <span class="txt">
        <b>{b.title}</b>
        <small>
          {fmtTime(b.start)} – {fmtTime(b.end)} · {src}
        </small>
      </span>
      {b.event.meetingUrl && (
        <a class="nx-cal-join press" href={b.event.meetingUrl} target="_blank" rel="noopener noreferrer">
          <Icon name="video" size={15} />
          Join
        </a>
      )}
    </div>
  );
}
