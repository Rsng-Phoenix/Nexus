import { signal } from '@preact/signals';

export type Undo = { id: number; message: string; undo: () => void };
export type Snack = { id: number; message: string; action?: { label: string; run: () => void } };

/** Same as Android: one undo at a time, visible for 7 s. */
export const UNDO_MS = 7000;
export const undoToast = signal<Undo | null>(null);
export const snack = signal<Snack | null>(null);
export const syncPill = signal<string | null>(null);

let seq = 0;
let undoTimer = 0;
let snackTimer = 0;
let pillTimer = 0;

export function offerUndo(message: string, undo: () => void): void {
  clearTimeout(undoTimer);
  const id = ++seq;
  undoToast.value = { id, message, undo };
  undoTimer = window.setTimeout(() => {
    if (undoToast.value?.id === id) undoToast.value = null;
  }, UNDO_MS);
}

export function runUndo(): void {
  const u = undoToast.value;
  if (!u) return;
  undoToast.value = null;
  clearTimeout(undoTimer);
  u.undo();
}

export function showSnack(message: string, action?: Snack['action'], ms = 3200): void {
  clearTimeout(snackTimer);
  const id = ++seq;
  snack.value = { id, message, action };
  snackTimer = window.setTimeout(() => {
    if (snack.value?.id === id) snack.value = null;
  }, ms);
}

export function showSyncPill(text: string): void {
  clearTimeout(pillTimer);
  syncPill.value = text;
  pillTimer = window.setTimeout(() => (syncPill.value = null), 4500);
}
