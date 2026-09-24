import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { isPc } from '../state/viewport';
import { getSettings } from '../settings/store';
import { dueChipLabel } from '../calendar/deadline';
import { addTask } from '../state/store';
import type { Priority } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import { Icon } from './icons';
import { Menu, Sheet } from './kit';

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
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const meta = PRIORITY_META[priority];

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

  const save = (close: boolean) => {
    const lines = title.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const body = notes;
    // Clear first, synchronously: keystrokes typed right after Enter start a fresh task.
    setTitle('');
    setNotes('');
    if (titleRef.current) titleRef.current.style.height = '';
    if (close) onDismiss();
    else titleRef.current?.focus();
    // Pasting several lines creates one task per line (same as Android).
    void (async () => {
      const s = getSettings();
      const extra = due ? { dueDate: due, dueAlerts: s.defaultDueAlerts, dueAlertTime: s.defaultDueAlertTime } : {};
      for (const [i, line] of lines.entries()) await addTask(line, priority, i === 0 ? body : '', extra);
    })();
  };

  // Menu lists the other priorities first and the current one last (Android order).
  const menuOrder = [...PRIORITIES.filter((p) => p !== priority), priority];

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
                  titleRef.current?.focus();
                }
              }))}
            />
          )}
          {due && (
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
