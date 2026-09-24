import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/haptics';
import { formatReminderLabel } from '../reminder-label';
import { settingsSig } from '../settings/store';
import { isWide } from '../state/viewport';
import { taskSharePayload } from '../share/export';
import * as nav from '../state/nav';
import { allTasks, archiveTasks, deleteTasks, restoreTasks, setChecked, togglePin, toggleWontDo, unarchiveTasks, updateTask } from '../state/store';
import { offerUndo } from '../state/toasts';
import type { Priority, Task } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import { notesToolbar, renderNotesEditor } from '../ui/notes';
import { Icon } from './icons';
import { Checkbox, Menu, type MenuItem } from './kit';
import { animate, BOUNCY, EXIT, STANDARD } from './motion';

/**
 * Task sheet: opens at 57% height, drag up (> 80px) or focus the keyboard to expand to full,
 * drag down (> 150px), tap the scrim or press back to save and close.
 */
export function TaskDetailSheet({ id, taskId, leaving, onExited }: {
  id: number;
  taskId: number;
  leaving: boolean;
  onExited: () => void;
}) {
  const task = allTasks.value.find((t) => t.id === taskId);
  const [title, setTitle] = useState(task?.description ?? '');
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'NONE');
  const [expanded, setExpanded] = useState(false);
  const notes = useRef(task?.notes ?? '');
  const skipSave = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  const notesEl = useRef<HTMLDivElement>(null);
  const toolbarEl = useRef<HTMLDivElement>(null);
  const titleEl = useRef<HTMLTextAreaElement>(null);
  const desktop = isWide.value;

  const latest = () => allTasks.value.find((t) => t.id === taskId);

  const save = () => {
    if (skipSave.current) return;
    const cur = latest();
    if (!cur || cur.deletedAt > 0) return;
    const desc = title.replace(/\s*\n\s*/g, ' ').trim() || cur.description;
    if (desc !== cur.description || priority !== cur.priority || notes.current !== cur.notes) {
      void updateTask({ ...cur, description: desc, priority, notes: notes.current });
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  // Any route that closes this layer (back gesture, Esc, scrim) saves first.
  useEffect(() => nav.onLayerClose(id, () => saveRef.current()), [id]);

  useEffect(() => {
    if (!notesEl.current || !toolbarEl.current || !task) return;
    const editor = renderNotesEditor(notesEl.current, task.notes, (s) => (notes.current = s));
    notesToolbar(
      toolbarEl.current,
      notesEl.current,
      editor.getBlocks,
      (b) => editor.setBlocks(b),
      () => undefined,
      () => (document.activeElement as HTMLElement | null)?.closest('.nx-note-edit') as HTMLElement | null
    );
  }, []);

  useLayoutEffect(() => {
    const el = titleEl.current;
    if (el) el.style.height = `${el.scrollHeight}px`;
  }, []);

  // Keyboard opens (focus inside) → expand, like Android's imePadding + auto-expand.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const f = () => !desktop && setExpanded(true);
    el.addEventListener('focusin', f);
    return () => el.removeEventListener('focusin', f);
  }, []);

  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    if (desktop) {
      animate(el, [{ transform: 'scale(0.96)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(0.2,0,0,1)' });
    } else {
      animate(el, [{ transform: 'translateY(50%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 340, easing: 'cubic-bezier(0.2,0,0,1)' });
    }
    animate(shade.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'linear' });
  }, []);
  useLayoutEffect(() => {
    if (!leaving) return;
    const el = panel.current;
    const a = desktop
      ? animate(el, [{ transform: 'none', opacity: 1 }, { transform: 'scale(0.97)', opacity: 0 }], { duration: 180, easing: STANDARD })
      : animate(el, [{ transform: getComputedStyle(el!).transform === 'none' ? 'none' : getComputedStyle(el!).transform, opacity: 1 }, { transform: 'translateY(60%)', opacity: 0 }], { duration: 240, easing: STANDARD });
    animate(shade.current, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'linear' });
    if (a) a.onfinish = onExited;
    else onExited();
  }, [leaving]);

  // Drag the header: follows at 0.65×, up > 80 expands, down > 150 saves and closes.
  const drag = useRef<{ y: number; id: number; dy: number } | null>(null);
  const dragHandlers = desktop
    ? {}
    : {
        onPointerDown: (e: PointerEvent) => {
          if ((e.target as HTMLElement).closest('button, textarea, input')) return;
          drag.current = { y: e.clientY, id: e.pointerId, dy: 0 };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        },
        onPointerMove: (e: PointerEvent) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId || !panel.current) return;
          d.dy = (e.clientY - d.y) * 0.65;
          panel.current.style.transform = `translateY(${Math.max(expanded ? 0 : -40, d.dy)}px)`;
        },
        onPointerUp: () => {
          const d = drag.current;
          drag.current = null;
          const el = panel.current;
          if (!d || !el) return;
          if (d.dy > 150 * 0.65) {
            nav.back();
            return;
          }
          if (d.dy < -80 * 0.65) setExpanded(true);
          const from = el.style.transform;
          el.style.transform = '';
          if (from) animate(el, [{ transform: from }, { transform: 'none' }], { duration: 320, easing: BOUNCY, fill: 'none' });
        }
      };

  if (!task) return null;
  const cur = latest() ?? task;
  const meta = PRIORITY_META[priority];
  const done = cur.isCompleted;
  const reminder = formatReminderLabel(cur.reminderTime, cur.reminderDateOnly, cur.reminderIntervalMinutes, cur.reminderEndDate);

  const closeWithoutSave = () => {
    skipSave.current = true;
    nav.back();
  };
  const items: MenuItem[] = [
    { label: cur.isPinned ? 'Unpin' : 'Pin to top', icon: 'pin', onSelect: () => void togglePin(cur) },
    { label: cur.isWontDo ? "Undo won't do" : "Won't do", icon: 'block', onSelect: () => void toggleWontDo(cur) },
    {
      label: cur.reminderTime != null ? 'Edit reminder' : 'Add reminder',
      icon: 'bell',
      onSelect: () => {
        save();
        nav.open({ kind: 'reminder', taskId });
      }
    },
    ...(cur.reminderTime != null
      ? [{ label: 'Clear reminder', icon: 'close' as const, onSelect: () => void clearReminder(cur) }]
      : []),
    { label: 'Share', icon: 'share', onSelect: () => nav.open({ kind: 'share', payload: taskSharePayload({ ...cur, description: title, notes: notes.current }) }) },
    'divider',
    {
      label: 'Archive',
      icon: 'archive',
      onSelect: () => {
        save();
        const ids = [cur.id];
        void archiveTasks(ids);
        offerUndo('Task archived', () => void unarchiveTasks(ids));
        closeWithoutSave();
      }
    },
    {
      label: 'Delete',
      icon: 'delete',
      danger: true,
      onSelect: () => {
        haptic('DELETE');
        const ids = [cur.id];
        void deleteTasks(ids);
        offerUndo('Task deleted', () => void restoreTasks(ids));
        closeWithoutSave();
      }
    }
  ];

  return (
    <div class={`nx-layer nx-detail-layer ${desktop ? 'side' : ''}`} data-leaving={leaving || undefined}>
      <div ref={shade} class="nx-scrim" style={{ background: 'rgba(0,0,0,0.7)' }} onClick={() => nav.back()} />
      <div
        ref={panel}
        class={`nx-detail ${expanded || desktop ? 'expanded' : ''}`}
        style={{ '--c': meta.color, fontSize: `${settingsSig.value.fontScale}em` } as JSX.CSSProperties}
        role="dialog"
        aria-modal="true"
        aria-label="Task"
      >
        <div class="nx-detail-head" {...dragHandlers}>
          {!desktop && <div class="nx-sheet-handle"><span /></div>}
          <div class="nx-detail-bar">
            <Menu
              align="start"
              trigger={(toggle) => (
                <button class="nx-pri-tag press" onClick={toggle}>
                  <span class="dot" />
                  {meta.label.toUpperCase()}
                </button>
              )}
              items={[...PRIORITIES.filter((p) => p !== priority), priority].map((p) => ({
                label: PRIORITY_META[p].label,
                onSelect: () => setPriority(p)
              }))}
            />
            <span class="grow" />
            <Menu trigger={(toggle) => (
              <button class="nx-icon-btn press" aria-label="More" onClick={toggle}><Icon name="moreVert" /></button>
            )} items={items} />
            <button class="nx-send small press" aria-label="Save and close" onClick={() => nav.back()}>
              <Icon name="send" size={18} />
            </button>
          </div>
        </div>
        <div class="nx-detail-scroll">
          <div class="nx-detail-title-row">
            <Checkbox checked={done} color={meta.color} size={34} onChange={(c) => void setChecked(cur, c)} />
            <textarea
              ref={titleEl}
              class={`nx-detail-title ${done ? 'done' : ''}`}
              rows={1}
              value={title}
              onInput={(e) => {
                const el = e.currentTarget;
                setTitle(el.value.replace(/\n/g, ' '));
                el.style.height = 'auto';
                el.style.height = `${el.scrollHeight}px`;
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
            />
          </div>
          {(reminder || cur.reminderHistoryLabel) && (
            <div class="nx-reminder-chip-row">
              {reminder ? (
                <span class="nx-reminder-chip">
                  <button class="press" onClick={() => { save(); nav.open({ kind: 'reminder', taskId }); }}>
                    <Icon name="bell" size={14} />
                    {reminder}
                  </button>
                  <button class="x" aria-label="Clear reminder" onClick={() => void clearReminder(cur)}>
                    <Icon name="close" size={14} />
                  </button>
                </span>
              ) : (
                <span class="nx-reminder-was">Was: {cur.reminderHistoryLabel}</span>
              )}
            </div>
          )}
          <div class="nx-detail-divider" />
          <div ref={notesEl} class="nx-detail-notes" />
        </div>
        <div ref={toolbarEl} class="nx-toolbar" />
      </div>
    </div>
  );
}

function clearReminder(t: Task): Promise<void> {
  const label = formatReminderLabel(t.reminderTime, t.reminderDateOnly, t.reminderIntervalMinutes, t.reminderEndDate) ?? '';
  return updateTask({
    ...t,
    reminderTime: null,
    reminderDateOnly: false,
    reminderIntervalMinutes: 0,
    reminderEndDate: 0,
    reminderHistoryLabel: label
  });
}

export { EXIT };
