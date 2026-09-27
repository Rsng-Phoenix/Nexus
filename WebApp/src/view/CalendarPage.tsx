import '../styles/calendar.css';
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { dateToIso, isoToDate, todayIso } from '../calendar/deadline';
import { buildCalendar, monthGrid, type CalItem } from '../calendar/items';
import { calendarSourceLabel, linkedState, linkedUpdatedAt, refreshLinked, refreshLinkedOnOpen, updateLinkedCalendar } from '../calendar/linked';
import { haptic } from '../lib/haptics';
import { settingsSig } from '../settings/store';
import * as nav from '../state/nav';
import { allTasks, setChecked, updateTask } from '../state/store';
import { showSnack } from '../state/toasts';
import { activePrompt } from '../state/prompts';
import { isWide } from '../state/viewport';
import { PRIORITY_META } from '../types';
import type { LayerProps } from './App';
import { downloadIcs } from './addToCalendar';
import { CLASH_HORIZON_DAYS, clashesByDay, type Clash } from '../calendar/clashes';
import { clashes } from '../calendar/radar';
import { calendarFocusDay, RadarDish } from './ClashSheet';
import { Icon } from './icons';
import { Checkbox, IconButton, Menu, Page, PageHeader } from './kit';
import { play, SPRING_MOVE } from './motion';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDayHead = (iso: string) => isoToDate(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

/** Calendar: deadlines, reminder days and linked calendars, month by month. */
export function CalendarPage(p: LayerProps) {
  const s = settingsSig.value;
  const wide = isWide.value;
  const today = todayIso();
  const [sel, setSel] = useState(today);
  const [ym, setYm] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() }));
  const gridRef = useRef<HTMLDivElement>(null);
  const dir = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => void refreshLinkedOnOpen(), []);
  // "Open day" from Clash radar (or anywhere else) jumps here.
  const focus = calendarFocusDay.value;
  useEffect(() => {
    if (!focus) return;
    calendarFocusDay.value = null;
    selectDay(focus);
  }, [focus]);
  // Keeps "Updated 3 min ago" honest while the page stays open.
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const days = useMemo(() => monthGrid(ym.y, ym.m, s.weekStart), [ym.y, ym.m, s.weekStart]);
  const linked = s.linkedCalendars.map((c) => ({ calendar: c, events: linkedState.value[c.id]?.events ?? [] }));
  const items = useMemo(
    () => buildCalendar(allTasks.value, linked, days[0], days[days.length - 1]),
    [allTasks.value, linkedState.value, s.linkedCalendars, days]
  );
  const monthLabel = new Date(ym.y, ym.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const shiftMonth = (d: number) => {
    dir.current = d;
    haptic('DRAG_TICK');
    setYm(({ y, m }) => {
      const n = new Date(y, m + d, 1);
      return { y: n.getFullYear(), m: n.getMonth() };
    });
  };
  const goToday = () => {
    const n = new Date();
    dir.current = 0;
    setYm({ y: n.getFullYear(), m: n.getMonth() });
    setSel(today);
  };
  const selectDay = (iso: string) => {
    setSel(iso);
    const d = isoToDate(iso);
    if (d.getMonth() !== ym.m || d.getFullYear() !== ym.y) {
      dir.current = iso > sel ? 1 : -1;
      setYm({ y: d.getFullYear(), m: d.getMonth() });
    }
  };

  useLayoutEffect(() => {
    if (!dir.current) return;
    // Month swipe: the grid springs in from the side it came from; a quick second swipe restarts it.
    play(gridRef.current, [{ opacity: 0, transform: `translateX(${dir.current * 24}px)` }, { opacity: 1, transform: 'none' }], SPRING_MOVE, 'month');
    dir.current = 0;
  }, [ym.y, ym.m]);

  // Keyboard: arrows move the day, PageUp/PageDown the month, T today, N new task that day.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (nav.top.value?.kind !== 'calendar' || activePrompt.value || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof Element && t.closest('input, textarea, [contenteditable="true"], [role="menu"], [role="menuitem"]')) return;
      // Buttons keep their own Enter / Space / arrows (Today, month arrows, Add, Make task…).
      if (t instanceof Element && t.closest('button, a, select') && (e.key === 'Enter' || e.key === ' ')) return;
      if (e.repeat && (e.key === 'Enter' || e.key === 'n' || e.key === 'N')) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (step) {
        e.preventDefault();
        const d = isoToDate(sel);
        d.setDate(d.getDate() + step);
        selectDay(dateToIso(d));
      } else if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        shiftMonth(e.key === 'PageUp' ? -1 : 1);
      } else if (e.key === 't' || e.key === 'T') goToday();
      else if (e.key === 'n' || e.key === 'N' || e.key === 'Enter') {
        e.preventDefault();
        addOn(sel);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Phone: swipe the grid sideways to change month.
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const swipeHandlers = {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    },
    onPointerUp: (e: PointerEvent) => {
      const st = swipe.current;
      swipe.current = null;
      if (!st || st.id !== e.pointerId) return;
      const dx = e.clientX - st.x;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - st.y) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
    }
  };

  const addOn = (iso: string) => nav.open({ kind: 'add', priority: 'HIGH', due: iso });

  const exportAll = () => {
    downloadIcs(allTasks.value.filter((t) => t.deletedAt === 0));
    showSnack('Exported · open the .ics file to add it to Apple, Google or Outlook Calendar', undefined, 5000);
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (/\.ics$/i.test(f.name) || f.type === 'text/calendar') {
      if (f.size > 5 * 1024 * 1024) return showSnack('That calendar file is over 5 MB');
      nav.open({ kind: 'icsImport', fileName: f.name, text: await f.text() });
    } else nav.open({ kind: 'sheetImport', file: f });
  };

  // Desktop drag & drop: move a deadline to another day.
  const drop = (iso: string, e: DragEvent) => {
    const uuid = e.dataTransfer?.getData('text/nexus-task');
    const t = allTasks.value.find((x) => x.taskUuid === uuid);
    if (!t || t.dueDate === iso) return;
    haptic('DRAG_DROP');
    void updateTask({ ...t, dueDate: iso });
    showSnack(`Moved to ${fmtDayHead(iso)}`);
  };

  // Only once a calendar has actually loaded: "all clear" must mean checked, not unknown.
  const radarOn = s.clashRadar && s.linkedCalendars.some((c) => c.enabled && (linkedState.value[c.id]?.fetchedAt ?? 0) > 0);
  const clashList = radarOn ? clashes.value : [];
  const clashDays = useMemo(() => clashesByDay(clashList), [clashList]);
  // Meeting occurrence → the meetings it clashes with, for the tags in the day list.
  const clashWith = useMemo(() => {
    const m = new Map<string, Clash[]>();
    for (const c of clashList) {
      for (const b of [c.a, c.b]) {
        const k = `${b.event.uid}|${b.start}`;
        m.set(k, [...(m.get(k) ?? []), c]);
      }
    }
    return m;
  }, [clashList]);

  const weekdays = [...WEEKDAYS.slice(s.weekStart), ...WEEKDAYS.slice(0, s.weekStart)];
  const selItems = items.get(sel) ?? [];
  const syncing = s.linkedCalendars.some((c) => linkedState.value[c.id]?.loading);

  return (
    <Page leaving={p.leaving} onExited={p.onExited} onDismiss={p.onDismiss} class={`nx-cal ${wide ? 'wide' : ''}`}>
      <PageHeader
        title={monthLabel}
        subtitle={syncing ? 'Updating…' : s.linkedCalendars.some((c) => c.enabled) ? updatedLabel(linkedUpdatedAt()) : undefined}
        onBack={p.onDismiss}
        trailing={
          <div class="nx-cal-tools">
            <button class="nx-cal-today press" onClick={goToday}>Today</button>
            <IconButton icon="chevronLeft" label="Previous month" onClick={() => shiftMonth(-1)} />
            <IconButton icon="chevronRight" label="Next month" onClick={() => shiftMonth(1)} />
            <Menu
              trigger={(toggle) => <IconButton icon="moreVert" label="Calendar options" onClick={toggle} />}
              items={[
                { label: 'Import .ics / Excel / CSV', icon: 'upload', onSelect: () => fileInput.current?.click() },
                { label: 'Show in Google, Apple or Outlook (live)', icon: 'event', onSelect: () => nav.open({ kind: 'settings', cat: 'calendar' }) },
                { label: 'Export a copy (.ics file)', icon: 'download', onSelect: exportAll },
                'divider',
                { label: 'Linked calendars', icon: 'link', onSelect: () => nav.open({ kind: 'calendars' }) },
                ...(s.linkedCalendars.length ? [{ label: 'Refresh linked calendars', icon: 'sync' as const, onSelect: () => void refreshLinked(true) }] : [])
              ]}
            />
          </div>
        }
      />
      <input
        ref={fileInput}
        type="file"
        hidden
        accept=".ics,.xlsx,.csv,.tsv,text/calendar,text/csv"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          void onFile(f);
        }}
      />
      {radarOn && <RadarBar list={clashList} />}
      <div class="nx-cal-body">
        <section class="nx-cal-month" {...swipeHandlers}>
          <div class="nx-cal-week" aria-hidden="true">
            {weekdays.map((w) => <span key={w}>{w}</span>)}
          </div>
          <div ref={gridRef} class="nx-cal-grid" role="grid" aria-label={monthLabel}>
            {days.map((iso) => {
              const list = items.get(iso) ?? [];
              const d = isoToDate(iso);
              const other = d.getMonth() !== ym.m;
              const late = list.some((i) => i.type === 'due' && i.late);
              const clash = clashDays.get(iso)?.length ?? 0;
              return (
                <div
                  key={iso}
                  role="gridcell"
                  tabIndex={iso === sel ? 0 : -1}
                  aria-selected={iso === sel}
                  aria-label={`${fmtDayHead(iso)}, ${list.length} item${list.length === 1 ? '' : 's'}${clash ? `, ${clash} clash${clash === 1 ? '' : 'es'}` : ''}`}
                  class={`nx-cal-day ${other ? 'other' : ''} ${iso === today ? 'today' : ''} ${iso === sel ? 'sel' : ''} ${late ? 'late' : ''} ${clash ? 'clash' : ''}`}
                  onClick={() => selectDay(iso)}
                  onDblClick={() => addOn(iso)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).classList.add('drop');
                  }}
                  onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove('drop')}
                  onDrop={(e) => {
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).classList.remove('drop');
                    drop(iso, e);
                  }}
                >
                  <span class="num">{d.getDate()}</span>
                  {clash > 0 && <span class="clash-mark" title={`${clash} clash${clash === 1 ? '' : 'es'}`} />}
                  {wide ? <CellChips list={list} /> : <CellDots list={list} />}
                </div>
              );
            })}
          </div>
          <div class="nx-cal-legend" aria-label="Where items come from">
            <span class="src nexus" title="Your Nexus tasks: deadlines and reminders">
              <i />
              Nexus tasks
            </span>
            {s.linkedCalendars.map((c) => {
              const err = linkedState.value[c.id]?.error;
              return (
                <button
                  key={c.id}
                  class={`src press ${c.enabled ? '' : 'off'}`}
                  aria-pressed={c.enabled}
                  title={err ?? `${c.enabled ? 'Hide' : 'Show'} ${calendarSourceLabel(c)}`}
                  onClick={() => updateLinkedCalendar(c.id, { enabled: !c.enabled })}
                >
                  <i style={{ background: c.color }} />
                  {calendarSourceLabel(c)}
                  {err && <b> !</b>}
                </button>
              );
            })}
            <button class="src link press" onClick={() => nav.open({ kind: 'calendars' })}>
              <Icon name={s.linkedCalendars.length ? 'settings' : 'link'} size={12} />
              {s.linkedCalendars.length ? 'Manage' : 'Link Google, iCloud, Zoho or Outlook'}
            </button>
          </div>
        </section>
        <section class="nx-cal-agenda" aria-live="polite">
          <header>
            <div>
              <h2>{sel === today ? 'Today' : fmtDayHead(sel)}</h2>
              <p>{sel === today ? fmtDayHead(sel) : selItems.length ? `${selItems.length} item${selItems.length === 1 ? '' : 's'}` : 'Nothing planned'}</p>
            </div>
            <button class="nx-cal-add press" onClick={() => addOn(sel)} title="New task due this day (N)">
              <Icon name="add" size={18} />
              <span>Add</span>
            </button>
          </header>
          {selItems.length === 0 ? (
            <div class="nx-cal-empty">
              <Icon name="event" size={28} />
              <p>No deadlines, reminders or events.</p>
              <button class="nx-text-btn press" onClick={() => addOn(sel)}>Add a task due this day</button>
            </div>
          ) : (
            <ul class="nx-cal-list">
              {selItems.map((i) => (
                <AgendaRow key={i.key} item={i} clashes={i.type === 'event' && i.time != null ? clashWith.get(`${i.event.uid}|${i.time}`) : undefined} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </Page>
  );
}

function updatedLabel(at: number): string {
  if (!at) return 'Calendars not loaded yet';
  const m = Math.floor((Date.now() - at) / 60_000);
  return m < 1 ? 'Updated just now' : m < 60 ? `Updated ${m} min ago` : `Updated ${Math.floor(m / 60)} h ago`;
}

const colorOf = (i: CalItem) => (i.type === 'event' ? i.calendar.color : i.type === 'due' && i.late ? '#FF4060' : PRIORITY_META[i.task.priority].color);
const isDone = (i: CalItem) => i.type !== 'event' && (i.task.isCompleted || i.task.isWontDo);

function CellDots({ list }: { list: CalItem[] }) {
  if (!list.length) return null;
  return (
    <span class="dots">
      {list.slice(0, 4).map((i) => (
        <i key={i.key} style={{ background: colorOf(i), opacity: isDone(i) ? 0.35 : 1 }} />
      ))}
    </span>
  );
}

function CellChips({ list }: { list: CalItem[] }) {
  if (!list.length) return null;
  const shown = list.slice(0, 3);
  return (
    <span class="chips">
      {shown.map((i) => {
        const title = i.type === 'event' ? i.event.summary : i.task.description;
        const source = i.type === 'event' ? calendarSourceLabel(i.calendar) : 'Nexus';
        const draggable = i.type === 'due' && !isDone(i);
        return (
          <span
            key={i.key}
            class={`chip ${i.type} ${isDone(i) ? 'done' : ''} ${i.type === 'due' && i.late ? 'late' : ''}`}
            style={{ '--c': colorOf(i) } as JSX.CSSProperties}
            draggable={draggable}
            onDragStart={(e) => {
              if (i.type !== 'due') return;
              e.dataTransfer?.setData('text/nexus-task', i.task.taskUuid);
              e.dataTransfer!.effectAllowed = 'move';
            }}
            onClick={(e) => {
              if (i.type === 'event') return;
              e.stopPropagation();
              nav.open({ kind: 'detail', taskId: i.task.id });
            }}
            title={`${title} — ${source}`}
          >
            {i.type === 'reminder' && i.time != null && <em>{fmtTime(i.time)}</em>}
            {title}
          </span>
        );
      })}
      {list.length > shown.length && <span class="more">+{list.length - shown.length} more</span>}
    </span>
  );
}

/** The strip under the header: a live radar with the next clash, or a quiet "all clear". */
function RadarBar({ list }: { list: Clash[] }) {
  const next = list[0];
  const other = next ? list.length - 1 : 0;
  return (
    <button class={`nx-radar-bar press ${next ? 'hot' : 'calm'}`} onClick={() => nav.open({ kind: 'clashes' })} aria-label={next ? `Clash radar: ${list.length} clashes. Open` : 'Clash radar: all clear. Open'}>
      <RadarDish count={list.length} size={next ? 34 : 22} />
      {next ? (
        <span class="txt">
          <b>
            {list.length} clash{list.length === 1 ? '' : 'es'} ahead
          </b>
          <small>
            {new Date(next.overlapStart).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} {fmtTime(next.overlapStart)} · {next.a.title} × {next.b.title}
            {other > 0 ? ` · +${other} more` : ''}
          </small>
        </span>
      ) : (
        <span class="txt">
          <b>Clash radar · all clear</b>
          <small>No meetings overlap in the next {CLASH_HORIZON_DAYS} days</small>
        </span>
      )}
      <Icon name="chevronRight" size={18} class="go" />
    </button>
  );
}

function AgendaRow({ item: i, clashes: cl }: { item: CalItem; clashes?: Clash[] }) {
  if (i.type === 'event') {
    const ev = i.event;
    const partners = (cl ?? []).map((c) => (c.a.event.uid === ev.uid && c.a.start === i.time ? c.b : c.a));
    return (
      <li class={`nx-cal-row event ${partners.length ? 'clash' : ''}`} style={{ '--c': i.calendar.color } as JSX.CSSProperties}>
        <span class="bar" />
        <span class="ic"><Icon name={partners.length ? 'warning' : 'event'} size={18} /></span>
        <span class="txt">
          <span class="t">{ev.summary || '(No title)'}</span>
          <span class="m">
            {i.time != null ? fmtTime(i.time) : 'All day'} · <b class="src" style={{ color: i.calendar.color }}>{calendarSourceLabel(i.calendar)}</b>
            {ev.location && !/^https?:\/\//i.test(ev.location) ? ` · ${ev.location}` : ''}
          </span>
          {partners.length > 0 && (
            <button class="clash-tag press" onClick={() => nav.open({ kind: 'clashes' })}>
              Clashes with {partners[0].title} · {fmtTime(partners[0].start)}
              {partners.length > 1 ? ` +${partners.length - 1}` : ''}
            </button>
          )}
        </span>
        {ev.meetingUrl && (
          <a class="nx-cal-join press" href={ev.meetingUrl} target="_blank" rel="noopener noreferrer" title={ev.meetingUrl}>
            <Icon name="video" size={16} />
            Join
          </a>
        )}
        <button
          class={`press ${ev.meetingUrl ? 'nx-cal-mk' : 'nx-text-btn'}`}
          title="Make this a Nexus task with a deadline"
          aria-label="Make task"
          onClick={() => nav.open({ kind: 'add', priority: 'MEDIUM', due: dateToIso(new Date(i.time ?? isoToDate(ev.start.date).getTime())), text: ev.summary, notes: ev.meetingUrl ? `Join: ${ev.meetingUrl}` : undefined })}
        >
          {ev.meetingUrl ? <Icon name="add" size={18} /> : 'Make task'}
        </button>
      </li>
    );
  }
  const t = i.task;
  const meta = PRIORITY_META[t.priority];
  const done = isDone(i);
  const kind =
    i.type === 'due'
      ? i.late
        ? 'Overdue'
        : 'Deadline'
      : i.time != null
        ? `Reminder · ${fmtTime(i.time)}`
        : 'Reminder · all day';
  return (
    <li
      class={`nx-cal-row ${done ? 'done' : ''} ${i.type === 'due' && i.late ? 'late' : ''}`}
      style={{ '--c': meta.color } as JSX.CSSProperties}
      onClick={() => nav.open({ kind: 'detail', taskId: t.id })}
    >
      <span class="bar" />
      <span onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={t.isCompleted} color={meta.color} size={28} dim={!t.isCompleted} onChange={(c) => void setChecked(t, c)} />
      </span>
      <span class="txt">
        <span class="t">{t.description}</span>
        <span class="m">
          <Icon name={i.type === 'due' ? 'calendar' : 'bell'} size={11} /> {kind} · {meta.label} · <b class="src">Nexus</b>
        </span>
      </span>
      <Icon name="chevronRight" size={18} class="go" />
    </li>
  );
}
