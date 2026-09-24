import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { addTask } from '../state/store';
import type { Priority } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import { Icon } from './icons';
import { Menu, Sheet } from './kit';

export function AddTaskSheet({ priority: initial, locked, leaving, onExited, onDismiss }: {
  priority: Priority;
  locked?: boolean;
  leaving: boolean;
  onExited: () => void;
  onDismiss: () => void;
}) {
  const [priority, setPriority] = useState<Priority>(initial);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const meta = PRIORITY_META[priority];

  useEffect(() => {
    // Focus after the slide-in starts so mobile keyboards open reliably.
    const t = setTimeout(() => titleRef.current?.focus(), 60);
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
      for (const [i, line] of lines.entries()) await addTask(line, priority, i === 0 ? body : '');
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
          <span class="grow" />
          <button class="nx-send press" aria-label="Save task" onClick={() => save(true)}>
            <Icon name="send" size={20} />
          </button>
        </div>
      </div>
    </Sheet>
  );
}
