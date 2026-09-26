import type { JSX } from 'preact';
import { dueChipLabel, isOverdue } from '../calendar/deadline';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/haptics';
import { formatReminderLabel } from '../reminder-label';
import { patchSettings, settingsSig } from '../settings/store';
import * as nav from '../state/nav';
import { allTasks, applyOrder, archiveTasks, byPriority, deleteTasks, importedByPriority, moveToPriority, purgeExpired, restoreTasks, setChecked, today, tomorrow, unarchiveTasks } from '../state/store';
import { folderGroups } from '../import/folder';
import { FolderRow } from './Matrix';
import { offerUndo, showSnack } from '../state/toasts';
import type { Priority, Task } from '../types';
import { PRIORITY_META } from '../types';
import { Icon } from './icons';
import { Checkbox, CountBadge, Dialog, IconButton, Menu, Slider, TextButton } from './kit';
import { EXIT, flip, measure, play, SPRING_ENTER, SPRING_MOVE, STANDARD, useEnterExit } from './motion';
import { tour } from './tour-state';
import { listShareDoc } from '../share/doc';
import { sharePayloadFromDoc } from '../share/export';

export function FullScreenQuadrant({ priority, folder, leaving, onExited }: {
  priority: Priority;
  /** The quadrant's Imported folder instead of the quadrant itself. */
  folder?: boolean;
  leaving: boolean;
  onExited: () => void;
}) {
  const meta = PRIORITY_META[priority];
  const imported = importedByPriority.value[priority];
  const all = folder ? imported : byPriority.value[priority];
  const open = all.filter((t) => !t.isCompleted && !t.isWontDo);
  const wontDo = all.filter((t) => t.isWontDo);
  const completed = all.filter((t) => t.isCompleted);
  const root = useRef<HTMLDivElement>(null);
  const listEl = useRef<HTMLDivElement>(null);
  const before = useRef(new Map<string, DOMRect>());
  const [confirm, setConfirm] = useState<{ label: string; tasks: Task[] } | null>(null);
  const [retentionOpen, setRetentionOpen] = useState(false);
  // Bumped when a section opens or closes so the rows below glide instead of jumping.
  const [layoutTick, setLayoutTick] = useState(0);
  const relayout = () => setLayoutTick((t) => t + 1);

  useEnterExit(
    root,
    leaving,
    onExited,
    [{ transform: 'translateY(100%)', opacity: 0.6 }, { transform: 'none', opacity: 1 }],
    [{ transform: 'none', opacity: 1 }, { transform: 'translateY(100%)', opacity: 0 }],
    SPRING_ENTER,
    { duration: 260, easing: STANDARD }
  );

  const key = all.map((t) => `${t.id}:${t.isCompleted}:${t.isWontDo}:${t.position}`).join(',');
  useLayoutEffect(() => {
    flip(listEl.current, before.current);
    before.current = measure(listEl.current);
  }, [key, layoutTick]);

  // A task moved to another priority from inside this page (detail sheet, Alt+1–4) leaves the
  // list: say where it went and offer the way back, so the page never silently loses a row.
  const seen = useRef<Map<number, Task>>(new Map());
  useLayoutEffect(() => {
    const now = new Map(all.map((t) => [t.id, t] as const));
    if (!folder && !leaving) {
      for (const [id, was] of seen.current) {
        if (now.has(id)) continue;
        const t = allTasks.value.find((x) => x.id === id);
        if (!t || t.deletedAt !== 0 || t.archivedAt !== 0 || t.priority === priority) continue;
        const dest = PRIORITY_META[t.priority].label;
        showSnack(`Moved to ${dest}`, { label: 'Undo', run: () => void moveToPriority(t, was.priority) }, 5000);
      }
    }
    seen.current = now;
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
    const title = folder ? `Imported · ${meta.label} priority` : `${meta.label} priority`;
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
        <h1>{folder ? 'Imported' : meta.label}</h1>
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
        {folder ? (
          <FolderList tasks={all} onToggled={relayout} />
        ) : (
          <>
            <ReorderList tasks={open} scroller={listEl} />
            {imported.length > 0 && <div class="nx-fs-folder" data-flip="folder"><FolderRow priority={priority} tasks={imported} /></div>}
          </>
        )}
        {!folder && wontDo.length > 0 && (
          <Section
            label="WON'T DO"
            color="var(--nx-textSec)"
            tasks={wontDo}
            onArchiveAll={() => archiveMany(wontDo, "won't-do tasks")}
            onDeleteAll={() => setConfirm({ label: "won't-do tasks", tasks: wontDo })}
            onRetention={() => setRetentionOpen(true)}
            onToggled={relayout}
          />
        )}
        {!folder && completed.length > 0 && (
          <Section
            label="COMPLETED"
            color={meta.color}
            tasks={completed}
            tourAnchor
            onArchiveAll={() => archiveMany(completed, 'completed tasks')}
            onDeleteAll={() => setConfirm({ label: 'completed tasks', tasks: completed })}
            onRetention={() => setRetentionOpen(true)}
            onToggled={relayout}
          />
        )}
        <div style={{ height: 96 }} />
      </div>
      {!folder && <button
        class="nx-fab small"
        style={{ background: meta.color, color: 'var(--nx-bg)' }}
        aria-label={`Add ${meta.label} task`}
        onClick={() => {
          haptic('FAB_TAP');
          nav.open({ kind: 'add', priority, locked: true });
        }}
      >
        <Icon name="add" size={24} />
      </button>}

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

/**
 * Group collapse: rows fade up and out (staggered) before they unmount, then the parent's FLIP
 * glides everything below into place; expanding lets the FLIP pop the rows back in.
 */
function useCollapse(closed: boolean, setClosed: (v: boolean) => void, onToggled: () => void) {
  const rows = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  return {
    rows,
    toggle: () => {
      if (busy.current) return;
      if (closed) {
        setClosed(false);
        onToggled();
        return;
      }
      const els = Array.from(rows.current?.querySelectorAll<HTMLElement>('[data-flip]') ?? []);
      let pending = 0;
      const done = () => {
        if (--pending > 0) return;
        busy.current = false;
        setClosed(true);
        onToggled();
      };
      els.forEach((el, i) => {
        const a = play(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }], { ...EXIT, delay: Math.min(i, 6) * 14 }, 'collapse');
        if (!a) return;
        pending++;
        a.onfinish = done;
      });
      if (!pending) {
        setClosed(true);
        onToggled();
      } else busy.current = true;
    }
  };
}

/** The Imported folder: grouped by day (Missed, Tomorrow, then each date), no reordering. */
function FolderList({ tasks, onToggled }: { tasks: Task[]; onToggled: () => void }) {
  const groups = folderGroups(tasks, today.value, tomorrow.value);
  const [shut, setShut] = useState<Record<string, boolean>>({ missed: true, done: true });
  if (!groups.length) return null;
  return (
    <>
      <p class="nx-folder-note">Imported tasks wait here and move onto the matrix on their day. Their reminders ring either way. Pin one to keep it on the matrix.</p>
      {groups.map((g) => (
        <FolderGroup key={g.key} group={g} closed={shut[g.key] ?? false} setClosed={(v) => setShut((s) => ({ ...s, [g.key]: v }))} onToggled={onToggled} />
      ))}
    </>
  );
}

function FolderGroup({ group: g, closed, setClosed, onToggled }: {
  group: ReturnType<typeof folderGroups>[number];
  closed: boolean;
  setClosed: (v: boolean) => void;
  onToggled: () => void;
}) {
  const color = g.tone === 'late' ? '#FF4060' : g.tone === 'next' ? 'var(--c)' : 'var(--nx-textSec)';
  const { rows, toggle } = useCollapse(closed, setClosed, onToggled);
  return (
    <div class="nx-folder-group">
      <button class="nx-section nx-folder-head" aria-expanded={!closed} onClick={toggle}>
        <span class="chev"><Icon name="expandMore" size={18} color={color} style={{ transform: closed ? 'rotate(-90deg)' : 'none', transition: 'transform var(--dur-snappy) var(--spring-snappy)' }} /></span>
        <span class="lbl" style={{ color }}>{g.label.toUpperCase()}</span>
        <CountBadge count={g.tasks.length} color={color} />
      </button>
      {!closed && <div ref={rows} class="nx-section-rows">{g.tasks.map((t) => <SwipeRow key={t.id} task={t} />)}</div>}
    </div>
  );
}

function Section({ label, color, tasks, onArchiveAll, onDeleteAll, onRetention, tourAnchor, onToggled }: {
  label: string;
  color: string;
  tasks: Task[];
  onArchiveAll: () => void;
  onDeleteAll: () => void;
  onRetention: () => void;
  tourAnchor?: boolean;
  onToggled: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { rows, toggle } = useCollapse(collapsed, setCollapsed, onToggled);
  const days = settingsSig.value.retentionDays;
  return (
    <>
      <div class="nx-section" data-tour={tourAnchor ? 'retention' : undefined}>
        <button class="chev" aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={toggle}>
          <Icon name="expandMore" size={18} color={color} style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform var(--dur-snappy) var(--spring-snappy)' }} />
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
      {!collapsed && <div ref={rows} class="nx-section-rows">{tasks.map((t) => <SwipeRow key={t.id} task={t} />)}</div>}
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
    // Off-screen (delete) is a quick ease-out; back to rest springs.
    const a = play(el, [{ transform: from }, { transform: `translateX(${to}px)` }], to ? { duration: 200, easing: STANDARD, fill: 'none' } : { ...SPRING_MOVE, fill: 'none' }, 'settle');
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
