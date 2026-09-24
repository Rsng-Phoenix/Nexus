import { useLayoutEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';

// Compose specs from NexusMotion, converted to CSS timing. Only transform/opacity ever animate.
/** spring(dampingRatio 1.0, stiffness 400): critically damped, no overshoot. */
export const ENTER = { easing: 'cubic-bezier(0.2, 0, 0, 1)', duration: 340 };
/** tween(220, FastOutLinearIn). */
export const EXIT = { easing: 'cubic-bezier(0.4, 0, 1, 1)', duration: 220 };
/** FastOutSlowIn. */
export const STANDARD = 'cubic-bezier(0.4, 0, 0.2, 1)';
/** spring(0.5, 1500): quick and a little bouncy (press, lift, pills). */
export const BOUNCY = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

export const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function animate(
  el: Element | null | undefined,
  frames: Keyframe[],
  opts: KeyframeAnimationOptions
): Animation | null {
  if (!el || typeof (el as HTMLElement).animate !== 'function') return null;
  if (reducedMotion()) opts = { ...opts, duration: Math.min(Number(opts.duration ?? 0), 80) };
  return (el as HTMLElement).animate(frames, { fill: 'both', ...opts });
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
    animate(ref.current, enter, enterOpts);
  }, []);
  useLayoutEffect(() => {
    if (!leaving || done.current) return;
    done.current = true;
    const a = animate(ref.current, exit, exitOpts);
    if (!a) onExited();
    else a.onfinish = () => onExited();
  }, [leaving]);
}

/** FLIP: animate elements from their previous rect to the new one (list reorders, moves). */
export function flip(container: HTMLElement | null, prev: Map<string, DOMRect>): void {
  if (!container || reducedMotion()) return;
  container.querySelectorAll<HTMLElement>('[data-flip]').forEach((el) => {
    const key = el.dataset.flip!;
    const before = prev.get(key);
    if (!before) {
      el.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], {
        duration: 180,
        easing: STANDARD
      });
      return;
    }
    const now = el.getBoundingClientRect();
    const dx = before.left - now.left;
    const dy = before.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], ENTER);
  });
}

export function measure(container: HTMLElement | null): Map<string, DOMRect> {
  const m = new Map<string, DOMRect>();
  container?.querySelectorAll<HTMLElement>('[data-flip]').forEach((el) => {
    m.set(el.dataset.flip!, el.getBoundingClientRect());
  });
  return m;
}
