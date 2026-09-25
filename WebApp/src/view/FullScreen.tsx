import type { JSX } from 'preact';
import { dueChipLabel, isOverdue } from '../calendar/deadline';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/haptics';
import { formatReminderLabel } from '../reminder-label';
import { patchSettings, settingsSig } from '../settings/store';
import * as nav from '../state/nav';
import { applyOrder, archiveTasks, byPriority, deleteTasks, purgeExpired, restoreTasks, setChecked, unarchiveTasks } from '../state/store';
import { offerUndo } from '../state/toasts';
import type { Priority, Task } from '../types';
import { PRIORITY_META } from '../types';
import { Icon } from './icons';
import { Checkbox, CountBadge, Dialog, IconButton, Menu, Slider, TextButton } from './kit';
import { animate, BOUNCY, ENTER, flip, measure, STANDARD, useEnterExit } from './motion';
import { tour } from './tour-state';
import { listShareDoc } from '../share/doc';
import { sharePayloadFromDoc } from '../share/export';

export function FullScreenQuadrant({ priority, leaving, onExited }: {
  priority: Priority;
  leaving: boolean;
  onExited: () => void;
}) {
  const meta = PRIORITY_META[priority];
  const all = byPriority.value[priority];
  const open = all.filter((t) => !t.isCompleted && !t.isWontDo);
  const wontDo = all.filter((t) => t.isWontDo);
  const completed = all.filter((t) => t.isCompleted);
  const root = useRef<HTMLDivElement>(null);
  const listEl = useRef<HTMLDivElement>(null);
  const before = useRef(new Map<string, DOMRect>());
  const [confirm, setConfirm] = useState<{ label: string; tasks: Task[] } | null>(null);
  const [retentionOpen, setRetentionOpen] = useState(false);

  useEnterExit(
    root,
    leaving,
    onExited,
    [{ transform: 'translateY(100%)', opacity: 0.6 }, { transform: 'none', opacity: 1 }],
    [{ transform: 'none', opacity: 1 }, { transform: 'translateY(100%)', opacity: 0 }],
    ENTER,
    { duration: 260, easing: STANDARD }
  );

  const key = all.map((t) => `${t.id}:${t.isCompleted}:${t.isWontDo}:${t.position}`).join(',');
  useLayoutEffect(() => {
    flip(listEl.current, before.current);
    before.current = measure(listEl.current);
  }, [key]);

  const deleteMany = (tasks: Task[], label: string) => {
    const ids = tasks.map((t) => t.id);
    haptic('DELETE');
    void deleteTasks(ids);
    offerUndo(`${ids.length} ${label} deleted`, () => void restoreTasks(ids));
  };
  const archiveMany = (tasks: Task[], label: string) => {
    const ids = tasks.map((t) => t.id);
    void archiveTasks(ids);
    offerUndo(`${ids.length} ${label} archived`, () => void unarchiveTasks(ids));
  };
  const share = () => {
    const title = `${meta.label} priority`;
    nav.open({ kind: 'share', payload: sharePayloadFromDoc(listShareDoc(title, priority, open)) });
  };

  return (
    <>
    {/* Desktop only: a real backdrop, so clicks outside close the panel instead of reaching the matrix. */}
    <div class="nx-full-scrim" data-leaving={leaving || undefined} onClick={() => nav.back()} />
    <div ref={root} class="nx-full" style={{ '--c': meta.color } as JSX.CSSProperties} data-leaving={leaving || undefined}>
      <header class="nx-full-head">
        <IconButton icon="back" label="Back" onClick={() => nav.back()} />
        <span class="colorbar" />
        <h1>{meta.label}</h1>
        <CountBadge count={open.length} color={meta.color} />
        <span class="grow" />
        <IconButton icon="share" label="Share quadrant" onClick={share} />
      </header>
      <div class="nx-full-list" ref={listEl}>
        {all.length === 0 && (
          <div class="nx-all-clear">
            <span class="circle"><Icon name="check" size={28} color={meta.color} /></span>
            <b>All clear</b>
            <small>Tap + to add a {meta.label.toLowerCase()} priority task</small>
          </div>
        )}
        <ReorderList tasks={open} scroller={listEl} />
        {wontDo.length > 0 && (
          <Section
            label="WON'T DO"
            color="var(--nx-textSec)"
            tasks={wontDo}
            onArchiveAll={() => archiveMany(wontDo, "won't-do tasks")}
            onDeleteAll={() => setConfirm({ label: "won't-do tasks", tasks: wontDo })}
            onRetention={() => setRetentionOpen(true)}
          />
        )}
        {completed.length > 0 && (
          <Section
            label="COMPLETED"
            color={meta.color}
            tasks={completed}
            tourAnchor
            onArchiveAll={() => archiveMany(completed, 'completed tasks')}
            onDeleteAll={() => setConfirm({ label: 'completed tasks', tasks: completed })}
            onRetention={() => setRetentionOpen(true)}
          />
        )}
        <div style={{ height: 96 }} />
      </div>
      <button
        class="nx-fab small"
        style={{ background: meta.color, color: 'var(--nx-bg)' }}
        aria-label={`Add ${meta.label} task`}
        onClick={() => {
          haptic('FAB_TAP');
          nav.open({ kind: 'add', priority, locked: true });
        }}
      >
        <Icon name="add" size={24} />
      </button>

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm ? `Delete ${confirm.tasks.length} ${confirm.label}?` : ''}
        actions={
          <>
            <TextButton color="var(--nx-textSec)" onClick={() => setConfirm(null)}>Cancel</TextButton>
            <TextButton
              color="#FF4060"
              onClick={() => {
                if (confirm) deleteMany(confirm.tasks, confirm.label);
                setConfirm(null);
              }}
            >
              Delete
            </TextButton>
          </>
        }
      >
        Only {meta.label} tasks are affected. You can undo right away, or restore them from Settings → Recently deleted for{' '}
        {settingsSig.value.trashDays} days.
      </Dialog>
      <RetentionDialog open={retentionOpen} onClose={() => setRetentionOpen(false)} />
    </div>
    </>
  );
}

