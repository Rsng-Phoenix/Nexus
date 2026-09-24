import '../styles/tour.css';
import { isPc } from '../state/viewport';
import { effect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/haptics';
import { patchSettings, settingsSig } from '../settings/store';
import * as nav from '../state/nav';
import { activeTasks, allTasks, cleanupTutorialDemos, insertTutorialDemos, isDemo } from '../state/store';
import type { Priority } from '../types';
import { PRIORITY_META } from '../types';
import { Icon } from './icons';
import { TOUR_STEPS, tourPhase, tourTarget, type TourStep } from './tour-state';

/**
 * Hands-on tour (port of GuidedTutorial.kt + the MainActivity step watcher). Each step waits for
 * the user to really do the thing; only RETENTION and FINISH are read-and-continue.
 */

const DEMO_1 = 'nexus-tutorial-1';
const PAD = 10;
const RADIUS = 24;
/** The tour steps aside while the user is inside the thing it asked them to open. */
const PAUSING: nav.Layer['kind'][] = ['add', 'detail', 'profile', 'about', 'settings', 'reminder', 'share'];

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

export function startTour(): void {
  void (async () => {
    if (nav.layers.value.length) nav.closeAll();
    await insertTutorialDemos();
    tourTarget.value = 'MEDIUM';
    tourPhase.value = 'ADD';
  })();
}

/** [showCredits]: finished the whole tour, so end on the NEXUS page (credits, settings). */
export function finishTour(showCredits: boolean): void {
  clearStepTimer();
  void cleanupTutorialDemos();
  patchSettings({ tutorialDone: true });
  tourPhase.value = null;
  const hadFull = nav.has('full');
  nav.closeKind('full');
  if (showCredits) {
    // Let the history.go() from closeKind land before pushing the About entry.
    if (hadFull) setTimeout(() => nav.open({ kind: 'about' }), 60);
    else nav.open({ kind: 'about' });
  }
}

function advance(): void {
  const cur = tourPhase.peek();
  if (!cur) return;
  const next = TOUR_STEPS[TOUR_STEPS.indexOf(cur) + 1] as TourStep | undefined;
  if (!next) {
    finishTour(true);
    return;
  }
  haptic('CHECK');
  // Steps after the full-screen part happen on the matrix again.
  if (next === 'PROFILE') nav.closeKind('full');
  // Skipping straight into the full-screen steps: open it for the user.
  if (next === 'SWIPE' && !nav.has('full')) nav.open({ kind: 'full', priority: tourTarget.peek() });
  tourPhase.value = next;
}

// ─── Step completion watcher ────────────────────────────────────────────────────

let stepTimer = 0;
function clearStepTimer() {
  if (stepTimer) clearTimeout(stepTimer);
  stepTimer = 0;
}
/** Advance after [ms] unless the step changed meanwhile (one pending advance per step). */
function advanceLater(ms: number) {
  if (stepTimer) return;
  const p = tourPhase.peek();
  stepTimer = window.setTimeout(() => {
    stepTimer = 0;
    if (tourPhase.peek() === p) advance();
  }, ms);
}

const userTaskCount = () => activeTasks.peek().filter((t) => !isDemo(t)).length;
const openInQuadrant = (p: Priority) =>
  activeTasks.peek().filter((t) => t.priority === p && !t.isCompleted && !t.isWontDo).length;

let watching = false;
function watchSteps() {
  if (watching) return;
  watching = true;
  let stepOf: TourStep | null = null;
  let engaged = false;
  let baseline = 0;
  effect(() => {
    const phase = tourPhase.value;
    allTasks.value;
    const ls = nav.layers.value;
    if (phase !== stepOf) {
      stepOf = phase;
      clearStepTimer();
      engaged = false;
      baseline = phase === 'ADD' ? userTaskCount() : 0;
    }
    if (!phase) return;
    const open = (k: nav.Layer['kind']) => ls.some((l) => l.kind === k);
    const full = ls.find((l) => l.kind === 'full') as (nav.LayerEntry & { kind: 'full' }) | undefined;
    switch (phase) {
      case 'ADD':
        if (open('add')) engaged = true;
        // Closed the input: done if something was added, otherwise try again.
        else if (userTaskCount() > baseline) advanceLater(350);
        else engaged = false;
        break;
      case 'DRAG': {
        const demo = allTasks.value.find((t) => t.taskUuid === DEMO_1 && t.deletedAt === 0);
        if (!demo || demo.priority !== 'HIGH') {
          tourTarget.value = demo?.priority ?? 'MEDIUM';
          advanceLater(450);
        }
        break;
      }
      case 'OPEN':
        if (open('detail')) engaged = true;
        else if (engaged) advanceLater(250);
        break;
      case 'EXPAND':
        if (full) {
          tourTarget.value = full.priority;
          advanceLater(400);
        }
        break;
      case 'SWIPE':
        if (!full) {
          clearStepTimer();
          tourPhase.value = 'PROFILE';
        } else {
          const n = openInQuadrant(full.priority);
          if (!engaged) {
            baseline = n;
            engaged = true;
          }
          // Nothing left to swipe in this quadrant, or the user finished/deleted one.
          if (baseline === 0 || n < baseline) advanceLater(500);
        }
        break;
      case 'RETENTION':
        if (!full) tourPhase.value = 'PROFILE';
        break;
      case 'PROFILE':
        if (open('profile')) engaged = true;
        else if (engaged) advanceLater(250);
        break;
      case 'FINISH':
        // The user tapped NEXUS: the About page is already open, just end the tour.
        if (open('about')) queueMicrotask(() => tourPhase.peek() === 'FINISH' && finishTour(false));
        break;
    }
  });
  nav.interceptBack(() => {
    if (tourPhase.peek()) {
      finishTour(false);
      return true;
    }
    return false;
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('nexus:start-tour', () => startTour());
}

// ─── Copy ───────────────────────────────────────────────────────────────────────

type Copy = { title: string; body: string; hint: string };
function copyFor(step: TourStep, target: Priority, retentionDays: number): Copy {
  const label = PRIORITY_META[target].label;
  switch (step) {
    case 'ADD':
      return isPc.value
        ? {
            title: 'Add your first task',
            body: 'Press Enter anywhere, pick a priority, and type something you need to do.',
            hint: 'Press Enter'
          }
        : {
            title: 'Add your first task',
            body: 'Tap + and type something you need to do. You can also drag + straight into a quadrant.',
            hint: 'Tap +'
          };
    case 'DRAG':
      return {
        title: 'Move it between priorities',
        body: 'Press and hold “Plan sprint goals”, then drag it into Medium. You’ll feel a tick as it crosses over.',
        hint: 'Hold & drag'
      };
    case 'OPEN':
      return {
        title: 'Open a task',
        body: 'Tap any task to see notes, reminders, sharing and more. Close it when you’re done looking.',
        hint: 'Tap a task'
      };
    case 'EXPAND':
      return {
        title: 'Focus on one quadrant',
        body: `Tap the ${label} header to open it full screen.`,
        hint: `Tap ${label}`
      };
    case 'SWIPE':
      return {
        title: 'Swipe to finish',
        body: 'Swipe a task to the right to complete it. Swiping left deletes (with Undo); hold and drag to reorder.',
        hint: 'Swipe right'
      };
    case 'RETENTION':
      return {
        title: 'Done, not gone',
        body: `Finished tasks collect here and auto-delete after ${retentionDays} days. Tap the number to change it, or archive them to keep forever.`,
        hint: ''
      };
    case 'PROFILE':
      return { title: 'Your account', body: 'Tap your profile to back up and sync with Google Drive.', hint: 'Tap your profile' };
    case 'FINISH':
      return {
        title: 'You’re all set',
        body: 'Tap NEXUS now (or any time) for credits, settings, the archive and what’s new. Every number (snooze, reminder hours, check-ins, retention) is yours to change there.',
        hint: ''
      };
  }
}

// ─── Measuring ──────────────────────────────────────────────────────────────────

type Box = { l: number; t: number; r: number; b: number };

function rectOf(sel: string): Box | null {
  const els = document.querySelectorAll<HTMLElement>(sel);
  let out: Box | null = null;
  els.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    out = out
      ? { l: Math.min(out.l, r.left), t: Math.min(out.t, r.top), r: Math.max(out.r, r.right), b: Math.max(out.b, r.bottom) }
      : { l: r.left, t: r.top, r: r.right, b: r.bottom };
  });
  return out;
}

function union(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) };
}

