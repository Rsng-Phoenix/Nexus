import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { render } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { addDaysIso, dateToIso, isoToDate, todayIso } from '../calendar/deadline';
import { buildCalendar, type CalItem } from '../calendar/items';
import { calendarSourceLabel, linkedState } from '../calendar/linked';
import { haptic } from '../lib/haptics';
import { settingsSig, subscribeSettings } from '../settings/store';
import { showSnack } from '../state/toasts';
import { runSync, signInMessage } from '../sync/manager';
import * as nav from '../state/nav';
import { activeTasks, addTask, allTasks, byPriority, setChecked } from '../state/store';
import type { Priority, Task } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import { Icon } from './icons';
import { DueBadge } from './Matrix';

/**
 * Mini window: a small, always-on-top Nexus that floats over every other app (Document
 * Picture-in-Picture, Chrome / Edge / Brave 116+ on Mac, Windows, Linux, ChromeOS). It runs in
 * the same page as the full app, so it's always in sync and needs no extra permissions.
 */

type PipApi = { requestWindow: (o: { width: number; height: number }) => Promise<Window>; window: Window | null };
const pipApi = (): PipApi | null => (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture ?? null;

export const miniSupported = () => !!pipApi();
export const miniOpen = signal(false);
let pipWin: Window | null = null;

const SIZE_KEY = 'nexus_mini_size';

function copyStyles(target: Document) {
  for (const n of Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]'))) target.head.appendChild(n.cloneNode(true));
  const root = target.documentElement;
  const src = document.documentElement;
  root.style.cssText = src.style.cssText;
  for (const a of Array.from(src.attributes)) if (a.name.startsWith('data-')) root.setAttribute(a.name, a.value);
  root.lang = src.lang;
}

/** Opens the mini window (must be called from a click or key press). Returns false if unsupported. */
export async function openMiniWindow(): Promise<boolean> {
  const api = pipApi();
  if (!api) return false;
  if (pipWin && !pipWin.closed) {
    pipWin.focus();
    return true;
  }
  let size = { width: 360, height: 560 };
  try {
    size = { ...size, ...JSON.parse(localStorage.getItem(SIZE_KEY) || '{}') };
  } catch {
    /* ignore */
  }
  let win: Window;
  try {
    win = await api.requestWindow(size);
  } catch {
    return false; // e.g. not from a click, or the browser refused
  }
  pipWin = win;
  miniOpen.value = true;
  win.document.title = 'Nexus';
  copyStyles(win.document);
  win.document.body.className = 'nx-mini-body';
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  render(<MiniApp win={win} />, host);
  // Theme / text size changes follow the main window.
  const off = subscribeSettings(() => {
    win.document.documentElement.style.cssText = document.documentElement.style.cssText;
    for (const a of Array.from(document.documentElement.attributes)) if (a.name.startsWith('data-')) win.document.documentElement.setAttribute(a.name, a.value);
  });
  win.addEventListener('pagehide', () => {
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify({ width: win.innerWidth, height: win.innerHeight }));
    } catch {
      /* ignore */
    }
    off();
    render(null, host);
    pipWin = null;
    miniOpen.value = false;
  });
  return true;
}

export function closeMiniWindow(): void {
  pipWin?.close();
}

/** The full app's address (for the desktop widget, which runs as its own page). */
export function fullAppUrl(task?: Task): string {
  const u = new URL('./', location.href);
  if (task) u.searchParams.set('task', task.taskUuid);
  return u.toString();
}

/** Bring the full app forward on [task] (browsers allow focusing the opener from the mini window). */
function openInFull(task?: Task, widget?: boolean) {
  if (widget) {
    window.open(fullAppUrl(task), '_blank', 'noopener');
    return;
  }
  window.focus();
  if (task) {
    if (nav.top.value) nav.closeKind(nav.layers.value[0].kind);
    setTimeout(() => nav.open({ kind: 'detail', taskId: task.id }), 60);
  }
}

type Tab = 'matrix' | 'today' | 'week';
const TABS: [Tab, string][] = [
  ['matrix', 'Matrix'],
  ['today', 'Today'],
  ['week', 'Upcoming']
];

/**
 * The mini window's content. [widget]: running as the desktop widget page (Nexus Desk on Mac /
 * Windows) rather than inside the full app, so "open" launches the full app in the browser.
 */
