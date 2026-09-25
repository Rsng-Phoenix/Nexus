import '../styles/mini.css';
import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { addDaysIso, dateToIso, isoToDate, todayIso } from '../calendar/deadline';
import { buildCalendar, monthGrid } from '../calendar/items';
import { clashesByDay } from '../calendar/clashes';
import { clashes } from '../calendar/radar';
import { fromStorage, toStorage } from '../notes/codec';
import { nexusLogoHtml } from '../ui/nexus-logo';
import { calendarSourceLabel, linkedState } from '../calendar/linked';
import { haptic } from '../lib/haptics';
import { settingsSig, subscribeSettings } from '../settings/store';
import { showSnack } from '../state/toasts';
import { runSync, signInMessage } from '../sync/manager';
import * as nav from '../state/nav';
import { activeTasks, addTask, allTasks, byPriority, moveToPriority, setChecked, togglePin, updateTask } from '../state/store';
import type { Priority, Task } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import { Icon, type IconName } from './icons';
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


type Tab = 'matrix' | 'today' | 'calendar';
const TABS: [Tab, string, IconName][] = [
  ['matrix', 'Matrix', 'widgets'],
  ['today', 'Today', 'checklist'],
  ['calendar', 'Calendar', 'calendar']
];
const isTab = (t: unknown): t is Tab => TABS.some(([x]) => x === t);

/** The task as it is right now: quick edits in a row (rename, then move) must not undo each other. */
const fresh = (t: Task): Task => allTasks.value.find((x) => x.id === t.id) ?? t;

/** Which task is open in place (one at a time). */
const openTask = signal<number | null>(null);

/**
 * The mini window's content. [widget]: running as the desktop widget page (Nexus Desk on Mac /
 * Windows) rather than inside the full app, so "open" launches the full app in the browser.
 * [only]: a Desk window dedicated to one view (e.g. a separate calendar window); no tabs.
 */