function spotlightFor(step: TourStep, target: Priority): Box | null {
  switch (step) {
    case 'ADD':
      return rectOf('[data-tour="fab"]');
    case 'DRAG':
    case 'OPEN':
      return union(rectOf('[data-quad="HIGH"]'), rectOf('[data-quad="MEDIUM"]'));
    case 'EXPAND':
      return rectOf(`[data-quad="${target}"]`);
    case 'RETENTION':
      return rectOf('[data-tour="retention"]');
    case 'PROFILE':
      return rectOf('[data-tour="profile"]');
    case 'FINISH':
      return rectOf('[data-tour="brand"]');
    case 'SWIPE':
      return null;
  }
}

const center = (b: Box | null) => (b ? { x: (b.l + b.r) / 2, y: (b.t + b.b) / 2 } : null);
const same = (a: Box | null, b: Box | null) =>
  a === b ||
  (!!a && !!b && Math.abs(a.l - b.l) < 0.5 && Math.abs(a.t - b.t) < 0.5 && Math.abs(a.r - b.r) < 0.5 && Math.abs(a.b - b.b) < 0.5);

type Geo = { hole: Box | null; from: { x: number; y: number } | null; to: { x: number; y: number } | null; w: number; h: number };

function useGeometry(step: TourStep | null, target: Priority, layerKey: string): Geo {
  const [geo, setGeo] = useState<Geo>({ hole: null, from: null, to: null, w: innerWidth, h: innerHeight });
  const last = useRef<Geo>(geo);
  useEffect(() => {
    if (!step) return;
    const measure = () => {
      const s = spotlightFor(step, target);
      const hole = s ? { l: s.l - PAD, t: s.t - PAD, r: s.r + PAD, b: s.b + PAD } : null;
      const from = step === 'DRAG' ? center(rectOf('[data-quad="HIGH"]')) : null;
      const to = step === 'DRAG' ? center(rectOf('[data-quad="MEDIUM"]')) : null;
      const next: Geo = { hole, from, to, w: innerWidth, h: innerHeight };
      const p = last.current;
      if (
        same(p.hole, next.hole) &&
        p.w === next.w &&
        p.h === next.h &&
        p.from?.x === next.from?.x &&
        p.from?.y === next.from?.y &&
        p.to?.x === next.to?.x &&
        p.to?.y === next.to?.y
      )
        return;
      last.current = next;
      setGeo(next);
    };
    // Layouts animate after a step change (sheets, full screen): follow them for ~600ms.
    let raf = 0;
    const until = performance.now() + 650;
    const loop = () => {
      measure();
      if (performance.now() < until) raf = requestAnimationFrame(loop);
    };
    loop();
    const slow = window.setInterval(measure, 500);
    addEventListener('resize', measure);
    addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(slow);
      removeEventListener('resize', measure);
      removeEventListener('scroll', measure, true);
    };
  }, [step, target, layerKey]);
  return geo;
}

