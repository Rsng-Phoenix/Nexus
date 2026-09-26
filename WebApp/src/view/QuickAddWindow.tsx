import '../styles/quickadd.css';
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { addDaysIso, dueChipLabel, todayIso } from '../calendar/deadline';
import { haptic } from '../lib/haptics';
import { clampPanelHeight, clipboardHint, cornerVector, parseQuickAddParams } from '../lib/quickAddParams';
import { parseSmartAdd, type SmartKind } from '../lib/smartAdd';
import { fromStorage } from '../notes/codec';
import { getSettings } from '../settings/store';
import { deskInfo, deskPost, inNexusDesk } from '../state/desk';
import { activeTasks, addTask } from '../state/store';
import { scheduleSync } from '../sync/manager';
import type { Priority, Task } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import { nexusLogoHtml } from '../ui/nexus-logo';
import { renderNotesEditor } from '../ui/notes';
import { Icon, type IconName } from './icons';
import { Menu } from './kit';
import { animate, BOUNCY, EXIT, STANDARD } from './motion';

/**
 * Quick Add page (?mode=quickadd): the Desk's floating panel, also usable as a plain page.
 * One card: title with live smart-add chips, a notes block editor, priority and due quick
 * chips. ⏎ adds and closes, ⇧⏎ adds and stays for the next one. The Desk shows and hides the
 * panel around it (docs/premium-desk-architecture.md §4.2); in a browser tab closing goes home.
 */

/** Last priority used here (remembered across panel shows and launches). */
const PRIO_KEY = 'nexus_qa_prio';
/** How long "Added" stays under the field after ⇧⏎ (a beat, not a toast). */
const ADDED_MS = 1600;
/** A second Esc within this window closes a non-empty card after the first one cleared it. */
const ESC_ARM_MS = 1500;
/** Clipboard offers (§2.6): only a short single line is suggested, never inserted. */
const GHOST_MAX_LEN = 120;
/** Panel frame the Desk is asked for: card height plus the page margin around it (see quickadd.css). */
const PANEL = { min: 132, margin: 14 };

const readPrio = (): Priority => {
  try {
    const v = localStorage.getItem(PRIO_KEY);
    return PRIORITIES.includes(v as Priority) ? (v as Priority) : 'HIGH';
  } catch {
    return 'HIGH';
  }
};

const timeLabel = (ms: number, now = Date.now()) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = dueChipLabel({ dueDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }, now);
  return `${day === 'Due today' ? '' : `${day?.replace(/^Due /, '') ?? ''} `}${time}`.trim();
};

const DUE_QUICK: [string, (today: string) => string][] = [
  ['Today', (t) => t],
  ['Tomorrow', (t) => addDaysIso(t, 1)],
  ['Next week', (t) => addDaysIso(t, 7)]
];

/**
 * Save typed lines as tasks, one per line, reading dates, times and "!1" from each (same as
 * AddTaskSheet and Android). [due] is the fallback deadline, [notes] go on the first task.
 * Resolves after the IndexedDB writes so a caller may close the window right after.
 */
export async function addSmartTasks(lines: string[], fallback: Priority, notes = '', due = '', skip: Iterable<SmartKind> = []): Promise<Task[]> {
  const s = getSettings();
  const now = Date.now();
  const out: Task[] = [];
  let asked = false;
  for (const [i, line] of lines.entries()) {
    const p = parseSmartAdd(line, now, skip);
    const day = p.dueDate ?? due;
    const extra: Partial<Task> = day ? { dueDate: day, dueAlerts: s.defaultDueAlerts, dueAlertTime: s.defaultDueAlertTime } : {};
    if (p.reminderTime != null) {
      Object.assign(extra, { reminderTime: p.reminderTime, reminderDateOnly: false, reminderIntervalMinutes: 0, reminderEndDate: 0 });
      if (!asked) {
        asked = true;
        askNotificationPermission();
      }
    }
    out.push(await addTask(p.title, p.priority ?? fallback, i === 0 ? notes : '', extra));
  }
  // The other windows already know (announce); Drive follows quickly so the phone sees it too.
  if (out.length) scheduleSync(400);
  return out;
}