function Section({ label, color, tasks, onArchiveAll, onDeleteAll, onRetention, tourAnchor }: {
  label: string;
  color: string;
  tasks: Task[];
  onArchiveAll: () => void;
  onDeleteAll: () => void;
  onRetention: () => void;
  tourAnchor?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const days = settingsSig.value.retentionDays;
  return (
    <>
      <div class="nx-section" data-tour={tourAnchor ? 'retention' : undefined}>
        <button class="chev" aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={() => setCollapsed(!collapsed)}>
          <Icon name="expandMore" size={18} color={color} style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 220ms' }} />
        </button>
        <span class="lbl" style={{ color }}>{label}</span>
        <CountBadge count={tasks.length} color={color} />
        <button class="ret" onClick={onRetention}>· auto-delete in {days}d</button>
        <span class="grow" />
        <Menu
          trigger={(toggle) => <IconButton icon="moreHoriz" label="Section actions" size={20} onClick={toggle} />}
          items={[
            { label: 'Archive all', icon: 'archive', onSelect: onArchiveAll },
            { label: 'Delete all', icon: 'delete', danger: true, onSelect: onDeleteAll }
          ]}
        />
      </div>
      {!collapsed && tasks.map((t) => <SwipeRow key={t.id} task={t} />)}
    </>
  );
}

function RetentionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [days, setDays] = useState(settingsSig.value.retentionDays);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Auto-delete finished tasks"
      actions={
        <>
          <TextButton color="var(--nx-textSec)" onClick={onClose}>Cancel</TextButton>
          <TextButton
            onClick={() => {
              patchSettings({ retentionDays: days });
              void purgeExpired();
              onClose();
            }}
          >
            Save
          </TextButton>
        </>
      }
    >
      <p>Completed and won't-do tasks are deleted after <b style={{ color: 'var(--nx-textPri)' }}>{days} days</b>. Archived tasks are never auto-deleted.</p>
      <Slider value={days} min={1} max={90} label="Days" onInput={setDays} onCommit={setDays} />
    </Dialog>
  );
}

// ─── Reorder (long-press, or drag the handle with a mouse) ─────────────────────

