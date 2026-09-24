import { signal } from '@preact/signals';
import type { Priority } from '../types';

/** Same 8 hands-on steps as Android GuidedTutorialPhase. */
export const TOUR_STEPS = ['ADD', 'DRAG', 'OPEN', 'EXPAND', 'SWIPE', 'RETENTION', 'PROFILE', 'FINISH'] as const;
export type TourStep = (typeof TOUR_STEPS)[number];

export const tourPhase = signal<TourStep | null>(null);
/** Quadrant the EXPAND step points at (wherever the user dropped the demo task). */
export const tourTarget = signal<Priority>('MEDIUM');

export const tour = {
  /** While the tour runs, only the step's own gesture is allowed on the matrix. */
  allows(step: TourStep, priority?: Priority): boolean {
    const p = tourPhase.value;
    if (p === null) return true;
    if (p !== step) return false;
    if (step === 'EXPAND' && priority && priority !== tourTarget.value) return false;
    return true;
  }
};
