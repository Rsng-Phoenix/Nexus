import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { haptic } from '../lib/haptics';
import { settingsSig, topBarGreeting } from '../settings/store';
import * as nav from '../state/nav';
import { runUndo, showSnack, snack, syncPill, UNDO_MS, undoToast } from '../state/toasts';
import { onSyncState } from '../sync/manager';
import type { Priority } from '../types';
import { Icon } from './icons';
import { play, SPRING_ENTER, SPRING_MOVE } from './motion';
import { fabDragging, dropTarget, measureQuadrants, quadrantAt } from './Matrix';
import { tour } from './tour-state';
import { isPc, isWide } from '../state/viewport';
import { closeMiniWindow, miniOpen, miniSupported, openMiniWindow } from './MiniWindow';

/** Computers have no + button: this shows the Enter shortcut and works with a click too. */
function NewTaskButton() {
  return (
    <button
      class="nx-newtask press"
      data-tour="fab"
      onClick={() => {
        if (!tour.allows('ADD')) return;
        nav.open({ kind: 'pick' });
      }}
      title="New task (Enter)"
    >
      <Icon name="add" size={18} />
      <span>New task</span>
      <kbd>⏎</kbd>
    </button>
  );
}

export const syncing = signal(false);
export const syncGlow = signal<'idle' | 'success' | 'error'>('idle');
let glowTimer = 0;
onSyncState((busy, result) => {
  syncing.value = busy;
  if (!busy && result && result.message) {
    clearTimeout(glowTimer);
    syncGlow.value = result.ok ? 'success' : 'error';
    glowTimer = window.setTimeout(() => (syncGlow.value = 'idle'), 2800);
  }
});

export function TopBar({ onBrand }: { onBrand: () => void }) {
  return (
    <header class="nx-topbar">
      <div class="nx-brand press" data-tour="brand" onClick={onBrand} role="button" tabIndex={0} aria-label="About Nexus">
        <b>NEXUS</b>
        <small>priority matrix</small>
      </div>
      <div class="grow" />
      <button class="nx-topbtn press" data-tour="calendar" aria-label="Calendar" title="Calendar (C)" onClick={() => nav.open({ kind: 'calendar' })}>
        <Icon name="calendar" size={20} />
      </button>
      {isWide.value && miniSupported() && (
        <button
          class={`nx-topbtn press ${miniOpen.value ? 'on' : ''}`}
          aria-label={miniOpen.value ? 'Close mini window' : 'Open mini window (always on top)'}
          title="Mini window — stays on top of other apps (M)"
          onClick={() => {
            if (miniOpen.value) closeMiniWindow();
            else void openMiniWindow().then((ok) => !ok && showSnack("This browser couldn't open the mini window. Try Chrome, Edge or Brave."));
          }}
        >
          <Icon name="pip" size={20} />
        </button>
      )}
      {isPc.value && <NewTaskButton />}
      <ProfileChip />
    </header>
  );
}

export function initialOf(name: string, email: string): string {
  const fromName = name.split('').find((c) => /\p{L}/u.test(c));
  if (fromName) return fromName.toUpperCase();
  const fromEmail = email.split('').find((c) => /[\p{L}\p{N}]/u.test(c));
  return fromEmail ? fromEmail.toUpperCase() : 'U';
}

export function Avatar({ size = 22, ring = false }: { size?: number; ring?: boolean }) {
  const s = settingsSig.value;
  return (
    <span class="nx-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}>
      {s.googlePhotoUrl ? (
        <img src={s.googlePhotoUrl} alt="" referrerpolicy="no-referrer" />
      ) : (
        initialOf(s.displayName, s.googleEmail)
      )}
      {ring && <span class="ring" />}
    </span>
  );
}

function ProfileChip() {
  const greeting = topBarGreeting();
  settingsSig.value; // re-render on name changes
  const compact = greeting.length > 14;
  const glow = syncGlow.value;
  return (
    <button
      class={`nx-chip press clickable ${compact ? 'compact' : ''} ${glow !== 'idle' ? `glow-${glow}` : ''}`}
      data-tour="profile"
      onClick={() => {
        if (!tour.allows('PROFILE')) return;
        nav.open({ kind: 'profile' });
      }}
      aria-label="Profile and sync"
    >
      <Avatar size={compact ? 20 : 22} ring={syncing.value} />
      <span class="greet">{greeting}</span>
    </button>
  );
}

