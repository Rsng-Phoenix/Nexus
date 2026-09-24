import '../styles/reminder.css';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { vibrateDragStep } from '../lib/haptics';
import { settingsSig } from '../settings/store';
import * as nav from '../state/nav';
import { allTasks, updateTask } from '../state/store';
import type { LayerProps } from './App';
import { Icon } from './icons';
import { animate, BOUNCY, STANDARD, useEnterExit } from './motion';

/*
 * Web port of NexusDateTimePicker (MainActivity.kt).
 * Steps: 0 DATE → 1 MODE → (2 TIME | 3 END DATE → 4 INTERVAL | 4 INTERVAL).
 * Days are carried as local-midnight millis, so the Android localToPickerUtc / pickerUtcToLocal
 * round-trip is unnecessary here.
 */

type Mode = 'exact' | 'allDay' | 'range' | null;
type Step = 0 | 1 | 2 | 3 | 4;

// ─── Local date helpers ────────────────────────────────────────────────────────

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
/** Calendar-safe day add (DST-proof). */
function addDays(dayMs: number, n: number): number {
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}
function atHour(dayMs: number, hour: number, minute = 0): number {
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
}
function formatHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}
const fmtShort = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtHeadline = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtAria = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

// ─── Component ─────────────────────────────────────────────────────────────────

