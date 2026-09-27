import { useLayoutEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';
import { getSettings, subscribeSettings } from '../settings/store';

// Compose specs from NexusMotion, converted to CSS timing. Only transform/opacity ever animate.
/** spring(dampingRatio 1.0, stiffness 400): critically damped, no overshoot. */
export const ENTER = { easing: 'cubic-bezier(0.2, 0, 0, 1)', duration: 340 };
/** Leaving the screen: FastOutLinearIn, quick (§4.7). */
export const EXIT = { easing: 'cubic-bezier(0.4, 0, 1, 1)', duration: 160 };
/** FastOutSlowIn. */
export const STANDARD = 'cubic-bezier(0.4, 0, 0.2, 1)';
/** spring(0.5, 1500): quick and a little bouncy (press, lift, pills). */
export const BOUNCY = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

// ─── Springs (docs/premium-desk-architecture.md §4.7) ───────────────────────────

/** How many points the `linear()` easing carries. */
export const SPRING_SAMPLES = 48;
/** The spring counts as settled once it stays within this distance of the target (0.1 %). */
export const SPRING_SETTLE = 0.001;
/** No spring runs longer than this, however soft it is. */
export const SPRING_MAX_MS = 800;

export type Spring = { easing: string; duration: number };

/**
 * Position of a damped spring released from 1 towards 0 at time [t] (seconds), closed form.
 *   ζ = c / (2√(k·m)), ω0 = √(k/m)
 *   ζ < 1: x(t) = e^(−ζω0t) (cos ωd t + (ζω0/ωd) sin ωd t), ωd = ω0 √(1−ζ²)
 *   ζ = 1: x(t) = e^(−ω0t) (1 + ω0 t)
 *   ζ > 1: x(t) = e^(−ζω0t) (cosh ωd t + (ζω0/ωd) sinh ωd t), ωd = ω0 √(ζ²−1)
 */
export function springPosition(t: number, stiffness: number, damping: number, mass = 1): number {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const decay = Math.exp(-zeta * w0 * t);
  if (Math.abs(zeta - 1) < 1e-6) return decay * (1 + w0 * t);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return decay * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  const wd = w0 * Math.sqrt(zeta * zeta - 1);
  return decay * (Math.cosh(wd * t) + ((zeta * w0) / wd) * Math.sinh(wd * t));
}

/**
 * A CSS `linear()` easing sampled from a damped spring, plus how long it takes to settle to
 * 0.1 % (capped at 800 ms). easing = 1 − x(t), so it starts at 0 and ends exactly at 1.
 */
export function spring(stiffness = 438, damping = 38, mass = 1): Spring {
  // Settle time: the last millisecond the spring is still more than 0.1 % away from rest.
  let last = 0;
  for (let ms = SPRING_MAX_MS; ms > 0; ms--) {
    if (Math.abs(springPosition(ms / 1000, stiffness, damping, mass)) > SPRING_SETTLE) {
      last = ms;
      break;
    }
  }
  const duration = Math.min(SPRING_MAX_MS, Math.max(1, last + 1));
  const pts: string[] = [];
  for (let i = 0; i < SPRING_SAMPLES; i++) {
    const t = (i / (SPRING_SAMPLES - 1)) * (duration / 1000);
    const v = i === SPRING_SAMPLES - 1 ? 1 : 1 - springPosition(t, stiffness, damping, mass);
    pts.push(String(Math.round(v * 10000) / 10000));
  }
  return { easing: `linear(${pts.join(', ')})`, duration };
}

/** Things entering the screen: ≈ Apple duration 0.30 s, bounce 0.10. */
export const SPRING_ENTER = spring(438, 38);
/** FLIP / reorders / month swipe: ≈ 0.35 s, bounce 0.15. */
export const SPRING_MOVE = spring(322, 30);
/** Pills, checkbox, tabs, press: ≈ 0.25 s, bounce 0.15. */
export const SPRING_SNAPPY = spring(630, 45);

/** Fades under reduced motion never run longer than this. */
export const REDUCED_MAX_MS = 80;

/** OS preference or the Appearance → Motion setting. */
export const reducedMotion = () =>
  (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) ||
  getSettings().motion === 'reduced';

/** Under reduced motion only opacity moves: drop every transform from the keyframes. */
function fadeOnly(frames: Keyframe[]): Keyframe[] {
  return frames.map((f) => {
    const { transform: _t, translate: _tr, scale: _s, rotate: _r, ...rest } = f as Keyframe & {
      translate?: unknown;
      scale?: unknown;
      rotate?: unknown;
    };
    return rest;
  });
}

export function animate(
  el: Element | null | undefined,
  frames: Keyframe[],
  opts: KeyframeAnimationOptions
): Animation | null {
  if (!el || typeof (el as HTMLElement).animate !== 'function') return null;
  if (reducedMotion()) {
    frames = fadeOnly(frames);
    opts = { ...opts, duration: Math.min(Number(opts.duration ?? 0), REDUCED_MAX_MS) };
  }
  return (el as HTMLElement).animate(frames, { fill: 'both', ...opts });
}

// Running animations per element and key, so a new one can cancel the one it replaces.
const running = new WeakMap<Element, Map<string, Animation>>();
// The element's own will-change, put back once its last animation ends.
const restWillChange = new WeakMap<Element, string>();

/**
 * Interruptible animate(): cancels the animation started earlier with the same [key] on [el]
 * (a hide in flight is replaced by the show, a second tap restarts the pop), sets `will-change`
 * only while it runs, and under reduced motion plays an ≤ 80 ms fade instead.
 */
export function play(
  el: Element | null | undefined,
  frames: Keyframe[],
  opts: KeyframeAnimationOptions,
  key = 'default'
): Animation | null {
  if (!el || typeof (el as HTMLElement).animate !== 'function') return null;
  const node = el as HTMLElement;
  let byKey = running.get(el);
  if (!byKey) running.set(el, (byKey = new Map()));
  byKey.get(key)?.cancel();
  if (reducedMotion()) {
    frames = fadeOnly(frames);
    opts = { ...opts, duration: Math.min(Number(opts.duration ?? 0), REDUCED_MAX_MS), composite: 'replace' };
  }
  const a = node.animate(frames, { fill: 'both', ...opts });
  if (node.style && byKey.size === 0) {
    restWillChange.set(el, node.style.willChange);
    node.style.willChange = 'transform, opacity';
  }
  byKey.set(key, a);
  const done = () => {
    if (byKey!.get(key) !== a) return;
    byKey!.delete(key);
    if (node.style && byKey!.size === 0) node.style.willChange = restWillChange.get(el) ?? '';
  };
  a.addEventListener?.('finish', done);
  a.addEventListener?.('cancel', done);
  return a;
}

/**
 * Plays [enter] on mount, and [exit] when `leaving` flips to true, then calls onExited.
 * Content stays mounted during the exit, like Compose AnimatedVisibility.
 */
export function useEnterExit(
  ref: RefObject<HTMLElement>,
  leaving: boolean,
  onExited: () => void,
  enter: Keyframe[],
  exit: Keyframe[],
  enterOpts: KeyframeAnimationOptions = ENTER,
  exitOpts: KeyframeAnimationOptions = EXIT
): void {
  const done = useRef(false);
  useLayoutEffect(() => {
    play(ref.current, enter, enterOpts, 'presence');
  }, []);
  useLayoutEffect(() => {
    if (!leaving || done.current) return;
    done.current = true;
    const a = play(ref.current, exit, exitOpts, 'presence');
    if (!a) onExited();
    else a.onfinish = () => onExited();
  }, [leaving]);
}

/** `composite: 'add'` lets a FLIP translate coexist with a CSS press-scale (Safari 16+, Chrome 84+). */
const supportsComposite = () =>
  typeof KeyframeEffect !== 'undefined' && 'composite' in KeyframeEffect.prototype;

/** How far a row is allowed to travel and still count as a move inside the same list. */
const flipMoveOpts = (): KeyframeAnimationOptions => ({
  ...SPRING_MOVE,
  fill: 'none',
  ...(supportsComposite() ? { composite: 'add' as CompositeOperation } : {})
});

/**
 * FLIP: animate elements from their previous rect to the new one (list reorders, moves).
 * When [prev] holds rects from other containers too (the matrix measures every quadrant into
 * one map), a row that came from outside [container] flies across the screen instead of
 * popping in: a fixed clone travels from the old rect while the real row fades in underneath.
 */
export function flip(container: HTMLElement | null, prev: Map<string, DOMRect>): void {
  if (!container || reducedMotion()) return;
  const bounds = container.getBoundingClientRect();
  container.querySelectorAll<HTMLElement>('[data-flip]').forEach((el) => {
    const key = el.dataset.flip!;
    const before = prev.get(key);
    if (!before) {
      play(el, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { ...SPRING_ENTER, fill: 'none' }, 'flip');
      return;
    }
    const now = el.getBoundingClientRect();
    const dx = before.left - now.left;
    const dy = before.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    const inside = before.right > bounds.left && before.left < bounds.right && before.bottom > bounds.top && before.top < bounds.bottom;
    if (inside) {
      play(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], flipMoveOpts(), 'flip');
      return;
    }
    flyAcross(el, now, dx, dy);
  });
}

