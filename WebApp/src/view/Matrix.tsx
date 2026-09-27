import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { haptic } from '../lib/haptics';
import * as nav from '../state/nav';
import { byPriority, importedByPriority, moveToPriority, setChecked, today } from '../state/store';
import { folderSummary } from '../import/folder';
import type { Priority, Task } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import { dueChipLabel, dueShortLabel, isOverdue } from '../calendar/deadline';
import { Icon } from './icons';
import { Checkbox, CountBadge } from './kit';
import { flip, measure } from './motion';
import { tour } from './tour-state';
import { matrixFocus } from './keynav';

/** Quadrant the dragged item is over (task drag or FAB drag). Drives the lift highlight. */
export const dropTarget = signal<Priority | null>(null);
/** Task currently being dragged across quadrants. */
export const draggingId = signal<number | null>(null);

const quadRects = new Map<Priority, DOMRect>();
/**
 * Where every row was after the last render, across all four quadrants, so a task that changes
 * priority glides from its old quadrant to the new one (motion.ts flip() flies it across) instead
 * of vanishing here and popping up there.
 */
const rowRects = new Map<string, DOMRect>();
export function measureQuadrants(): void {
  document.querySelectorAll<HTMLElement>('[data-quad]').forEach((el) => {
    quadRects.set(el.dataset.quad as Priority, el.getBoundingClientRect());
  });
}
export function quadrantAt(x: number, y: number): Priority | null {
  for (const [p, r] of quadRects) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return p;
  return null;
}
export function quadrantRect(p: Priority): DOMRect | undefined {
  return quadRects.get(p);
}

export function Matrix() {
  return (
    <main class="nx-matrix" id="nx-matrix">
      {PRIORITIES.map((p) => (
        <Quadrant key={p} priority={p} />
      ))}
    </main>
  );
}

function Quadrant({ priority }: { priority: Priority }) {
  const meta = PRIORITY_META[priority];
  const tasks = byPriority.value[priority];
  const folder = importedByPriority.value[priority];
  const open = tasks.filter((t) => !t.isCompleted && !t.isWontDo).length;
  const list = useRef<HTMLDivElement>(null);
  const ids = tasks.map((t) => `${t.id}:${t.isCompleted || t.isWontDo}`).join(',') + (folder.length ? '|folder' : '');
  // Compose animateItem(): rows glide to their new slot when order or membership changes. The
  // quadrant that loses a task runs first (tree order) and leaves its old rect in the shared map,
  // so the quadrant that gains it finds where it came from.
  useLayoutEffect(() => {
    flip(list.current, rowRects);
    for (const [k, r] of measure(list.current)) rowRects.set(k, r);
  }, [ids]);
  const isDrop = dropTarget.value === priority;
  // Keyboard highlight (view/keynav.ts): row index, the folder row counting as the last one.
  const f = matrixFocus.value;
  const focusIdx = f?.priority === priority ? Math.min(f.index, tasks.length + (folder.length ? 1 : 0) - 1) : -1;
  const openFull = () => {
    if (!tour.allows('EXPAND', priority)) return;
    if (nav.top.value) return; // something is already open on top of the matrix
    nav.open({ kind: 'full', priority });
  };
  return (
    <section
      class={`nx-quad ${isDrop ? 'drop' : ''}`}
      data-quad={priority}
      style={{ '--c': meta.color } as JSX.CSSProperties}
      aria-label={`${meta.label} priority`}
    >
      <div class="nx-quad-head" onClick={openFull} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && openFull()}>
        <span class="nx-glyph">{meta.glyph}</span>
        <span class="label">{meta.label}</span>
        <CountBadge count={open} color={meta.color} />
      </div>
      <div class="nx-quad-list" ref={list} onClick={(e) => e.target === e.currentTarget && openFull()}>
        {tasks.length === 0 && folder.length === 0 ? (
          <div class="nx-quad-empty">{isDrop ? 'Drop here' : 'No tasks'}</div>
        ) : (
          tasks.map((t, i) => <TaskRow key={t.id} task={t} focused={i === focusIdx} />)
        )}
        {folder.length > 0 && <FolderRow priority={priority} tasks={folder} focused={focusIdx === tasks.length} />}
      </div>
    </section>
  );
}

