import { getSettings } from '../settings/store';

/**
 * Port of Android NexusHaptics: same kinds, same millisecond patterns, scaled by strength.
 * navigator.vibrate works on Android browsers; iOS Safari has no vibration API, so on iPhone
 * every kind falls back to the visual press/lift feedback the components already do.
 */
export type HapticKind =
  | 'FAB_TAP'
  | 'FAB_QUADRANT'
  | 'DRAG_PICKUP'
  | 'DRAG_TICK'
  | 'DRAG_DROP'
  | 'CHECK'
  | 'DELETE'
  | 'SYNC_PULSE'
  | 'SYNC_SUCCESS'
  | 'SYNC_FAIL';

const PATTERNS: Record<HapticKind, number[]> = {
  FAB_TAP: [14],
  FAB_QUADRANT: [9],
  DRAG_PICKUP: [18],
  DRAG_TICK: [7],
  DRAG_DROP: [12, 40, 20],
  CHECK: [11],
  DELETE: [30, 45, 16],
  SYNC_PULSE: [10, 65, 10, 65, 10],
  SYNC_SUCCESS: [18, 48, 26],
  SYNC_FAIL: [36, 55, 36]
};

export const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

export function haptic(kind: HapticKind): void {
  if (!canVibrate) return;
  const s = getSettings();
  if (!s.vibrationEnabled) return;
  const k = Math.max(0.1, Math.min(1, s.vibrationStrength));
  // Pauses (odd indexes) keep their length; pulses scale with strength.
  const p = PATTERNS[kind].map((ms, i) => (i % 2 ? ms : Math.max(1, Math.round(ms * (0.4 + k)))));
  try {
    navigator.vibrate(p);
  } catch {
    /* ignore */
  }
}

// Old names still used by the sync layer.
export const vibrateTap = () => haptic('FAB_TAP');
export const vibrateDragStep = () => haptic('DRAG_TICK');
export const vibrateDelete = () => haptic('DELETE');
export const vibrateSyncPulse = () => haptic('SYNC_PULSE');
export const vibrateSyncSuccess = () => haptic('SYNC_SUCCESS');
export const vibrateSyncFail = () => haptic('SYNC_FAIL');