/** + button: tap to add, or drag it into a quadrant (with a cancel zone where it started). */
export function Fab({ onAdd }: { onAdd: (p: Priority) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const st = useRef<{ x: number; y: number; id: number; active: boolean } | null>(null);
  const home = useRef<DOMRect | null>(null);

  const reset = () => {
    const el = ref.current;
    if (!el) return;
    const from = el.style.transform;
    el.style.transform = '';
    if (from) play(el, [{ transform: from }, { transform: 'none' }], { ...SPRING_MOVE, fill: 'none' }, 'home');
  };

  return (
    <>
      {fabDragging.value && (
        <div class="nx-fab-cancel" aria-hidden="true">
          <Icon name="close" size={22} />
        </div>
      )}
      <button
        ref={ref}
        class={`nx-fab ${fabDragging.value ? 'dragging' : ''}`}
        data-tour="fab"
        aria-label="Add task"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          st.current = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false };
          home.current = ref.current!.getBoundingClientRect();
          ref.current!.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const s = st.current;
          if (!s || e.pointerId !== s.id) return;
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          if (!s.active) {
            if (Math.hypot(dx, dy) < 8 || !tour.allows('ADD')) return;
            s.active = true;
            fabDragging.value = true;
            measureQuadrants();
            haptic('FAB_TAP');
          }
          ref.current!.style.transform = `translate(${dx}px, ${dy}px) scale(1.06)`;
          const q = quadrantAt(e.clientX, e.clientY);
          if (q !== dropTarget.value) {
            if (q) haptic('FAB_QUADRANT');
            dropTarget.value = q;
          }
        }}
        onPointerUp={(e) => {
          const s = st.current;
          st.current = null;
          if (!s) return;
          if (!s.active) {
            if (!tour.allows('ADD')) return;
            haptic('FAB_TAP');
            onAdd('HIGH');
            return;
          }
          const q = quadrantAt(e.clientX, e.clientY);
          const h = home.current;
          const inCancel = h && e.clientX >= h.left && e.clientX <= h.right && e.clientY >= h.top && e.clientY <= h.bottom;
          fabDragging.value = false;
          dropTarget.value = null;
          reset();
          if (q && !inCancel) onAdd(q);
        }}
        onPointerCancel={() => {
          st.current = null;
          fabDragging.value = false;
          dropTarget.value = null;
          reset();
        }}
      >
        <Icon name="add" size={24} />
      </button>
    </>
  );
}

export function Toasts() {
  const u = undoToast.value;
  const s = snack.value;
  return (
    <div class="nx-toast-stack" aria-live="polite">
      {s && <SnackView key={s.id} message={s.message} action={s.action} />}
      {u && <UndoPill key={u.id} message={u.message} />}
      {syncPill.value && !u && <div class="nx-syncpill">{syncPill.value}</div>}
    </div>
  );
}

function UndoPill({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    play(ref.current, [{ opacity: 0, transform: 'translateY(16px) scale(0.96)' }, { opacity: 1, transform: 'none' }], SPRING_ENTER, 'presence');
    play(bar.current, [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: UNDO_MS, easing: 'linear' }, 'countdown');
  }, []);
  return (
    <div ref={ref} class="nx-undo" style={{ position: 'relative' }}>
      <span class="msg">{message}</span>
      <button onClick={runUndo}>
        <Icon name="undo" size={16} />
        Undo
      </button>
      <span ref={bar} class="bar" />
    </div>
  );
}

function SnackView({ message, action }: { message: string; action?: { label: string; run: () => void } }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    play(ref.current, [{ opacity: 0, transform: 'translateY(12px) scale(0.97)' }, { opacity: 1, transform: 'none' }], SPRING_ENTER, 'presence');
  }, []);
  return (
    <div ref={ref} class="nx-snack">
      <span>{message}</span>
      {action && (
        <button
          onClick={() => {
            snack.value = null;
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Pull down on the matrix to sync (no spinner, the profile chip ring shows progress). */
export function usePullToSync(el: { current: HTMLElement | null }, onPull: () => void) {
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let startY = -1;
    let armed = false;
    const down = (e: TouchEvent) => {
      const list = (e.target as HTMLElement).closest('.nx-quad-list') as HTMLElement | null;
      startY = !list || list.scrollTop <= 0 ? e.touches[0].clientY : -1;
      armed = false;
    };
    const move = (e: TouchEvent) => {
      if (startY < 0) return;
      const d = e.touches[0].clientY - startY;
      if (d > 90 && !armed) {
        armed = true;
        haptic('DRAG_TICK');
      }
      node.style.transform = d > 0 ? `translateY(${Math.min(40, d * 0.25)}px)` : '';
    };
    const up = () => {
      if (startY >= 0 && armed) onPull();
      startY = -1;
      if (node.style.transform) {
        const from = node.style.transform;
        node.style.transform = '';
        play(node, [{ transform: from }, { transform: 'none' }], { ...SPRING_MOVE, fill: 'none' }, 'pull');
      }
    };
    node.addEventListener('touchstart', down, { passive: true });
    node.addEventListener('touchmove', move, { passive: true });
    node.addEventListener('touchend', up);
    return () => {
      node.removeEventListener('touchstart', down);
      node.removeEventListener('touchmove', move);
      node.removeEventListener('touchend', up);
    };
  }, []);
}