/** Scrolls a row into view when the keyboard highlight lands on it. */
function useFocusScroll(focused: boolean | undefined) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);
  return ref;
}

function TaskRow({ task, focused }: { task: Task; focused?: boolean }) {
  const meta = PRIORITY_META[task.priority];
  const done = task.isCompleted || task.isWontDo;
  const bar = task.isWontDo ? 'var(--nx-textTer)' : task.isPinned && !done ? 'var(--nx-accent)' : meta.color;
  const handlers = useTaskDrag(task);
  const ref = useFocusScroll(focused);
  return (
    <div
      ref={ref as { current: HTMLDivElement | null }}
      class={`nx-task ${done ? 'done' : ''} ${draggingId.value === task.id ? 'ghosted' : ''} ${focused ? 'focused' : ''}`}
      data-flip={String(task.id)}
      data-task={task.id}
      style={{ '--bar': bar } as JSX.CSSProperties}
      {...handlers}
    >
      <span class="bar" />
      <Checkbox
        checked={task.isCompleted}
        color={meta.color}
        dim={!task.isCompleted}
        onChange={(c) => void setChecked(task, c)}
      />
      <span class="title">{task.description}</span>
      <DueBadge task={task} />
      {task.isPinned && !done && <Icon name="pin" size={10} class="pin" />}
    </div>
  );
}

/**
 * Imported tasks that aren't due today wait here, one row per quadrant, so a 300-row sheet
 * doesn't bury what you typed. Tap to open the folder. Identical on Android.
 */
export function FolderRow({ priority, tasks, focused }: { priority: Priority; tasks: Task[]; focused?: boolean }) {
  const s = folderSummary(tasks, today.value);
  const ref = useFocusScroll(focused);
  const open = () => {
    if (!tour.allows('EXPAND', priority)) return;
    haptic('FAB_TAP');
    nav.open({ kind: 'full', priority, folder: true });
  };
  return (
    <button ref={ref as { current: HTMLButtonElement | null }} class={`nx-folder-row ${focused ? 'focused' : ''}`} data-flip={`folder:${priority}`} onClick={(e) => { e.stopPropagation(); open(); }} aria-label={`Imported: ${s.text}`}>
      <Icon name="folder" size={16} class="ic" />
      <span class="title">Imported</span>
      <span class="sub">{s.text}</span>
      <Icon name="chevronRight" size={16} class="chev" />
    </button>
  );
}

/** Small deadline badge on a row (red when late, accent when due today). */
export function DueBadge({ task }: { task: Task }) {
  const label = dueShortLabel(task);
  if (!label || task.isCompleted || task.isWontDo) return null;
  const late = isOverdue(task);
  const today = label === 'Today';
  return <span class={`nx-due-badge ${late ? 'late' : today ? 'today' : ''}`} title={dueChipLabel(task) ?? undefined}>{label}</span>;
}

// ─── Cross-quadrant drag (long-press on touch, press-and-move with a mouse) ─────

const LONG_PRESS_MS = 400;
const SLOP = 8;