function ReorderList({ tasks, scroller }: { tasks: Task[]; scroller: { current: HTMLElement | null } }) {
  const wrap = useRef<HTMLDivElement>(null);
  const st = useRef<{
    id: number;
    index: number;
    target: number;
    startY: number;
    y: number;
    startScroll: number;
    rects: DOMRect[];
    rows: HTMLElement[];
    raf: number;
  } | null>(null);

  const start = (index: number, y: number, pointerId: number, el: HTMLElement) => {
    const rows = Array.from(wrap.current!.querySelectorAll<HTMLElement>('[data-row]'));
    st.current = {
      id: pointerId,
      index,
      target: index,
      startY: y,
      y,
      startScroll: scroller.current!.scrollTop,
      rects: rows.map((r) => r.getBoundingClientRect()),
      rows,
      raf: 0
    };
    haptic('DRAG_PICKUP');
    rows[index].classList.add('lifted');
    try { el.setPointerCapture(pointerId); } catch { /* ignore */ }
    const tick = () => {
      const s = st.current;
      if (!s) return;
      // Auto-scroll when the finger is near the top/bottom edge of the list.
      const box = scroller.current!.getBoundingClientRect();
      const edge = 64;
      let v = 0;
      if (s.y < box.top + edge) v = -(box.top + edge - s.y) * 0.25;
      else if (s.y > box.bottom - edge) v = (s.y - (box.bottom - edge)) * 0.25;
      if (v) scroller.current!.scrollTop += v;
      layout();
      s.raf = requestAnimationFrame(tick);
    };
    st.current.raf = requestAnimationFrame(tick);
  };

  const layout = () => {
    const s = st.current;
    if (!s) return;
    const scrolled = scroller.current!.scrollTop - s.startScroll;
    const dy = s.y - s.startY + scrolled;
    const me = s.rects[s.index];
    const center = me.top + me.height / 2 + dy;
    let target = 0;
    s.rects.forEach((r, i) => {
      if (i !== s.index && r.top + r.height / 2 < center) target++;
    });
    if (target !== s.target) {
      s.target = target;
      haptic('DRAG_TICK');
    }
    const gap = 8;
    s.rows.forEach((row, i) => {
      if (i === s.index) {
        row.style.transform = `translateY(${dy}px) scale(1.02)`;
        return;
      }
      let shift = 0;
      if (s.index < s.target && i > s.index && i <= s.target) shift = -(me.height + gap);
      if (s.index > s.target && i < s.index && i >= s.target) shift = me.height + gap;
      row.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };

  const finish = () => {
    const s = st.current;
    if (!s) return;
    cancelAnimationFrame(s.raf);
    st.current = null;
    const ids = tasks.map((t) => t.id);
    const [moved] = ids.splice(s.index, 1);
    ids.splice(s.target, 0, moved);
    s.rows.forEach((r) => {
      r.style.transform = '';
      r.classList.remove('lifted');
    });
    if (s.target !== s.index) {
      haptic('DRAG_DROP');
      void applyOrder(ids); // one write, on drop
    }
  };

  return (
    <div ref={wrap} class="nx-reorder">
      {tasks.map((t, i) => (
        <SwipeRow
          key={t.id}
          task={t}
          reorder={{
            begin: (y, pid, el) => start(i, y, pid, el),
            move: (y) => {
              if (st.current) st.current.y = y;
            },
            end: finish,
            active: () => !!st.current
          }}
        />
      ))}
    </div>
  );
}

type ReorderHooks = {
  begin: (y: number, pointerId: number, el: HTMLElement) => void;
  move: (y: number) => void;
  end: () => void;
  active: () => boolean;
};

// ─── Swipe row: right = complete, left = delete (35% threshold) ────────────────

function SwipeRow({ task, reorder }: { task: Task; reorder?: ReorderHooks }) {
  const meta = PRIORITY_META[task.priority];
  const done = task.isCompleted || task.isWontDo;
  const row = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  const st = useRef<{ x: number; y: number; id: number; axis: 'x' | 'y' | null; dx: number; timer: number; reordering: boolean; mouse: boolean } | null>(null);
  const suppressClick = useRef(false);
  const reminder = formatReminderLabel(task.reminderTime, task.reminderDateOnly, task.reminderIntervalMinutes, task.reminderEndDate);
  const due = done ? null : dueChipLabel(task);

  const settle = (to: number, after?: () => void) => {
    const el = card.current!;
    const from = el.style.transform || 'translateX(0)';
    el.style.transform = to ? `translateX(${to}px)` : '';
    const a = animate(el, [{ transform: from }, { transform: `translateX(${to}px)` }], {
      duration: to ? 200 : 320,
      easing: to ? STANDARD : BOUNCY,
      fill: 'none'
    });
    if (a && after) a.onfinish = after;
    else after?.();
    if (!to && bg.current) bg.current.style.opacity = '0';
  };

  const paintBg = (dx: number, width: number) => {
    const b = bg.current;
    if (!b) return;
    const p = Math.min(1, Math.abs(dx) / (width * 0.35));
    b.style.opacity = dx === 0 ? '0' : '1';
    b.dataset.dir = dx > 0 ? 'right' : 'left';
    b.style.setProperty('--a', `${12 + p * 20}%`);
    b.style.setProperty('--s', String(0.8 + p * 0.4));
  };

  return (
    <div
      ref={row}
      class={`nx-fs-row ${done ? 'done' : ''}`}
      data-row={reorder ? '' : undefined}
      data-flip={String(task.id)}
      style={{ '--c': meta.color } as JSX.CSSProperties}
    >
      <div ref={bg} class="nx-swipe-bg">
        <span class="ic right"><Icon name="check" size={22} /></span>
        <span class="ic left"><Icon name="delete" size={22} /></span>
      </div>
      <div
        ref={card}
        class="nx-fs-card press-soft"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const mouse = e.pointerType === 'mouse';
          const el = e.currentTarget as HTMLElement;
          st.current = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: null, dx: 0, timer: 0, reordering: false, mouse };
          suppressClick.current = false;
          const onHandle = !!(e.target as HTMLElement).closest('.handle');
          if (reorder && (onHandle && mouse)) {
            st.current.reordering = true;
            reorder.begin(e.clientY, e.pointerId, el);
          } else if (reorder) {
            st.current.timer = window.setTimeout(() => {
              if (st.current && !st.current.axis) {
                st.current.reordering = true;
                reorder.begin(st.current.y, e.pointerId, el);
              }
            }, 400);
          }
        }}
        onPointerMove={(e) => {
          const s = st.current;
          if (!s || s.id !== e.pointerId) return;
          if (s.reordering) {
            e.preventDefault();
            reorder?.move(e.clientY);
            return;
          }
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          if (!s.axis) {
            if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
            clearTimeout(s.timer);
            s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
            if (s.axis === 'x') (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }
          if (s.axis !== 'x') return;
          s.dx = dx;
          card.current!.style.transform = `translateX(${dx}px)`;
          paintBg(dx, card.current!.offsetWidth);
        }}
        onPointerUp={() => {
          const s = st.current;
          st.current = null;
          if (!s) return;
          clearTimeout(s.timer);
          if (s.reordering) {
            suppressClick.current = true;
            reorder?.end();
            return;
          }
          if (s.axis !== 'x') return;
          suppressClick.current = true;
          const w = card.current!.offsetWidth;
          if (s.dx > w * 0.35) {
            // Complete, then snap back (the row moves to Completed).
            settle(0);
            void setChecked(task, !task.isCompleted);
            if (tour.allows('SWIPE')) { /* tour watches task state */ }
          } else if (s.dx < -w * 0.35) {
            haptic('DELETE');
            settle(-w - 40, () => {
              const ids = [task.id];
              void deleteTasks(ids);
              offerUndo('Task deleted', () => void restoreTasks(ids));
            });
          } else settle(0);
        }}
        onPointerCancel={() => {
          const s = st.current;
          st.current = null;
          if (s) clearTimeout(s.timer);
          if (s?.reordering) reorder?.end();
          else settle(0);
        }}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          nav.open({ kind: 'detail', taskId: task.id });
        }}
      >
        <span class="bar" style={{ background: task.isWontDo ? 'var(--nx-textTer)' : task.isPinned && !done ? 'var(--nx-accent)' : meta.color }} />
        <Checkbox checked={task.isCompleted} color={meta.color} size={34} dim={!task.isCompleted} onChange={(c) => void setChecked(task, c)} />
        <span class="txt">
          <span class="t">{task.description}</span>
          {(reminder || due) && (
            <span class="r">
              {due && <span class={`d ${isOverdue(task) ? 'late' : ''}`}><Icon name="calendar" size={10} /> {due}</span>}
              {reminder && <span><Icon name="bell" size={10} /> {reminder}</span>}
            </span>
          )}
        </span>
        {task.isPinned && !done && <Icon name="pin" size={14} color="var(--nx-accent)" />}
        {reorder && <span class="handle" aria-hidden="true"><Icon name="drag" size={16} /></span>}
      </div>
    </div>
  );
}