export function MiniApp({ win, widget = false }: { win: Window; widget?: boolean }) {
  const [tab, setTab] = useState<Tab>(() => {
    const t = localStorage.getItem('nexus_mini_tab') as Tab;
    return TABS.some(([x]) => x === t) ? t : 'matrix';
  });
  const [signingIn, setSigningIn] = useState(false);
  const email = settingsSig.value.googleEmail;
  const [prio, setPrio] = useState<Priority>('HIGH');
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const wide = win.innerWidth >= 520;

  const choose = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem('nexus_mini_tab', t);
    } catch {
      /* ignore */
    }
  };
  const add = () => {
    const v = text.trim();
    if (!v) return;
    setText('');
    haptic('FAB_TAP');
    void addTask(v, prio);
  };

  const open = activeTasks.value.filter((t) => !t.isCompleted && !t.isWontDo && !t.taskUuid.startsWith('nexus-tutorial-'));
  return (
    <div class={`nx-mini ${wide ? 'wide' : ''}`}>
      <header class="nx-mini-head">
        <b>NEXUS</b>
        <nav class="nx-mini-tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} class={tab === id ? 'on' : ''} onClick={() => choose(id)}>
              {label}
            </button>
          ))}
        </nav>
        <span class="grow" />
        <span class="count" title="Open tasks">{open.length}</span>
        {widget && email && (
          <button class="nx-mini-icon" title={`Sync now · ${email}`} aria-label="Sync now" onClick={() => void runSync().then((r) => showSnack(r.message))}>
            <Icon name="sync" size={16} />
          </button>
        )}
        <button class="nx-mini-icon" title="Open the full app" aria-label="Open the full app" onClick={() => openInFull(undefined, widget)}>
          <Icon name="openInFull" size={16} />
        </button>
      </header>
      {widget && !email && (
        <div class="nx-mini-signin">
          <span>Sign in with the same Google account to see the tasks from your other devices here.</span>
          <button
            class="press"
            disabled={signingIn}
            onClick={async () => {
              setSigningIn(true);
              try {
                showSnack(await signInMessage());
              } finally {
                setSigningIn(false);
              }
            }}
          >
            {signingIn ? 'Signing in…' : 'Sign in with Google'}
          </button>
        </div>
      )}
      <form
        class="nx-mini-add"
        style={{ '--c': PRIORITY_META[prio].color } as JSX.CSSProperties}
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          ref={input}
          value={text}
          placeholder={`Add to ${PRIORITY_META[prio].label}…`}
          aria-label="New task"
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Alt+1…4 picks the priority without leaving the field.
            if (e.altKey && /^[1-4]$/.test(e.key)) {
              e.preventDefault();
              setPrio(PRIORITIES[Number(e.key) - 1]);
            }
          }}
        />
        <span class="prios" role="radiogroup" aria-label="Priority">
          {PRIORITIES.map((p, i) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={prio === p}
              title={`${PRIORITY_META[p].label} (Alt+${i + 1})`}
              class={prio === p ? 'on' : ''}
              style={{ '--c': PRIORITY_META[p].color } as JSX.CSSProperties}
              onClick={() => {
                setPrio(p);
                input.current?.focus();
              }}
            />
          ))}
        </span>
      </form>
      <div class="nx-mini-scroll">
        {tab === 'matrix' ? <MiniMatrix widget={widget} /> : tab === 'today' ? <MiniToday widget={widget} /> : <MiniUpcoming widget={widget} />}
      </div>
    </div>
  );
}

function MiniMatrix({ widget }: { widget: boolean }) {
  const groups = byPriority.value;
  return (
    <div class="nx-mini-quads">
      {PRIORITIES.map((p) => {
        const list = groups[p].filter((t) => !t.taskUuid.startsWith('nexus-tutorial-'));
        const openCount = list.filter((t) => !t.isCompleted && !t.isWontDo).length;
        return (
          <section key={p} class="nx-mini-quad" style={{ '--c': PRIORITY_META[p].color } as JSX.CSSProperties}>
            <h3>
              <span class="glyph">{PRIORITY_META[p].glyph}</span>
              {PRIORITY_META[p].label}
              <span class="n">{openCount}</span>
            </h3>
            {list.length === 0 ? <p class="empty">Nothing here</p> : list.slice(0, 30).map((t) => <MiniRow key={t.id} task={t} widget={widget} />)}
          </section>
        );
      })}
    </div>
  );
}