function useTaskDrag(task: Task) {
  const st = useRef<{
    id: number;
    x: number;
    y: number;
    timer: number;
    active: boolean;
    ghost: HTMLElement | null;
    grabX: number;
    grabY: number;
    moved: boolean;
    mouse: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  const begin = () => {
    const s = st.current;
    if (!s || s.active) return;
    if (!tour.allows('DRAG')) return;
    s.active = true;
    haptic('DRAG_PICKUP');
    measureQuadrants();
    draggingId.value = task.id;
    dropTarget.value = task.priority;
    const ghost = document.createElement('div');
    ghost.className = s.mouse ? 'nx-ghost mouse' : 'nx-ghost';
    ghost.style.setProperty('--c', PRIORITY_META[task.priority].color);
    ghost.innerHTML = `<span class="bar"></span><span></span>`;
    (ghost.lastChild as HTMLElement).textContent = task.description;
    document.getElementById('app')!.appendChild(ghost);
    s.ghost = ghost;
    if (s.mouse) {
      // The ghost is much narrower than a desktop row: keep the grab point inside it so the
      // card stays under the cursor wherever the row was picked up.
      const g = ghost.getBoundingClientRect();
      s.grabX = Math.min(Math.max(s.grabX, 18), g.width - 18);
      s.grabY = Math.min(Math.max(s.grabY, 8), g.height - 8);
    }
    // Zoom in around the grab point.
    ghost.style.setProperty('--gx', `${s.grabX}px`);
    ghost.style.setProperty('--gy', `${s.grabY}px`);
    place(s.x, s.y);
    // Animate `scale` (not `transform`) so the ghost keeps following the pointer meanwhile.
    ghost.animate([{ scale: '0.9', opacity: 0.4 }, { scale: '1', opacity: 1 }], {
      duration: 160,
      easing: 'cubic-bezier(0.34,1.56,0.64,1)'
    });
  };

  const place = (x: number, y: number) => {
    const s = st.current;
    if (!s?.ghost) return;
    // The `translate` property is applied outside `scale`, so the pick-up zoom never shifts
    // the ghost away from the pointer (a scaled `transform: translate` would).
    s.ghost.style.translate = `${x - s.grabX}px ${y - s.grabY}px`;
  };

  const end = (commit: boolean) => {
    const s = st.current;
    if (!s) return;
    clearTimeout(s.timer);
    if (s.active) {
      suppressClick.current = true;
      const target = commit ? quadrantAt(s.x, s.y) : null;
      s.ghost?.remove();
      draggingId.value = null;
      dropTarget.value = null;
      if (target && target !== task.priority) {
        haptic('DRAG_DROP');
        void moveToPriority(task, target);
      }
    }
    st.current = null;
  };

  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return;
      const el = e.currentTarget as HTMLElement;
      const r = el.getBoundingClientRect();
      const mouse = e.pointerType === 'mouse';
      st.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        timer: 0,
        active: false,
        ghost: null,
        // Touch: ghost sits up-left of the finger so it stays visible (Android: -90, -22).
        grabX: mouse ? e.clientX - r.left : 90,
        grabY: mouse ? e.clientY - r.top : 22,
        moved: false,
        mouse
      };
      suppressClick.current = false;
      if (!mouse) st.current.timer = window.setTimeout(() => {
        begin();
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      const s = st.current;
      if (!s || e.pointerId !== s.id) return;
      const dist = Math.hypot(e.clientX - s.x, e.clientY - s.y);
      if (!s.active) {
        if (s.mouse && dist > 6) {
          begin();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } else if (!s.mouse && dist > SLOP) {
          clearTimeout(s.timer); // it's a scroll
          st.current = null;
        }
        return;
      }
      e.preventDefault();
      s.x = e.clientX;
      s.y = e.clientY;
      place(s.x, s.y);
      const q = quadrantAt(s.x, s.y);
      if (q && q !== dropTarget.value) haptic('DRAG_TICK');
      if (q !== dropTarget.value) dropTarget.value = q;
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    onContextMenu: (e: Event) => e.preventDefault(),
    onClick: () => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      if (!tour.allows('OPEN')) return;
      nav.open({ kind: 'detail', taskId: task.id });
    }
  };
}

/** While anything is being dragged, stop the browser from turning the gesture into a scroll. */
export const fabDragging = signal(false);
if (typeof document !== 'undefined') {
  document.addEventListener(
    'touchmove',
    (e) => {
      if (draggingId.value !== null || fabDragging.value) e.preventDefault();
    },
    { passive: false }
  );
}
