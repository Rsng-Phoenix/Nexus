import { beforeEach, describe, expect, it, vi } from 'vitest';

// motion.ts reads the Motion setting; keep the store out of these tests.
const state = { motion: 'full' as 'full' | 'reduced' };
vi.mock('../settings/store', () => ({
  getSettings: () => ({ motion: state.motion }),
  subscribeSettings: () => () => {}
}));

import {
  MOTION_TOKENS,
  play,
  REDUCED_MAX_MS,
  spring,
  SPRING_ENTER,
  SPRING_MAX_MS,
  SPRING_MOVE,
  SPRING_SAMPLES,
  SPRING_SNAPPY,
  springPosition
} from './motion';

const samples = (easing: string): number[] =>
  easing
    .replace(/^linear\(/, '')
    .replace(/\)$/, '')
    .split(',')
    .map((s) => Number(s.trim()));

/** A stand-in for an element with the Web Animations API. */
function fakeElement() {
  const calls: Array<{ frames: Keyframe[]; opts: KeyframeAnimationOptions }> = [];
  const made: Array<{ cancelled: boolean; listeners: Record<string, () => void> }> = [];
  const el = {
    style: { willChange: '' } as { willChange: string },
    animate(frames: Keyframe[], opts: KeyframeAnimationOptions) {
      calls.push({ frames, opts });
      const a = {
        cancelled: false,
        listeners: {} as Record<string, () => void>,
        cancel() {
          this.cancelled = true;
          this.listeners.cancel?.();
        },
        addEventListener(type: string, fn: () => void) {
          this.listeners[type] = fn;
        },
        finish() {
          this.listeners.finish?.();
        }
      };
      made.push(a);
      return a;
    }
  };
  return { el: el as unknown as Element, calls, made };
}

describe('spring()', () => {
  it('samples a linear() easing that starts at 0, ends at 1 and settles', () => {
    for (const s of [SPRING_ENTER, SPRING_MOVE, SPRING_SNAPPY]) {
      expect(s.easing.startsWith('linear(')).toBe(true);
      const pts = samples(s.easing);
      expect(pts).toHaveLength(SPRING_SAMPLES);
      expect(pts[0]).toBe(0);
      expect(pts[pts.length - 1]).toBe(1);
      // Rises first (the spring leaves 0 straight away).
      expect(pts[1]).toBeGreaterThan(0);
      // Monotone-ish: any overshoot stays tiny and the last quarter sits at the target.
      for (const v of pts) expect(v).toBeLessThan(1.2);
      for (const v of pts.slice(Math.floor(pts.length * 0.75))) expect(Math.abs(v - 1)).toBeLessThan(0.02);
    }
  });

  it('keeps durations between a frame and the 800 ms cap, snappier springs shorter', () => {
    for (const s of [SPRING_ENTER, SPRING_MOVE, SPRING_SNAPPY]) {
      expect(s.duration).toBeGreaterThanOrEqual(16);
      expect(s.duration).toBeLessThanOrEqual(SPRING_MAX_MS);
      expect(Number.isInteger(s.duration)).toBe(true);
    }
    expect(SPRING_SNAPPY.duration).toBeLessThan(SPRING_ENTER.duration);
    expect(SPRING_ENTER.duration).toBeLessThan(SPRING_MOVE.duration);
    // Enter ≈ Apple 0.30 s / bounce 0.10: settles well under half a second.
    expect(SPRING_ENTER.duration).toBeLessThan(500);
    // A very soft spring is capped.
    expect(spring(20, 1).duration).toBe(SPRING_MAX_MS);
  });

  it('follows the closed form: critically damped never overshoots, underdamped does', () => {
    // ζ = 1 for k = 100, m = 1 → c = 20.
    for (let ms = 0; ms <= 600; ms += 20) expect(springPosition(ms / 1000, 100, 20)).toBeGreaterThanOrEqual(0);
    const under = samples(spring(438, 20).easing);
    expect(Math.max(...under)).toBeGreaterThan(1);
    // Over-damped springs are accepted too and still end at 1.
    const over = samples(spring(100, 40).easing);
    expect(over[over.length - 1]).toBe(1);
    for (const v of over) expect(v).toBeLessThanOrEqual(1);
  });

  it('publishes matching CSS tokens', () => {
    expect(MOTION_TOKENS['--spring-enter']).toBe(SPRING_ENTER.easing);
    expect(MOTION_TOKENS['--dur-enter']).toBe(`${SPRING_ENTER.duration}ms`);
    expect(MOTION_TOKENS['--dur-exit']).toMatch(/^\d+ms$/);
  });
});

describe('play()', () => {
  beforeEach(() => {
    state.motion = 'full';
  });

  it('cancels the running animation with the same key and sets will-change only while it runs', () => {
    const { el, calls, made } = fakeElement();
    const first = play(el, [{ transform: 'scale(0.9)' }, { transform: 'none' }], SPRING_ENTER, 'pop');
    expect(first).not.toBeNull();
    expect((el as unknown as { style: { willChange: string } }).style.willChange).toBe('transform, opacity');
    play(el, [{ transform: 'scale(0.9)' }, { transform: 'none' }], SPRING_ENTER, 'pop');
    expect(made[0].cancelled).toBe(true);
    // A different key does not interrupt.
    play(el, [{ opacity: 0 }, { opacity: 1 }], SPRING_ENTER, 'fade');
    expect(made[1].cancelled).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls[0].opts.easing).toBe(SPRING_ENTER.easing);
    expect(calls[0].opts.fill).toBe('both');
    made[1].listeners.finish?.();
    made[2].listeners.finish?.();
    expect((el as unknown as { style: { willChange: string } }).style.willChange).toBe('');
  });

  it('returns null for missing elements', () => {
    expect(play(null, [], SPRING_ENTER)).toBeNull();
    expect(play({} as Element, [], SPRING_ENTER)).toBeNull();
  });

  it('under the Motion = Reduced setting plays only a short fade', () => {
    state.motion = 'reduced';
    const { el, calls } = fakeElement();
    play(el, [{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'none', opacity: 1 }], SPRING_ENTER, 'sheet');
    expect(calls[0].opts.duration).toBeLessThanOrEqual(REDUCED_MAX_MS);
    for (const f of calls[0].frames) expect('transform' in f).toBe(false);
    expect(calls[0].frames[0].opacity).toBe(0);
    expect(calls[0].frames[1].opacity).toBe(1);
  });

  it('honours prefers-reduced-motion the same way', () => {
    const g = globalThis as { matchMedia?: (q: string) => { matches: boolean } };
    const prev = g.matchMedia;
    g.matchMedia = (q: string) => ({ matches: q.includes('prefers-reduced-motion') });
    try {
      const { el, calls } = fakeElement();
      play(el, [{ transform: 'scale(0.9)' }, { transform: 'none' }], { duration: 500, easing: 'linear' });
      expect(calls[0].opts.duration).toBe(REDUCED_MAX_MS);
      expect(calls[0].frames.every((f) => !('transform' in f))).toBe(true);
    } finally {
      if (prev) g.matchMedia = prev;
      else delete g.matchMedia;
    }
  });
});
