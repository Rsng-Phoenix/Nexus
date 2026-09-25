import type { PairLink } from '../pair/pair';
import { computed, signal } from '@preact/signals';
import type { SharePayload } from '../share/export';
import type { Priority } from '../types';

/**
 * Everything that opens above the matrix is a layer on one stack, mirrored into browser
 * history. Android back gesture, the browser Back button and Esc all pop the top layer,
 * in the same order as the Android app (vault → settings → about → detail → full screen → input).
 */
export type Layer =
  | { kind: 'add'; priority: Priority; locked?: boolean; text?: string; due?: string; notes?: string }
  | { kind: 'pick' }
  | { kind: 'detail'; taskId: number }
  | { kind: 'full'; priority: Priority; folder?: boolean }
  | { kind: 'settings'; cat?: string }
  | { kind: 'vault'; which: 'archived' | 'deleted' }
  | { kind: 'about' }
  | { kind: 'changelog' }
  | { kind: 'profile' }
  | { kind: 'share'; payload: SharePayload }
  | { kind: 'reminder'; taskId: number }
  | { kind: 'deadline'; taskId: number; presetDate?: string }
  | { kind: 'onboarding' }
  | { kind: 'calendar' }
  | { kind: 'calendars' }
  | { kind: 'clashes' }
  | { kind: 'pair'; link?: PairLink }
  | { kind: 'icsImport'; fileName: string; text: string }
  | { kind: 'sheetImport'; file?: File }
  | { kind: 'mini' };

export type LayerEntry = Layer & { id: number };

let seq = 0;
export const layers = signal<LayerEntry[]>([]);
/** Layers animating out: still rendered until their exit animation finishes. */
export const leaving = signal<LayerEntry[]>([]);

export const top = computed(() => layers.value[layers.value.length - 1] ?? null);
export const has = (kind: Layer['kind']) => layers.value.some((l) => l.kind === kind);
export function find<K extends Layer['kind']>(kind: K): (LayerEntry & { kind: K }) | undefined {
  return layers.value.find((l) => l.kind === kind) as (LayerEntry & { kind: K }) | undefined;
}

let suppressPop = 0;

export function open(layer: Layer): number {
  const entry = { ...layer, id: ++seq } as LayerEntry;
  layers.value = [...layers.value, entry];
  history.pushState({ nx: entry.id }, '');
  return entry.id;
}

/** Replace the top layer without growing history (e.g. detail → reminder wizard handoff). */
export function replaceTop(layer: Layer): void {
  const cur = top.value;
  if (!cur) {
    open(layer);
    return;
  }
  const entry = { ...layer, id: ++seq } as LayerEntry;
  leaving.value = [...leaving.value, cur];
  layers.value = [...layers.value.slice(0, -1), entry];
}

function popLocal(): LayerEntry | null {
  const cur = top.value;
  if (!cur) return null;
  layers.value = layers.value.slice(0, -1);
  leaving.value = [...leaving.value, cur];
  closeHooks.get(cur.id)?.();
  closeHooks.delete(cur.id);
  return cur;
}

/** Close the top layer (keeps browser history in sync). */
export function back(): void {
  if (!top.value) return;
  suppressPop++;
  popLocal();
  history.back();
}

/** Close a specific layer and everything above it. */
export function closeKind(kind: Layer['kind']): void {
  const idx = layers.value.findIndex((l) => l.kind === kind);
  if (idx < 0) return;
  const n = layers.value.length - idx;
  for (let i = 0; i < n; i++) popLocal();
  suppressPop += n;
  history.go(-n);
}

/** Close the layer with [id] and everything above it (a Back tapped on a screen that isn't on top). */
export function closeFrom(id: number): void {
  const idx = layers.value.findIndex((l) => l.id === id);
  if (idx < 0) return;
  const n = layers.value.length - idx;
  for (let i = 0; i < n; i++) popLocal();
  suppressPop += n;
  history.go(-n);
}

export function closeAll(): void {
  const n = layers.value.length;
  if (!n) return;
  for (let i = 0; i < n; i++) popLocal();
  suppressPop += n;
  history.go(-n);
}

export function finishLeave(id: number): void {
  leaving.value = leaving.value.filter((l) => l.id !== id);
}

const closeHooks = new Map<number, () => void>();
/** Run [fn] when the layer is dismissed by any route (back gesture, scrim, Esc). */
export function onLayerClose(id: number, fn: () => void): () => void {
  closeHooks.set(id, fn);
  return () => closeHooks.delete(id);
}

/** Global back interceptors (e.g. the guided tour) get first refusal. */
const interceptors: Array<() => boolean> = [];
export function interceptBack(fn: () => boolean): () => void {
  interceptors.push(fn);
  return () => interceptors.splice(interceptors.indexOf(fn), 1);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (suppressPop > 0) {
      suppressPop--;
      return;
    }
    if (top.value) {
      popLocal();
      return;
    }
    for (const f of [...interceptors].reverse()) if (f()) return;
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (top.value) back();
    else for (const f of [...interceptors].reverse()) if (f()) break;
  });
}