export function MiniApp({ win, widget = false, only }: { win: Window; widget?: boolean; only?: Tab }) {
  const [tab, setTab] = useState<Tab>(() => {
    if (only) return only;
    const t = localStorage.getItem('nexus_mini_tab');
    return isTab(t) ? t : 'matrix';
  });
  const [signingIn, setSigningIn] = useState(false);
  const email = settingsSig.value.googleEmail;
  const [prio, setPrio] = useState<Priority>('HIGH');
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // Nexus Desk's shortcut from any app (⌃⌥N on Mac) lands here, ready to type.
  useEffect(() => {
    // Only when this is the whole page (Nexus Desk / widget), never the mini window beside the matrix.
    if (!widget) return;
    const w = window as Window & { __nexusQuickAdd?: () => void };
    w.__nexusQuickAdd = () => {
      input.current?.focus();
      input.current?.select();
    };
    // N (or Enter) anywhere in the window starts a task, like on the full matrix. Nexus Desk for
    // Windows sends an "n" after Ctrl+Alt+N.
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target;
      if (t instanceof Element && t.closest('input, textarea, select, button, a, [contenteditable="true"], [role="dialog"]')) return;
      if (e.key !== 'n' && e.key !== 'N' && e.key !== 'Enter') return;
      e.preventDefault();
      w.__nexusQuickAdd?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      delete w.__nexusQuickAdd;
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const choose = (t: Tab) => {
    if (t === tab) return;
    haptic('DRAG_TICK');
    openTask.value = null;
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
    <div class="nx-mini">
      <header class="nx-mini-head">
        <span class="brand" aria-label="Nexus">
          <span class="mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: nexusLogoHtml(18) }} />
          <b>NEXUS</b>
        </span>
        {only ? (
          <span class="only">{TABS.find(([x]) => x === only)?.[1]}</span>
        ) : (
          <nav class="nx-mini-tabs" role="tablist" style={{ '--i': String(TABS.findIndex(([x]) => x === tab)) } as JSX.CSSProperties}>
            <span class="pill" aria-hidden="true" />
            {TABS.map(([id, label, icon]) => (
              <button key={id} role="tab" aria-selected={tab === id} title={label} class={tab === id ? 'on' : ''} onClick={() => choose(id)}>
                <Icon name={icon} size={14} />
                <span class="lbl">{label}</span>
              </button>
            ))}
          </nav>
        )}
        <span class="grow" />
        <span class="count" title={`${open.length} open tasks`} key={open.length}>
          {open.length}
        </span>
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
      {tab !== 'calendar' && (
        <form
          class="nx-mini-add"
          style={{ '--c': PRIORITY_META[prio].color } as JSX.CSSProperties}
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Icon name="add" size={16} class="plus" />
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
      )}
      <div class="nx-mini-scroll" key={tab}>
        {tab === 'matrix' ? <MiniMatrix widget={widget} /> : tab === 'today' ? <MiniToday widget={widget} /> : <MiniCalendar widget={widget} />}
      </div>
    </div>
  );
}

function MiniMatrix({ widget }: { widget: boolean }) {
  const groups = byPriority.value;
  return (
    <div class="nx-mini-quads">
      {PRIORITIES.map((p, qi) => {
        const list = groups[p].filter((t) => !t.taskUuid.startsWith('nexus-tutorial-'));
        const openCount = list.filter((t) => !t.isCompleted && !t.isWontDo).length;
        return (
          <section key={p} class="nx-mini-quad" style={{ '--c': PRIORITY_META[p].color, '--q': String(qi) } as JSX.CSSProperties}>
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
        <span class="ok"><Icon name="check" size={22} /></span>
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

const WEEKDAY_1 = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** A small month with dots (tasks in their priority colour, events in their calendar's) and the chosen day below. */
function MiniCalendar({ widget }: { widget: boolean }) {
  const today = todayIso();
  const s = settingsSig.value;
  const [sel, setSel] = useState(today);
  const [ym, setYm] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() }));
  const [dir, setDir] = useState(0);
  const days = useMemo(() => monthGrid(ym.y, ym.m, s.weekStart), [ym.y, ym.m, s.weekStart]);
  const items = useMemo(() => {
    const linked = s.linkedCalendars.map((c) => ({ calendar: c, events: linkedState.value[c.id]?.events ?? [] }));
    return buildCalendar(allTasks.value, linked, days[0], days[days.length - 1]);
  }, [allTasks.value, linkedState.value, s.linkedCalendars, days]);
  const clashDays = useMemo(() => clashesByDay(clashes.value), [clashes.value]);
  const clashKeys = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of clashes.value) {
      m.set(`${c.a.event.uid}|${c.a.start}`, c.b.title);
      m.set(`${c.b.event.uid}|${c.b.start}`, c.a.title);
    }
    return m;
  }, [clashes.value]);
  const shift = (d: number) => {
    haptic('DRAG_TICK');
    setDir(d);
    setYm(({ y, m }) => {
      const n = new Date(y, m + d, 1);
      return { y: n.getFullYear(), m: n.getMonth() };
    });
  };
  const weekdays = [...WEEKDAY_1.slice(s.weekStart), ...WEEKDAY_1.slice(0, s.weekStart)];
  const list = (items.get(sel) ?? []).filter((x) => x.type === 'event' || !x.task.isWontDo);
  const label = new Date(ym.y, ym.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return (
    <div class="nx-mini-cal">
      <div class="bar">
        <b>{label}</b>
        <span class="grow" />
        {(sel !== today || ym.m !== new Date().getMonth()) && (
          <button
            class="today press"
            onClick={() => {
              setDir(0);
              setYm({ y: new Date().getFullYear(), m: new Date().getMonth() });
              setSel(today);
            }}
          >
            Today
          </button>
        )}
        <button class="nx-mini-icon" aria-label="Previous month" onClick={() => shift(-1)}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <button class="nx-mini-icon" aria-label="Next month" onClick={() => shift(1)}>
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
      <div class="wk" aria-hidden="true">
        {weekdays.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div class={`grid ${dir < 0 ? 'from-left' : dir > 0 ? 'from-right' : ''}`} key={`${ym.y}-${ym.m}`} role="grid" aria-label={label}>
        {days.map((iso) => {
          const d = isoToDate(iso);
          const l = items.get(iso) ?? [];
          const clash = clashDays.has(iso);
          return (
            <button
              key={iso}
              role="gridcell"
              aria-selected={iso === sel}
              class={`d ${d.getMonth() !== ym.m ? 'other' : ''} ${iso === today ? 'today' : ''} ${iso === sel ? 'sel' : ''}`}
              onClick={() => {
                setSel(iso);
                openTask.value = null;
              }}
            >
              <span class="n">{d.getDate()}</span>
              {clash && <i class="clash" />}
              <span class="dots">
                {l.slice(0, 3).map((x) => (
                  <i key={x.key} style={{ background: x.type === 'event' ? x.calendar.color : PRIORITY_META[x.task.priority].color }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <h4 class="agenda-head">{dayHead(sel, today)}</h4>
      {list.length === 0 ? (
        <p class="nothing">Nothing planned</p>
      ) : (
        <div class="nx-mini-list" key={sel}>
          {list.map((i) =>
            i.type === 'event' ? (
              <div key={i.key} class={`nx-mini-row event ${i.time != null && clashKeys.has(`${i.event.uid}|${i.time}`) ? 'clashing' : ''}`} style={{ '--c': i.calendar.color } as JSX.CSSProperties}>
                <i class="ev" />
                <span class="t" title={calendarSourceLabel(i.calendar)}>
                  {i.event.summary || '(No title)'}
                  {i.time != null && clashKeys.has(`${i.event.uid}|${i.time}`) && <em class="cl">Clashes with {clashKeys.get(`${i.event.uid}|${i.time}`)}</em>}
                </span>
                <span class="time">{i.time != null ? fmtTime(i.time) : calendarSourceLabel(i.calendar)}</span>
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
        </div>
      )}
    </div>
  );
}

const dayHead = (iso: string, today: string) =>
  iso === today
    ? 'Today'
    : iso === addDaysIso(today, 1)
      ? 'Tomorrow'
      : isoToDate(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });

function MiniRow({ task, showPriority, widget = false }: { task: Task; showPriority?: boolean; widget?: boolean }) {
  const meta = PRIORITY_META[task.priority];
  const done = task.isCompleted || task.isWontDo;
  const expanded = openTask.value === task.id;
  const time = task.reminderTime != null && dateToIso(new Date(task.reminderTime)) === todayIso() && !task.reminderDateOnly ? fmtTime(task.reminderTime) : null;
  return (
    <div class={`nx-mini-row ${done ? 'done' : ''} ${expanded ? 'open' : ''}`} style={{ '--c': meta.color } as JSX.CSSProperties}>
      <div class="line">
        <button
          class={`cb ${task.isCompleted ? 'on' : ''}`}
          role="checkbox"
          aria-checked={task.isCompleted}
          aria-label={task.isCompleted ? 'Mark not done' : 'Mark done'}
          onClick={() => {
            haptic('CHECK');
            void setChecked(fresh(task), !fresh(task).isCompleted);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
        </button>
        {expanded ? (
          <>
            <RenameField task={task} />
            <button class="close" aria-label="Close" title="Close (Esc)" onClick={() => (openTask.value = null)}>
              <Icon name="expandMore" size={16} />
            </button>
          </>
        ) : (
          <>
            <button class="t" aria-expanded={false} title="Show details" onClick={() => (openTask.value = task.id)}>
              {showPriority && <i class="p" />}
              <span>{task.description}</span>
            </button>
            {time && <span class="time">{time}</span>}
            <DueBadge task={task} />
          </>
        )}
      </div>
      <div class="peek" aria-hidden={!expanded}>
        <div>{expanded && <TaskPeek task={task} widget={widget} />}</div>
      </div>
    </div>
  );
}

const DUE_QUICK: [string, (today: string) => string][] = [
  ['Today', (t) => t],
  ['Tomorrow', (t) => addDaysIso(t, 1)],
  ['Next week', (t) => addDaysIso(t, 7)]
];

/** The open task's title, editable in place: Enter or clicking away saves, Esc undoes. */
function RenameField({ task }: { task: Task }) {
  const [title, setTitle] = useState(task.description);
  const save = (typed: string) => {
    const v = typed.trim();
    if (!v || v === task.description) return setTitle(task.description);
    haptic('CHECK');
    void updateTask({ ...fresh(task), description: v });
  };
  return (
    <input
      class="rename"
      value={title}
      aria-label="Task title"
      title="Rename: type, then Enter"
      onInput={(e) => setTitle(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setTitle(task.description);
          openTask.value = null;
        }
      }}
      onBlur={(e) => save(e.currentTarget.value)}
    />
  );
}

/** A task opened in place: tick checklist items, move it, set a deadline. */
function TaskPeek({ task, widget }: { task: Task; widget: boolean }) {
  const blocks = useMemo(() => fromStorage(task.notes ?? ''), [task.notes]);
  const hasNotes = blocks.some((b) => b.text.trim());
  const toggleItem = (id: string) => {
    haptic('CHECK');
    const cur = fresh(task);
    const next = fromStorage(cur.notes ?? '').map((b) => (b.id === id ? { ...b, checked: !b.checked } : b));
    void updateTask({ ...cur, notes: toStorage(next) });
  };
  const setDue = (iso: string) => {
    haptic('DRAG_TICK');
    void updateTask({ ...fresh(task), dueDate: iso });
  };
  let n = 0;
  return (
    <div class="nx-mini-peek">
      {hasNotes ? (
        <div class="notes">
          {blocks.map((b) => {
            if (!b.text.trim() && b.type !== 'CHECKBOX') return null;
            n = b.type === 'NUMBERED' ? n + 1 : 0;
            const pad = { paddingLeft: `${b.indent * 12}px` };
            if (b.type === 'CHECKBOX')
              return (
                <button key={b.id} class={`item ${b.checked ? 'on' : ''}`} style={pad} onClick={() => toggleItem(b.id)}>
                  <span class="box">{b.checked && <Icon name="check" size={10} />}</span>
                  <span>{b.text || ' '}</span>
                </button>
              );
            return (
              <p key={b.id} class={b.type.toLowerCase()} style={pad}>
                {b.type === 'BULLET' ? '• ' : b.type === 'NUMBERED' ? `${n}. ` : ''}
                {b.text}
              </p>
            );
          })}
        </div>
      ) : (
        <p class="no-notes">No notes</p>
      )}
      <div class="row">
        <span class="lbl">Move</span>
        <span class="prios">
          {PRIORITIES.map((p) => (
            <button
              key={p}
              class={task.priority === p ? 'on' : ''}
              title={PRIORITY_META[p].label}
              aria-label={`Move to ${PRIORITY_META[p].label}`}
              style={{ '--c': PRIORITY_META[p].color } as JSX.CSSProperties}
              onClick={() => {
                if (task.priority === p) return;
                haptic('DRAG_DROP');
                void moveToPriority(fresh(task), p);
              }}
            >
              {PRIORITY_META[p].glyph}
            </button>
          ))}
        </span>
      </div>
      <div class="row">
        <span class="lbl">Due</span>
        <span class="chips">
          {DUE_QUICK.map(([label, f]) => {
            const iso = f(todayIso());
            return (
              <button key={label} class={task.dueDate === iso ? 'on' : ''} onClick={() => setDue(iso)}>
                {label}
              </button>
            );
          })}
          {task.dueDate && (
            <button class="clear" aria-label="Remove the deadline" onClick={() => setDue('')}>
              <Icon name="close" size={11} />
            </button>
          )}
        </span>
      </div>
      <div class="actions">
        <button class="press" onClick={() => void togglePin(fresh(task))}>
          <Icon name="pin" size={14} /> {task.isPinned ? 'Unpin' : 'Pin'}
        </button>
        <button class="press" onClick={() => openInFull(task, widget)}>
          <Icon name="edit" size={14} /> Edit notes in Nexus
        </button>
      </div>
    </div>
  );
}