/** Cross-container FLIP: a clone glides from the old place to the new one, then the row fades in. */
function flyAcross(el: HTMLElement, now: DOMRect, dx: number, dy: number): void {
  const host = document.getElementById('app') ?? document.body;
  const ghost = el.cloneNode(true) as HTMLElement;
  delete ghost.dataset.flip;
  delete ghost.dataset.task;
  ghost.classList.add('nx-fly');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.left = `${now.left}px`;
  ghost.style.top = `${now.top}px`;
  ghost.style.width = `${now.width}px`;
  ghost.style.height = `${now.height}px`;
  host.appendChild(ghost);
  const a = play(ghost, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { ...SPRING_MOVE, fill: 'none' }, 'fly');
  play(el, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1, offset: 1 }], { ...SPRING_MOVE, fill: 'none' }, 'flip');
  const drop = () => ghost.remove();
  if (a) {
    a.addEventListener('finish', drop);
    a.addEventListener('cancel', drop);
    // Animation events only fire on rendering updates; if the tab is hidden mid-flight, still tidy up.
    setTimeout(drop, SPRING_MOVE.duration + 250);
  } else drop();
}

export function measure(container: HTMLElement | null): Map<string, DOMRect> {
  const m = new Map<string, DOMRect>();
  container?.querySelectorAll<HTMLElement>('[data-flip]').forEach((el) => {
    m.set(el.dataset.flip!, el.getBoundingClientRect());
  });
  return m;
}