// ─── Overlay ────────────────────────────────────────────────────────────────────

export function TourOverlay() {
  useEffect(() => watchSteps(), []);
  const phase = tourPhase.value;
  const target = tourTarget.value;
  const ls = nav.layers.value;
  const retentionDays = settingsSig.value.retentionDays;
  const paused = ls.some((l) => PAUSING.includes(l.kind));
  const layerKey = ls.map((l) => l.id).join(',');
  const geo = useGeometry(phase && !paused ? phase : null, target, layerKey);
  const card = useRef<HTMLDivElement>(null);

  if (!phase || paused) return null;

  const dim = phase !== 'SWIPE';
  const { w, h } = geo;
  const hole = dim ? geo.hole : null;
  const interactive = phase !== 'RETENTION' && phase !== 'FINISH';
  const copy = copyFor(phase, target, retentionDays);
  const holeCenterY = hole ? (hole.t + hole.b) / 2 : null;
  const cardAtBottom = holeCenterY === null || holeCenterY < h * 0.5;
  const idx = TOUR_STEPS.indexOf(phase);

  const nudge = () => {
    haptic('DRAG_TICK');
    card.current?.animate(
      [
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(-14px)', offset: 60 / 360 },
        { transform: 'translateX(12px)', offset: 140 / 360 },
        { transform: 'translateX(-8px)', offset: 220 / 360 },
        { transform: 'translateX(4px)', offset: 300 / 360 },
        { transform: 'translateX(0)', offset: 1 }
      ],
      { duration: 360, easing: 'linear' }
    );
  };

  const blockers: Box[] = [];
  if (dim) {
    if (!hole) blockers.push({ l: 0, t: 0, r: w, b: h });
    else {
      const cl = (v: number, max: number) => Math.min(Math.max(v, 0), max);
      const l = cl(hole.l, w), r = cl(hole.r, w), t = cl(hole.t, h), b = cl(hole.b, h);
      blockers.push({ l: 0, t: 0, r: w, b: t }, { l: 0, t: b, r: w, b: h }, { l: 0, t, r: l, b }, { l: r, t, r: w, b });
    }
  }

  const maskId = 'nx-tour-mask';
  return (
    <div class="nx-tour">
      {dim && (
        <svg class="nx-tour-scrim" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={w} height={h}>
              <rect x="0" y="0" width={w} height={h} fill="#fff" />
              {hole && (
                <rect x={hole.l} y={hole.t} width={hole.r - hole.l} height={hole.b - hole.t} rx={RADIUS} ry={RADIUS} fill="#000" />
              )}
            </mask>
          </defs>
          <rect x="0" y="0" width={w} height={h} fill="rgba(0,0,0,0.72)" mask={`url(#${maskId})`} />
          {hole && (
            <rect
              class="nx-tour-ring"
              x={hole.l}
              y={hole.t}
              width={hole.r - hole.l}
              height={hole.b - hole.t}
              rx={RADIUS}
              ry={RADIUS}
              fill="none"
              stroke="var(--nx-accent)"
              stroke-width="2"
            />
          )}
        </svg>
      )}
      {phase === 'DRAG' && geo.from && geo.to && (
        <div
          class="nx-tour-finger"
          aria-hidden="true"
          style={{ '--fx': `${geo.from.x}px`, '--fy': `${geo.from.y}px`, '--tx': `${geo.to.x}px`, '--ty': `${geo.to.y}px` }}
        >
          <div class="nx-tour-finger-dot" />
        </div>
      )}
      {blockers.map(
        (b, i) =>
          b.r > b.l &&
          b.b > b.t && (
            <div
              key={i}
              class="nx-tour-block"
              aria-hidden="true"
              style={{ left: `${b.l}px`, top: `${b.t}px`, width: `${b.r - b.l}px`, height: `${b.b - b.t}px` }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                nudge();
              }}
            />
          )
      )}
      <div class={`nx-tour-card-wrap ${cardAtBottom ? 'bottom' : 'top'}`}>
        <div class="nx-tour-card" ref={card} role="dialog" aria-modal="false" aria-labelledby="nx-tour-title" aria-live="polite">
          <div class="nx-tour-card-inner" key={phase}>
            <div class="nx-tour-head">
              <div class="nx-tour-dots" role="img" aria-label={`Step ${idx + 1} of ${TOUR_STEPS.length}`}>
                {TOUR_STEPS.map((s, i) => (
                  <span key={s} class={`nx-tour-dot${i === idx ? ' active' : i < idx ? ' done' : ''}`} />
                ))}
              </div>
              <button class="nx-tour-skip press" onClick={() => finishTour(false)}>
                Skip tour
              </button>
            </div>
            <h2 class="nx-tour-title" id="nx-tour-title">
              {copy.title}
            </h2>
            <p class="nx-tour-body">{copy.body}</p>
            <div class="nx-tour-foot">
              {interactive ? (
                <>
                  <span class="nx-tour-touch" aria-hidden="true">
                    <Icon name="touch" size={18} />
                  </span>
                  <span class="nx-tour-hint">{copy.hint}</span>
                  <button class="nx-tour-skipstep press" onClick={() => advance()}>
                    Skip step
                  </button>
                </>
              ) : (
                <>
                  <span class="nx-tour-spacer" />
                  <button
                    class="nx-tour-next press"
                    onClick={() => (phase === 'FINISH' ? finishTour(true) : advance())}
                  >
                    {phase === 'FINISH' ? 'Start using Nexus' : 'Next'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
