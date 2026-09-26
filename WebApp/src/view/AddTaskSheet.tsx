import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { isPc } from '../state/viewport';
import { getSettings } from '../settings/store';
import { dueChipLabel } from '../calendar/deadline';
import { parseSmartAdd, type SmartKind } from '../lib/smartAdd';
import { addTask } from '../state/store';
import type { Priority, Task } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import { Icon, type IconName } from './icons';
import { Menu, Sheet } from './kit';
import { animate, STANDARD } from './motion';

/** How long "Added" stays under the field after Enter (a beat, not a toast). */
const ADDED_MS = 1600;

const timeLabel = (ms: number, now = Date.now()) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = dueChipLabel({ dueDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }, now);
  return `${day === 'Due today' ? '' : `${day?.replace(/^Due /, '') ?? ''} `}${time}`.trim();
};

export function AddTaskSheet({ priority: initial, locked, text: initialText = '', due, notes: initialNotes = '', leaving, onExited, onDismiss }: {
  priority: Priority;
  locked?: boolean;
  /** Keystroke that opened the sheet from the keyboard picker. */
  text?: string;
  /** Deadline for the new task (from the calendar), ISO day. */
  due?: string;
  /** Starting notes (e.g. the meeting link of a calendar event). */
  notes?: string;
  leaving: boolean;
  onExited: () => void;
  onDismiss: () => void;
}) {
  const [priority, setPriority] = useState<Priority>(initial);
  const [title, setTitle] = useState(initialText);
  const [notes, setNotes] = useState(initialNotes);
  // Smart-add readings the user tapped away ("tomorrow" really is part of the title).
  const [ignored, setIgnored] = useState<SmartKind[]>([]);
  const [added, setAdded] = useState<string | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);

  // Live reading of the title (lib/smartAdd.ts). Pasted multi-line text is read line by line on save.
  const smart = useMemo(() => (title.includes('\n') ? null : parseSmartAdd(title, Date.now(), ignored)), [title, ignored]);
  // A "!1" in the text switches the pill (unless the quadrant is locked); the pill stays the fallback.
  const effective = !locked && smart?.priority ? smart.priority : priority;
  const meta = PRIORITY_META[effective];
  const chipKey = smart?.chips.map((c) => c.kind + c.text).join('|') ?? '';
  useLayoutEffect(() => {
    if (chipKey) animate(chipsRef.current, [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: STANDARD });
  }, [chipKey]);

  useLayoutEffect(() => {
    // With a keyboard, focus at once so fast typing isn't lost; on touch, after the slide-in
    // starts so mobile keyboards open reliably.
    const el = titleRef.current;
    if (!el) return;
    if (isPc.value || initialText) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      return;
    }
    const t = setTimeout(() => el.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => setAdded(null), ADDED_MS);
    return () => clearTimeout(t);
  }, [added]);

  const save = (close: boolean) => {
    const lines = title.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const body = notes;
    const skip = ignored;
    const fallback = effective;
    if (!lines.length) return;
    // Clear first, synchronously: keystrokes typed right after Enter start a fresh task.
    setTitle('');
    setNotes('');
    setIgnored([]);
    if (titleRef.current) titleRef.current.style.height = '';
    if (close) onDismiss();
    else titleRef.current?.focus();
    const s = getSettings();
    const now = Date.now();
    const first = parseSmartAdd(lines[0], now, skip);
    if (!close) {
      const bits = ['Added'];
      if (first.dueDate) bits.push((dueChipLabel({ dueDate: first.dueDate }, now) ?? '').toLowerCase());
      if (first.reminderTime != null) bits.push(`reminder ${timeLabel(first.reminderTime, now)}`);
      setAdded(bits.join(' · '));
    }
    // Pasting several lines creates one task per line (same as Android). A typed date sets the
    // deadline with the default alerts (the calendar's `due` otherwise); a time sets a one-time
    // reminder, exactly as the reminder wizard's "Exact time" does.
    void (async () => {
      let asked = false;
      for (const [i, line] of lines.entries()) {
        const p = i === 0 ? first : parseSmartAdd(line, now, skip);
        const day = p.dueDate ?? due;
        const extra: Partial<Task> = day ? { dueDate: day, dueAlerts: s.defaultDueAlerts, dueAlertTime: s.defaultDueAlertTime } : {};
        if (p.reminderTime != null) {
          Object.assign(extra, { reminderTime: p.reminderTime, reminderDateOnly: false, reminderIntervalMinutes: 0, reminderEndDate: 0 });
          if (!asked) {
            asked = true;
            askNotificationPermission();
          }
        }
        await addTask(p.title, !locked && p.priority ? p.priority : fallback, i === 0 ? body : '', extra);
      }
    })();
  };

  // Menu lists the other priorities first and the current one last (Android order).
  const menuOrder = [...PRIORITIES.filter((p) => p !== effective), effective];

  const chipLabel = (kind: SmartKind): { icon: IconName; text: string } => {
    if (kind === 'date') return { icon: 'calendar', text: dueChipLabel({ dueDate: smart!.dueDate! }) ?? '' };
    if (kind === 'time') return { icon: 'bell', text: timeLabel(smart!.reminderTime!) };
    return { icon: 'radar', text: `${PRIORITY_META[smart!.priority!].label} priority` };
  };
  // A time that has already passed on an explicit day is left in the title: no chip for it.
  const chips = (smart?.chips ?? []).filter((c) => (c.kind === 'date' ? !!smart?.dueDate : c.kind === 'time' ? smart?.reminderTime != null : !!smart?.priority));

  return (
    <Sheet leaving={leaving} onExited={onExited} onDismiss={onDismiss} scrim={0.65} radius={26} class="nx-add">
      <div class="nx-add-body" style={{ '--c': meta.color } as JSX.CSSProperties}>
        <textarea
          ref={titleRef}
          class="nx-add-title"
          placeholder="What needs to be done?"
          rows={1}
          value={title}
          onInput={(e) => {
            const el = e.currentTarget;
            setTitle(el.value);
            el.style.height = 'auto';
            el.style.height = `${el.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              save(false);
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData?.getData('text') ?? '';
            if (text.includes('\n')) {
              e.preventDefault();
              setTitle((t) => (t ? `${t}\n${text}` : text));
            }
          }}
        />
        {chips.length > 0 && (
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
                    titleRef.current?.focus();
                  }}
                >
                  <Icon name={l.icon} size={13} />
                  {l.text}
                  <Icon name="close" size={12} class="x" />
                </button>
              );
            })}
          </div>
        )}
        <textarea
          class="nx-add-notes"
          placeholder="Description"
          rows={1}
          value={notes}
          onInput={(e) => {
            const el = e.currentTarget;
            setNotes(el.value);
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 66)}px`;
          }}
        />
        {isPc.value && (
          <div class={`nx-add-hint ${added ? 'added' : ''}`} aria-live="polite">
            {added ? (
              <span><Icon name="check" size={12} /> {added}</span>
            ) : (
              <>
                <span><kbd>⏎</kbd> add</span>
                <span><kbd>⇧⏎</kbd> new line</span>
                <span><kbd>esc</kbd> close</span>
                <span class="try">try “call CA tomorrow 5pm !1”</span>
              </>
            )}
          </div>
        )}
        <div class="nx-add-footer">
          {locked ? (
            <span class="nx-pri-pill locked">{meta.label}</span>
          ) : (
            <Menu
              align="start"
              trigger={(toggle) => (
                <button class="nx-pri-pill press" onClick={toggle}>
                  {meta.label}
                  <Icon name="expandMore" size={16} />
                </button>
              )}
              items={menuOrder.map((p) => ({
                label: PRIORITY_META[p].label,
                onSelect: () => {
                  setPriority(p);
                  // Choosing from the menu wins over a "!1" in the text.
                  if (smart?.priority && smart.priority !== p) setIgnored((x) => [...x, 'priority']);
                  titleRef.current?.focus();
                }
              }))}
            />
          )}
          {due && !smart?.dueDate && (
            <span class="nx-due-badge today nx-add-due">
              <Icon name="calendar" size={12} /> {dueChipLabel({ dueDate: due })}
            </span>
          )}
          <span class="grow" />
          <button class="nx-send press" aria-label="Save task" onClick={() => save(true)}>
            <Icon name="send" size={20} />
          </button>
        </div>
      </div>
    </Sheet>
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