export function QuickAddWindow() {
  const params = useMemo(() => parseQuickAddParams(location.search), []);
  const [priority, setPriorityState] = useState<Priority>(() => params.priority ?? readPrio());
  const [title, setTitle] = useState(params.text);
  const [ignored, setIgnored] = useState<SmartKind[]>([]);
  const [due, setDue] = useState('');
  const [added, setAdded] = useState<string | null>(null);
  const [ghost, setGhost] = useState<string | null>(null);
  // Bumped by the Desk every time the panel is shown again: replays the entrance and refocuses.
  const [shown, setShown] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const notesHost = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const notes = useRef(params.notes);
  const editor = useRef<ReturnType<typeof renderNotesEditor> | null>(null);
  const escArmed = useRef(0);
  const closing = useRef(false);

  const setPriority = (p: Priority) => {
    setPriorityState(p);
    try {
      localStorage.setItem(PRIO_KEY, p);
    } catch {
      /* ignore */
    }
  };

  // Live reading of the title (lib/smartAdd.ts). Pasted multi-line text is read line by line on save.
  const smart = useMemo(() => (title.includes('\n') ? null : parseSmartAdd(title, Date.now(), ignored)), [title, ignored]);
  // A "!1" in the text switches the pill; the pill stays the fallback.
  const effective = smart?.priority ?? priority;
  const meta = PRIORITY_META[effective];
  const chipKey = smart?.chips.map((c) => c.kind + c.text).join('|') ?? '';
  useLayoutEffect(() => {
    if (chipKey) animate(chipsRef.current, [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: STANDARD });
  }, [chipKey]);

  // Notes: the shared block editor (lists auto-detect, checkboxes), kept in a ref so re-renders leave it alone.
  useEffect(() => {
    const host = notesHost.current;
    if (!host) return;
    host.innerHTML = '';
    editor.current = renderNotesEditor(host, notes.current, (raw) => (notes.current = raw));
  }, []);

  const resetAll = () => {
    setTitle('');
    setIgnored([]);
    setDue('');
    setAdded(null);
    notes.current = '';
    editor.current?.setBlocks(fromStorage(''));
    if (titleRef.current) titleRef.current.style.height = '';
  };

  const focusTitle = () => {
    const el = titleRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };

  // Entrance: the card flies in from the Desk's corner (`from=`), rows follow with a small stagger.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    closing.current = false;
    const { fx, fy } = cornerVector(params.from);
    const r = el.getBoundingClientRect();
    el.style.setProperty('--fx', String(fx));
    el.style.setProperty('--fy', String(fy));
    animate(el, [{ opacity: 0, transform: `translate(${fx * r.width}px, ${fy * r.height}px) scale(0.94)` }, { opacity: 1, transform: 'none' }], { duration: 360, easing: BOUNCY });
    el.querySelectorAll<HTMLElement>('[data-stagger]').forEach((row, i) => {
      animate(row, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 60 + i * 40, easing: STANDARD });
    });
    focusTitle();
    // Clipboard ghost (§2.6): offered as the placeholder, never inserted. readText needs a
    // gesture in most engines; then it simply stays quiet.
    setGhost(null);
    if (!titleRef.current?.value) {
      void (async () => {
        try {
          const clip = await navigator.clipboard?.readText?.();
          setGhost(clipboardHint(clip, activeTasks.value.map((t) => t.description), GHOST_MAX_LEN));
        } catch {
          /* no clipboard access */
        }
      })();
    }
  }, [shown]);

  // The panel's height follows the card (Desk animates its frame; a Windows app window resizes itself, best effort).
  useEffect(() => {
    const el = card.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let last = 0;
    const ro = new ResizeObserver(() => {
      const max = Math.max(PANEL.min, Math.round((window.screen?.availHeight || 800) * 0.8));
      const h = clampPanelHeight(el.getBoundingClientRect().height, { min: PANEL.min, max, margin: PANEL.margin });
      if (h === last) return;
      last = h;
      if (!deskPost({ resize: { height: h } }) && deskInfo.value?.platform === 'windows') {
        try {
          window.resizeTo(window.outerWidth, h + (window.outerHeight - window.innerHeight));
        } catch {
          /* not allowed here */
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Exit beat, then tell the Desk (or, in a plain tab / app window, leave the page). */
  const close = (didAdd: boolean) => {
    if (closing.current) return;
    closing.current = true;
    const el = card.current;
    const { fx, fy } = cornerVector(params.from);
    const r = el?.getBoundingClientRect();
    const a = animate(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translate(${fx * (r?.width ?? 0) * 0.5}px, ${fy * (r?.height ?? 0) * 0.5}px) scale(0.96)` }], EXIT);
    let posted = false;
    const done = () => {
      // Once only: an occluded web view may never finish its animation, so a timer backs it up.
      if (posted) return;
      posted = true;
      if (deskPost({ close: 'quickadd', added: didAdd || undefined })) return;
      // Not in the Desk: an app window (Windows) may close itself; a tab goes back to Nexus.
      try {
        window.close();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (!window.closed) location.href = './';
      }, 50);
    };
    if (a) a.onfinish = done;
    else done();
    setTimeout(done, EXIT.duration + 80);
  };

  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => setAdded(null), ADDED_MS);
    return () => clearTimeout(t);
  }, [added]);

  const save = (andClose: boolean) => {
    const lines = title.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) {
      focusTitle();
      return;
    }
    const body = notes.current;
    const skip = ignored;
    const fallback = effective;
    const day = due;
    haptic('FAB_TAP');
    const now = Date.now();
    const first = parseSmartAdd(lines[0], now, skip);
    // Clear first, synchronously: keystrokes typed right after Enter start a fresh task.
    resetAll();
    if (!andClose) {
      const bits = ['Added'];
      const dueDay = first.dueDate ?? day;
      if (dueDay) bits.push((dueChipLabel({ dueDate: dueDay }, now) ?? '').toLowerCase());
      if (first.reminderTime != null) bits.push(`reminder ${timeLabel(first.reminderTime, now)}`);
      setAdded(bits.join(' · '));
      focusTitle();
    }
    // The write is awaited before the panel closes (IndexedDB, a few ms), so nothing is lost.
    const write = addSmartTasks(lines, fallback, body, day, skip);
    if (andClose) void write.finally(() => close(true));
  };

  /** Esc: close an empty card, clear a non-empty one (a second Esc closes). */
  const escape = () => {
    const empty = !title.trim() && !fromStorage(notes.current).some((b) => b.text.trim()) && !due;
    if (empty || Date.now() < escArmed.current) return close(false);
    resetAll();
    escArmed.current = Date.now() + ESC_ARM_MS;
    focusTitle();
  };

  const pick = (p: Priority) => {
    setPriority(p);
    // Choosing explicitly wins over a "!1" in the text.
    if (smart?.priority && smart.priority !== p) setIgnored((x) => [...x, 'priority']);
    haptic('DRAG_TICK');
    focusTitle();
  };

  // Window-wide keys: ⌘/Alt+1–4 priority, ⌘⏎ save, Esc. The Desk's hooks live here too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if ((e.metaKey || e.altKey || e.ctrlKey) && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        pick(PRIORITIES[Number(e.key) - 1]);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        save(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        escape();
      }
    };
    window.addEventListener('keydown', onKey);
    const w = window as Window & { __nexusQuickAddShown?: () => void; __nexusQuickAddHide?: () => void };
    w.__nexusQuickAddShown = () => {
      resetAll();
      setShown((n) => n + 1);
    };
    w.__nexusQuickAddHide = () => close(false);
    return () => {
      window.removeEventListener('keydown', onKey);
      delete w.__nexusQuickAddShown;
      delete w.__nexusQuickAddHide;
    };
  });

  const chipLabel = (kind: SmartKind): { icon: IconName; text: string } => {
    if (kind === 'date') return { icon: 'calendar', text: dueChipLabel({ dueDate: smart!.dueDate! }) ?? '' };
    if (kind === 'time') return { icon: 'bell', text: timeLabel(smart!.reminderTime!) };
    return { icon: 'radar', text: `${PRIORITY_META[smart!.priority!].label} priority` };
  };
  // A time that has already passed on an explicit day is left in the title: no chip for it.
  const chips = (smart?.chips ?? []).filter((c) => (c.kind === 'date' ? !!smart?.dueDate : c.kind === 'time' ? smart?.reminderTime != null : !!smart?.priority));
  const menuOrder = [...PRIORITIES.filter((p) => p !== effective), effective];
  const mod = deskInfo.value?.platform === 'windows' || /Windows/.test(navigator.userAgent) ? 'Alt' : '⌘';
  const today = todayIso();

  return (
    <div class="nx-qa-page" onClick={(e) => e.target === e.currentTarget && inNexusDesk() && close(false)}>
      <div ref={card} class={`nx-qa ${inNexusDesk() ? 'in-desk' : ''}`} role="dialog" aria-label="Quick add" style={{ '--c': meta.color } as JSX.CSSProperties}>
        <div class="nx-qa-head" data-stagger>
          <span class="mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: nexusLogoHtml(20) }} />
          <textarea
            ref={titleRef}
            class="nx-qa-title"
            placeholder={ghost ? `${mod}V to use: ${ghost}` : 'What needs to be done?'}
            aria-label="New task"
            rows={1}
            value={title}
            onInput={(e) => {
              const el = e.currentTarget;
              setTitle(el.value);
              if (el.value) setGhost(null);
              el.style.height = 'auto';
              el.style.height = `${el.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
              e.preventDefault();
              save(!e.shiftKey);
            }}
            onPaste={(e) => {
              const text = e.clipboardData?.getData('text') ?? '';
              if (text.includes('\n')) {
                e.preventDefault();
                setTitle((t) => (t ? `${t}\n${text}` : text));
              }
            }}
          />
          <Menu
            align="end"
            trigger={(toggle) => (
              <button class="nx-pri-pill press" title={`Priority (${mod}1–4)`} onClick={toggle}>
                {meta.label}
                <Icon name="expandMore" size={16} />
              </button>
            )}
            items={menuOrder.map((p) => ({ label: PRIORITY_META[p].label, onSelect: () => pick(p) }))}
          />
          <button class="nx-qa-send press" aria-label="Add task (Enter)" title="Add (⏎)" onClick={() => save(true)}>
            <Icon name="send" size={18} />
          </button>
        </div>
        <div class={`nx-qa-under ${added ? 'added' : ''}`} aria-live="polite" data-stagger>
          {added ? (
            <span class="beat"><Icon name="check" size={12} /> {added}</span>
          ) : chips.length > 0 ? (
            <div ref={chipsRef} class="nx-add-chips" aria-label="Understood from the title">
              {chips.map((c) => {
                const l = chipLabel(c.kind);
                const color = c.kind === 'priority' ? PRIORITY_META[smart!.priority!].color : undefined;
                return (
                  <button
                    key={c.kind}
                    class="nx-add-chip press"
                    style={color ? ({ '--chip': color } as JSX.CSSProperties) : undefined}
                    title={`“${c.text}” → ${l.text}. Click to keep it as plain text.`}
                    onClick={() => {
                      setIgnored((x) => [...x, c.kind]);
                      focusTitle();
                    }}
                  >
                    <Icon name={l.icon} size={13} />
                    {l.text}
                    <Icon name="close" size={12} class="x" />
                  </button>
                );
              })}
            </div>
          ) : (
            <span class="try">try “call CA tomorrow 5pm !1”</span>
          )}
        </div>
        <div class="nx-qa-notes" data-stagger onClick={(e) => e.target === e.currentTarget && editor.current?.focusEnd()}>
          <div ref={notesHost} class="nx-qa-notes-host" aria-label="Notes" />
        </div>
        <div class="nx-qa-foot" data-stagger>
          <span class="prios" role="radiogroup" aria-label="Priority">
            {PRIORITIES.map((p, i) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={effective === p}
                title={`${PRIORITY_META[p].label} (${mod}${i + 1})`}
                class={effective === p ? 'on' : ''}
                style={{ '--c': PRIORITY_META[p].color } as JSX.CSSProperties}
                onClick={() => pick(p)}
              />
            ))}
          </span>
          <span class={`due ${smart?.dueDate ? 'typed' : ''}`} role="group" aria-label="Deadline">
            {DUE_QUICK.map(([label, f]) => {
              const iso = f(today);
              return (
                <button key={label} class={due === iso ? 'on' : ''} title={smart?.dueDate ? 'The date in the title wins' : label} onClick={() => setDue(due === iso ? '' : iso)}>
                  {label}
                </button>
              );
            })}
            <button class={due && !DUE_QUICK.some(([, f]) => f(today) === due) ? 'on' : ''} title="Pick a day" onClick={() => (dateRef.current?.showPicker ? dateRef.current.showPicker() : dateRef.current?.click())}>
              {due && !DUE_QUICK.some(([, f]) => f(today) === due) ? dueChipLabel({ dueDate: due })?.replace(/^Due /, '') : 'Pick…'}
            </button>
            <input ref={dateRef} type="date" class="date" tabIndex={-1} aria-hidden="true" value={due} onChange={(e) => setDue(e.currentTarget.value)} />
          </span>
          <span class="grow" />
          <span class="hints">
            <span><kbd>⏎</kbd> add</span>
            <span><kbd>⇧⏎</kbd> add &amp; another</span>
            <span><kbd>esc</kbd> {title.trim() ? 'clear' : 'close'}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Same nudge as the reminder wizard: ask once, never block. */
function askNotificationPermission(): void {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => {});
    }
  } catch {
    /* ignore */
  }
}