function MiniToday({ widget }: { widget: boolean }) {
  const today = todayIso();
  const items = useMemo(() => {
    const day = buildCalendar(allTasks.value, [], today, today).get(today) ?? [];
    const overdue = activeTasks.value.filter((t) => t.dueDate && t.dueDate < today && !t.isCompleted && !t.isWontDo);
    const seen = new Set<number>();
    const out: Task[] = [];
    for (const t of [...overdue, ...day.flatMap((i) => (i.type === 'event' ? [] : [i.task]))]) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        out.push(t);
      }
    }
    return out;
  }, [allTasks.value, today]);
  if (!items.length)
    return (
      <div class="nx-mini-clear">
        <Icon name="check" size={26} />
        <p>All clear today</p>
        <small>{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</small>
      </div>
    );
  return (
    <div class="nx-mini-list">
      {items.map((t) => (
        <MiniRow key={t.id} task={t} showPriority widget={widget} />
      ))}
    </div>
  );
}

const UPCOMING_DAYS = 14;
const dayHead = (iso: string, today: string) =>
  iso === today
    ? 'Today'
    : iso === addDaysIso(today, 1)
      ? 'Tomorrow'
      : isoToDate(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });

/** The next two weeks, day by day: deadlines, reminders and linked-calendar events. */
function MiniUpcoming({ widget }: { widget: boolean }) {
  const today = todayIso();
  const s = settingsSig.value;
  const days = useMemo(() => {
    const linked = s.linkedCalendars.map((c) => ({ calendar: c, events: linkedState.value[c.id]?.events ?? [] }));
    const map = buildCalendar(allTasks.value, linked, today, addDaysIso(today, UPCOMING_DAYS - 1));
    const out: { iso: string; items: CalItem[] }[] = [];
    for (let i = 0; i < UPCOMING_DAYS; i++) {
      const iso = addDaysIso(today, i);
      const items = (map.get(iso) ?? []).filter((x) => x.type === 'event' || (!x.task.isCompleted && !x.task.isWontDo));
      if (items.length) out.push({ iso, items });
    }
    return out;
  }, [allTasks.value, linkedState.value, s.linkedCalendars, today]);
  if (!days.length)
    return (
      <div class="nx-mini-clear">
        <Icon name="event" size={26} />
        <p>Nothing in the next two weeks</p>
        <small>Deadlines and reminders show up here</small>
      </div>
    );
  return (
    <div class="nx-mini-list">
      {days.map((d) => (
        <section key={d.iso} class="nx-mini-day">
          <h4>{dayHead(d.iso, today)}</h4>
          {d.items.map((i) =>
            i.type === 'event' ? (
              <div key={i.key} class="nx-mini-row event" style={{ '--c': i.calendar.color } as JSX.CSSProperties}>
                <i class="ev" />
                <span class="t" title={calendarSourceLabel(i.calendar)}>
                  {i.event.summary || '(No title)'}
                </span>
                <span class="time">
                  {i.time != null ? new Date(i.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : calendarSourceLabel(i.calendar)}
                </span>
                {i.event.meetingUrl && (
                  <a class="join press" href={i.event.meetingUrl} target="_blank" rel="noopener noreferrer" title={i.event.meetingUrl}>
                    Join
                  </a>
                )}
              </div>
            ) : (
              <MiniRow key={i.key} task={i.task} showPriority widget={widget} />
            )
          )}
        </section>
      ))}
    </div>
  );
}

function MiniRow({ task, showPriority, widget = false }: { task: Task; showPriority?: boolean; widget?: boolean }) {
  const meta = PRIORITY_META[task.priority];
  const done = task.isCompleted || task.isWontDo;
  const time = task.reminderTime != null && dateToIso(new Date(task.reminderTime)) === todayIso() && !task.reminderDateOnly
    ? new Date(task.reminderTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : null;
  return (
    <div class={`nx-mini-row ${done ? 'done' : ''}`} style={{ '--c': meta.color } as JSX.CSSProperties}>
      <button
        class={`cb ${task.isCompleted ? 'on' : ''}`}
        role="checkbox"
        aria-checked={task.isCompleted}
        aria-label={task.isCompleted ? 'Mark not done' : 'Mark done'}
        onClick={() => void setChecked(task, !task.isCompleted)}
      >
        {task.isCompleted && <Icon name="check" size={12} />}
      </button>
      <button class="t" title="Open in Nexus" onClick={() => openInFull(task, widget)}>
        {showPriority && <i class="p" />}
        {task.description}
      </button>
      {time && <span class="time">{time}</span>}
      <DueBadge task={task} />
    </div>
  );
}
