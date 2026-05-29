import { getSettings } from '../settings/store';

function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator;
}

function strength(): number {
  const v = getSettings().vibrationStrength;
  return v <= 0 ? 0 : Math.min(1, v / 100);
}

function scale(pattern: number[]): number[] {
  const s = strength();
  if (s <= 0) return [];
  return pattern.map((ms) => Math.max(1, Math.round(ms * s)));
}

export function vibrateTap(): void {
  if (!canVibrate()) return;
  const p = scale([12]);
  if (p.length) navigator.vibrate(p);
}

export function vibrateDragStep(): void {
  if (!canVibrate()) return;
  const p = scale([6]);
  if (p.length) navigator.vibrate(p);
}

export function vibrateDelete(): void {
  if (!canVibrate()) return;
  const p = scale([28, 40, 28]);
  if (p.length) navigator.vibrate(p);
}

export function vibrateSyncPulse(): void {
  if (!canVibrate()) return;
  const p = scale([10, 30, 10, 30]);
  if (p.length) navigator.vibrate(p);
}

export function vibrateSyncSuccess(): void {
  if (!canVibrate()) return;
  const p = scale([18, 35, 18]);
  if (p.length) navigator.vibrate(p);
}

export function vibrateSyncFail(): void {
  if (!canVibrate()) return;
  const p = scale([45, 70, 45, 70, 45]);
  if (p.length) navigator.vibrate(p);
}