// ─── Tokens ─────────────────────────────────────────────────────────────────────

/** CSS custom properties the stylesheets use (nexus.css falls back to cubic-beziers until this runs). */
export const MOTION_TOKENS: Record<string, string> = {
  '--spring-enter': SPRING_ENTER.easing,
  '--spring-move': SPRING_MOVE.easing,
  '--spring-snappy': SPRING_SNAPPY.easing,
  '--dur-enter': `${SPRING_ENTER.duration}ms`,
  '--dur-move': `${SPRING_MOVE.duration}ms`,
  '--dur-snappy': `${SPRING_SNAPPY.duration}ms`,
  '--dur-exit': `${EXIT.duration}ms`
};

let tokensInstalled = false;

/**
 * Publishes the spring easings and durations as `:root` custom properties once (a stylesheet, not
 * inline styles, so nexus.css's `html[data-motion="reduced"]` and reduced-motion rules still win),
 * mirrors the Motion setting as `html[data-motion="full|reduced"]` and keeps it current as settings change.
 */
export function installMotionTokens(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const applyMotionAttr = () => {
    root.dataset.motion = getSettings().motion === 'reduced' ? 'reduced' : 'full';
  };
  applyMotionAttr();
  if (tokensInstalled) return;
  tokensInstalled = true;
  const style = document.createElement('style');
  style.id = 'nx-motion-tokens';
  style.textContent = `:root{${Object.entries(MOTION_TOKENS)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')}}`;
  document.head.appendChild(style);
  subscribeSettings(applyMotionAttr);
}