export function ReminderWizard(p: LayerProps & { taskId: number }) {
  const box = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useEnterExit(
    box,
    p.leaving,
    p.onExited,
    [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'scale(1)' }],
    [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.96)' }],
    { duration: 300, easing: BOUNCY },
    { duration: 170, easing: STANDARD }
  );
  useLayoutEffect(() => {
    animate(scrim.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: STANDARD });
  }, []);
  useLayoutEffect(() => {
    if (p.leaving) animate(scrim.current, [{ opacity: 1 }, { opacity: 0 }], { duration: 170, easing: STANDARD });
  }, [p.leaving]);

  const win = settingsSig.value;
  const task = allTasks.value.find((t) => t.id === p.taskId);

  // Initial values (Android: existing future reminder, else now + 15 min).
  const init = useMemo(() => {
    const now = Date.now();
    const existing = task?.reminderTime ?? null;
    const initial = existing != null && existing > now ? existing : now + 15 * 60_000;
    const d = new Date(initial);
    return { day: startOfDay(initial), hour: d.getHours(), minute: d.getMinutes() };
  }, []);

  const [step, setStep] = useState<Step>(0);
  const [dir, setDir] = useState(1);
  const [mode, setMode] = useState<Mode>(null);
  const [startDay, setStartDay] = useState(init.day);
  const [endDay, setEndDay] = useState(addDays(init.day, 7));
  const [hour24, setHour24] = useState(init.hour);
  const [minute, setMinute] = useState(init.minute);
  const [intervalHours, setIntervalHours] = useState<1 | 2>(2);
  const [useCustom, setUseCustom] = useState(false);
  const [customMinutes, setCustomMinutes] = useState('120');
  const customRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (useCustom) customRef.current?.focus();
  }, [useCustom]);

  // Live clock so "Pick a future time" flips on its own while the dialog is open.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const today = startOfDay(now);

  const go = (s: Step) => {
    setDir(s > step ? 1 : -1);
    if (s === 3 && endDay <= startDay) setEndDay(addDays(startDay, 7));
    setStep(s);
  };

  // Step transition: slide + fade (transform/opacity only).
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    animate(
      content.current,
      [
        { opacity: 0, transform: `translateX(${dir * 28}px)` },
        { opacity: 1, transform: 'none' }
      ],
      { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
    );
  }, [step]);

  const exactMillis = atHour(startDay, hour24, minute);
  const inFuture = exactMillis > now;
  const intervalMin = useCustom
    ? Math.max(1, parseInt(customMinutes, 10) || 120)
    : intervalHours === 1
      ? 60
      : 120;
  const hintInterval = useCustom ? parseInt(customMinutes, 10) || 0 : intervalHours * 60;

  function confirm() {
    const t = allTasks.value.find((x) => x.id === p.taskId);
    if (!t) {
      p.onDismiss();
      return;
    }
    let patch: Pick<typeof t, 'reminderTime' | 'reminderDateOnly' | 'reminderIntervalMinutes' | 'reminderEndDate'>;
    if (mode === 'exact') {
      if (!inFuture) return;
      patch = { reminderTime: exactMillis, reminderDateOnly: false, reminderIntervalMinutes: 0, reminderEndDate: 0 };
    } else if (mode === 'allDay') {
      patch = {
        reminderTime: atHour(startDay, win.windowStart),
        reminderDateOnly: true,
        reminderIntervalMinutes: intervalMin,
        reminderEndDate: 0
      };
    } else if (mode === 'range') {
      patch = {
        reminderTime: atHour(startDay, win.windowStart),
        reminderDateOnly: true,
        reminderIntervalMinutes: intervalMin,
        reminderEndDate: endDay > startDay ? endDay : addDays(startDay, 7)
      };
    } else return;
    void updateTask({ ...t, ...patch, reminderHistoryLabel: '' });
    try {
      if ('Notification' in window && Notification.permission === 'default') {
        void Notification.requestPermission().catch(() => {});
      }
    } catch {
      /* ignore */
    }
    p.onDismiss();
  }

  const next1 = () => {
    if (mode === 'exact') go(2);
    else if (mode === 'allDay') go(4);
    else if (mode === 'range') go(3);
  };

  // Primary action per step (also used by Enter).
  const primary: { label: string; run: () => void; disabled: boolean } = (() => {
    switch (step) {
      case 0:
        return { label: 'Next →', run: () => go(1), disabled: startDay < today };
      case 1:
        return { label: 'Next →', run: next1, disabled: mode == null };
      case 2:
        return { label: inFuture ? 'Set reminder' : 'Pick a future time', run: confirm, disabled: !inFuture };
      case 3:
        return { label: 'Next →', run: () => go(4), disabled: endDay <= startDay };
      default:
        return { label: 'Set reminder', run: confirm, disabled: false };
    }
  })();
  const secondary: { label: string; run: () => void } =
    step === 0
      ? { label: 'Cancel', run: p.onDismiss }
      : step === 4
        ? { label: '← Back', run: () => go(mode === 'range' ? 3 : 1) }
        : step === 3 || step === 2
          ? { label: '← Back', run: () => go(1) }
          : { label: '← Back', run: () => go(0) };

  // Enter = primary (Esc is handled globally by nav).
  const primaryRef = useRef(primary);
  primaryRef.current = primary;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || p.leaving) return;
      if (nav.top.value?.id !== p.id) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button')) return; // native activation
      e.preventDefault();
      const pr = primaryRef.current;
      if (!pr.disabled) pr.run();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [p.leaving]);

  // Step path for the progress dots.
  const path: Step[] = mode === 'exact' ? [0, 1, 2] : mode === 'allDay' ? [0, 1, 4] : mode === 'range' ? [0, 1, 3, 4] : [0, 1, 2];
  const pos = Math.max(0, path.indexOf(step));

  let title: ComponentChildren;
  let body: ComponentChildren;
  switch (step) {
    case 0:
      title = <DateHeader label="Select date" value={startDay} />;
      body = <Calendar value={startDay} onChange={setStartDay} isDisabled={(d) => d < today} />;
      break;
    case 1:
      title = <h2 class="nx-rw-title">Reminder Type</h2>;
      body = (
        <div class="nx-rw-col">
          <div class="nx-rw-sub accent">{fmtShort(startDay)}</div>
          <ModeCard icon={<Icon name="schedule" size={20} />} title="Exact Time" subtitle="Remind me at a specific time" selected={mode === 'exact'} onClick={() => setMode('exact')} />
          <ModeCard icon={<SunIcon />} title="All Day" subtitle="Notify every few hours throughout the day" selected={mode === 'allDay'} onClick={() => setMode('allDay')} />
          <ModeCard icon={<RangeIcon />} title="Date Range" subtitle="Repeat daily between two dates (e.g., exam week)" selected={mode === 'range'} onClick={() => setMode('range')} />
        </div>
      );
      break;
    case 2:
      title = <h2 class="nx-rw-title">Set Reminder Time</h2>;
      body = (
        <div class="nx-rw-col">
          <div class="nx-rw-sub accent">{fmtShort(startDay)}</div>
          <TimePicker
            hour24={hour24}
            minute={minute}
            onChange={(h, m) => {
              setHour24(h);
              setMinute(m);
            }}
          />
          {!inFuture && <div class="nx-rw-hint warn">That time has already passed today.</div>}
        </div>
      );
      break;
    case 3:
      title = <DateHeader label="Select end date" value={endDay} />;
      body = <Calendar value={endDay} onChange={setEndDay} isDisabled={(d) => d <= startDay || d < today} rangeStart={startDay} />;
      break;
    default:
      title = <h2 class="nx-rw-title">Remind every…</h2>;
      body = (
        <div class="nx-rw-col">
          <div class="nx-rw-sub">How often should I remind you each day?</div>
          <Chip label="1 hour" selected={!useCustom && intervalHours === 1} onClick={() => { setIntervalHours(1); setUseCustom(false); }} />
          <Chip label="2 hours" selected={!useCustom && intervalHours === 2} onClick={() => { setIntervalHours(2); setUseCustom(false); }} />
          <Chip label="Custom" selected={useCustom} onClick={() => setUseCustom(true)} />
          {useCustom && (
            <label class="nx-rw-field">
              <span>Minutes (e.g. 90)</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                value={customMinutes}
                ref={customRef}
                onInput={(e) => {
                  const el = e.currentTarget;
                  const v = el.value.replace(/\D/g, '').slice(0, 4);
                  el.value = v;
                  setCustomMinutes(v);
                }}
              />
            </label>
          )}
          {hintInterval > 0 && (
            <div class="nx-rw-hint">
              Notifications: ~{Math.floor(((win.windowEnd - win.windowStart) * 60) / hintInterval) + 1} per day (
              {formatHour(win.windowStart)} – {formatHour(win.windowEnd)}, change in Settings)
            </div>
          )}
        </div>
      );
  }

  return (
    <div class="nx-rw-wrap" data-leaving={p.leaving || undefined}>
      <div ref={scrim} class="nx-scrim nx-rw-scrim" onClick={p.onDismiss} />
      <div ref={box} class="nx-rw-card" role="dialog" aria-modal="true" aria-label="Set reminder">
        <div class="nx-rw-dots" aria-label={`Step ${pos + 1} of ${path.length}`} role="img">
          {path.map((s, i) => (
            <span key={s} class={i === pos ? 'on' : i < pos ? 'done' : ''} />
          ))}
        </div>
        <div ref={content} class="nx-rw-content">
          {title}
          <div class="nx-rw-body">{body}</div>
        </div>
        <div class="nx-rw-actions">
          <button class="nx-text-btn press nx-rw-secondary" onClick={secondary.run}>
            {secondary.label}
          </button>
          <button class="nx-text-btn press" disabled={primary.disabled} onClick={primary.run}>
            {primary.label}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Pieces ────────────────────────────────────────────────────────────────────

function DateHeader({ label, value }: { label: string; value: number }) {
  return (
    <div class="nx-rw-datehead">
      <div class="nx-rw-sub">{label}</div>
      <h2 class="nx-rw-headline">{fmtHeadline(value)}</h2>
    </div>
  );
}

function ModeCard({ icon, title, subtitle, selected, onClick }: {
  icon: ComponentChildren;
  title: string;
  subtitle: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button class={`nx-rw-mode press ${selected ? 'sel' : ''}`} role="radio" aria-checked={selected} onClick={onClick}>
      <span class="ic">{icon}</span>
      <span class="tx">
        <b>{title}</b>
        <small>{subtitle}</small>
      </span>
      {selected && <span class="nx-rw-dot" />}
    </button>
  );
}

function Chip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button class={`nx-rw-chip press ${selected ? 'sel' : ''}`} role="radio" aria-checked={selected} onClick={onClick}>
      <span>{label}</span>
      {selected && <span class="nx-rw-dot" />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z" />
    </svg>
  );
}
function RangeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9 11H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2zm2-7h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z" />
    </svg>
  );
}
function Chevron({ dir }: { dir: 'left' | 'right' | 'up' | 'down' }) {
  const d = { left: 'M15 6l-6 6 6 6', right: 'M9 6l6 6-6 6', up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6' }[dir];
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

// ─── Calendar (Monday-first) ───────────────────────────────────────────────────

function Calendar({ value, onChange, isDisabled, rangeStart }: {
  value: number;
  onChange: (day: number) => void;
  isDisabled: (day: number) => boolean;
  rangeStart?: number;
}) {
  const today = startOfDay(Date.now());
  const v = new Date(value);
  const [ym, setYm] = useState({ y: v.getFullYear(), m: v.getMonth() });
  const [focusDay, setFocusDay] = useState(value);
  const grid = useRef<HTMLDivElement>(null);
  const monthRef = useRef<HTMLDivElement>(null);
  const moveDir = useRef(0);
  const wantFocus = useRef(false);

  const first = new Date(ym.y, ym.m, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first
  const daysIn = new Date(ym.y, ym.m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysIn; d++) cells.push(new Date(ym.y, ym.m, d).getTime());
  while (cells.length % 7) cells.push(null);

  const lastOfPrev = new Date(ym.y, ym.m, 0).getTime();
  const canPrev = lastOfPrev >= today;

  const weekdays = useMemo(() => {
    const base = new Date(2024, 0, 1); // a Monday
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base.getFullYear(), 0, 1 + i);
      return {
        short: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
        long: d.toLocaleDateString(undefined, { weekday: 'long' })
      };
    });
  }, []);

  const shift = (n: number) => {
    if (n < 0 && !canPrev) return;
    moveDir.current = n;
    setYm(({ y, m }) => {
      const d = new Date(y, m + n, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };

  useLayoutEffect(() => {
    if (moveDir.current) {
      animate(
        monthRef.current,
        [
          { opacity: 0, transform: `translateX(${moveDir.current * 22}px)` },
          { opacity: 1, transform: 'none' }
        ],
        { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
      );
      moveDir.current = 0;
    }
    if (wantFocus.current) {
      wantFocus.current = false;
      grid.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)?.focus();
    }
  }, [ym.y, ym.m, focusDay]);

  const pick = (d: number) => {
    if (isDisabled(d)) return;
    if (d !== value) vibrateDragStep();
    onChange(d);
    setFocusDay(d);
  };

  const onKey = (e: KeyboardEvent, d: number) => {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (delta == null) return;
    e.preventDefault();
    const nd = addDays(d, delta);
    const ndd = new Date(nd);
    if (ndd.getMonth() !== ym.m || ndd.getFullYear() !== ym.y) {
      if (nd < d && !canPrev) return;
      moveDir.current = nd > d ? 1 : -1;
      setYm({ y: ndd.getFullYear(), m: ndd.getMonth() });
    }
    wantFocus.current = true;
    setFocusDay(nd);
  };

  // The roving tab stop lives on the focused day if it's in view, else on the selection / first enabled day.
  const inView = (d: number) => {
    const x = new Date(d);
    return x.getMonth() === ym.m && x.getFullYear() === ym.y;
  };
  const tabDay = inView(focusDay)
    ? focusDay
    : inView(value)
      ? value
      : (cells.find((c) => c != null && !isDisabled(c)) as number | undefined) ?? (cells.find((c) => c != null) as number);

  const monthLabel = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div class="nx-rw-cal">
      <div class="nx-rw-cal-head">
        <span class="nx-rw-month" aria-live="polite">{monthLabel}</span>
        <button class="nx-rw-nav press" aria-label="Previous month" disabled={!canPrev} onClick={() => shift(-1)}>
          <Chevron dir="left" />
        </button>
        <button class="nx-rw-nav press" aria-label="Next month" onClick={() => shift(1)}>
          <Chevron dir="right" />
        </button>
      </div>
      <div ref={monthRef}>
        <div class="nx-rw-week" aria-hidden="true">
          {weekdays.map((w) => (
            <span key={w.long} title={w.long}>{w.short}</span>
          ))}
        </div>
        <div ref={grid} class="nx-rw-grid" role="grid" aria-label={monthLabel}>
          {cells.map((d, i) => {
            if (d == null) return <span key={`e${i}`} class="nx-rw-day empty" />;
            const dis = isDisabled(d);
            const sel = d === value;
            const inRange = rangeStart != null && d > rangeStart && d < value;
            const isStart = rangeStart != null && d === rangeStart;
            return (
              <button
                key={d}
                data-day={d}
                role="gridcell"
                class={`nx-rw-day${sel ? ' sel' : ''}${d === today ? ' today' : ''}${dis ? ' dis' : ''}${inRange ? ' span' : ''}${isStart ? ' start' : ''}`}
                aria-label={fmtAria(d)}
                aria-selected={sel}
                aria-disabled={dis || undefined}
                aria-current={d === today ? 'date' : undefined}
                tabIndex={d === tabDay ? 0 : -1}
                onClick={() => pick(d)}
                onKeyDown={(e) => onKey(e, d)}
              >
                <span>{new Date(d).getDate()}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Time picker (12-hour, steppers + typing + wheel) ─────────────────────────

function useHoldRepeat(fn: () => void) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timers = useRef<{ t?: number; i?: number }>({});
  const stop = () => {
    clearTimeout(timers.current.t);
    clearInterval(timers.current.i);
    timers.current = {};
  };
  useEffect(() => stop, []);
  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      fnRef.current();
      stop();
      timers.current.t = window.setTimeout(() => {
        timers.current.i = window.setInterval(() => fnRef.current(), 75);
      }, 380);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    // Keyboard activation (click with detail 0); pointer clicks were already handled on pointerdown.
    onClick: (e: MouseEvent) => {
      if (e.detail === 0) fnRef.current();
    }
  };
}

function Spin({ label, value, display, onStep, onType, maxLen }: {
  label: string;
  value: number;
  display: string;
  onStep: (d: number) => void;
  onType: (n: number) => boolean;
  maxLen: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const up = useHoldRepeat(() => onStep(1));
  const down = useHoldRepeat(() => onStep(-1));
  const valRef = useRef<HTMLDivElement>(null);
  const prev = useRef(value);
  const wheelAcc = useRef(0);

  useLayoutEffect(() => {
    if (prev.current !== value && draft == null) {
      const dir = value > prev.current ? 1 : -1;
      animate(valRef.current, [{ transform: `translateY(${dir * 6}px)`, opacity: 0.4 }, { transform: 'none', opacity: 1 }], {
        duration: 140,
        easing: STANDARD
      });
    }
    prev.current = value;
  }, [value]);

  return (
    <div
      class="nx-rw-spin"
      onWheel={(e) => {
        e.preventDefault();
        wheelAcc.current += e.deltaY;
        if (Math.abs(wheelAcc.current) >= 40) {
          onStep(wheelAcc.current < 0 ? 1 : -1);
          wheelAcc.current = 0;
        }
      }}
    >
      <button class="nx-rw-step press" aria-label={`Increase ${label}`} tabIndex={-1} {...up}>
        <Chevron dir="up" />
      </button>
      <div ref={valRef} class="nx-rw-val">
        <input
          type="text"
          inputMode="numeric"
          aria-label={label}
          role="spinbutton"
          aria-valuenow={value}
          maxLength={maxLen}
          value={draft ?? display}
          onFocus={(e) => {
            setDraft(display);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select());
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setDraft(null);
              onStep(1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setDraft(null);
              onStep(-1);
            }
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            const v = el.value.replace(/\D/g, '').slice(0, maxLen);
            el.value = v;
            setDraft(v);
            if (v !== '') onType(parseInt(v, 10));
          }}
        />
      </div>
      <button class="nx-rw-step press" aria-label={`Decrease ${label}`} tabIndex={-1} {...down}>
        <Chevron dir="down" />
      </button>
    </div>
  );
}

function TimePicker({ hour24, minute, onChange }: {
  hour24: number;
  minute: number;
  onChange: (h: number, m: number) => void;
}) {
  const pm = hour24 >= 12;
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const to24 = (h: number, isPm: boolean) => (h % 12) + (isPm ? 12 : 0);
  const cur = useRef({ hour24, minute });
  cur.current = { hour24, minute };

  const stepHour = (d: number) => {
    const { hour24: H, minute: M } = cur.current;
    const isPm = H >= 12;
    const h = ((((H % 12) + d) % 12) + 12) % 12; // stays in the same AM/PM half, like a 12h wheel
    onChange(h + (isPm ? 12 : 0), M);
  };
  const stepMin = (d: number) => {
    const { hour24: H, minute: M } = cur.current;
    onChange(H, (((M + d) % 60) + 60) % 60);
  };

  return (
    <div class="nx-rw-time" role="group" aria-label="Time">
      <Spin
        label="Hour"
        value={h12}
        display={String(h12)}
        maxLen={2}
        onStep={stepHour}
        onType={(n) => {
          if (n < 1 || n > 12) return false;
          onChange(to24(n, cur.current.hour24 >= 12), cur.current.minute);
          return true;
        }}
      />
      <span class="nx-rw-colon" aria-hidden="true">:</span>
      <Spin
        label="Minute"
        value={minute}
        display={String(minute).padStart(2, '0')}
        maxLen={2}
        onStep={stepMin}
        onType={(n) => {
          if (n < 0 || n > 59) return false;
          onChange(cur.current.hour24, n);
          return true;
        }}
      />
      <div class="nx-rw-ampm" role="radiogroup" aria-label="AM or PM">
        {(['AM', 'PM'] as const).map((k) => {
          const on = (k === 'PM') === pm;
          return (
            <button
              key={k}
              role="radio"
              aria-checked={on}
              class={`press ${on ? 'sel' : ''}`}
              onClick={() => onChange(to24(h12, k === 'PM'), minute)}
            >
              {k}
            </button>
          );
        })}
      </div>
    </div>
  );
}
