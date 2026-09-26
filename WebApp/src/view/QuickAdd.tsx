import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/haptics';
import { pickerKey } from '../lib/pickerKeys';
import * as nav from '../state/nav';
import { byPriority } from '../state/store';
import type { Priority } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import type { LayerProps } from './App';
import { animate, BOUNCY, STANDARD } from './motion';

/** Priority the picker highlights first: the last one used this session (High on first use). */
let lastPicked: Priority = 'HIGH';

/**
 * Keyboard quick add (Enter anywhere on the matrix). A mini 2×2 matrix in the same layout as
 * the real one: arrows or 1–4 to choose, Enter to confirm, or just start typing to add to the
 * highlighted priority. The add sheet then replaces this layer, so Esc closes everything.
 */
export function PriorityPicker({ leaving, onExited, onDismiss }: LayerProps) {
  const [sel, setSelState] = useState<Priority>(lastPicked);
  // Keys can arrive faster than re-renders: always act on the latest highlight.
  const selRef = useRef<Priority>(lastPicked);
  const setSel = (p: Priority) => {
    selRef.current = p;
    setSelState(p);
  };
  const box = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  // Set synchronously: keys typed before this layer re-renders as "leaving" must not re-open.
  const chosen = useRef(false);

  const choose = (p: Priority, text = '') => {
    if (chosen.current) return;
    chosen.current = true;
    lastPicked = p;
    haptic('FAB_TAP');
    nav.replaceTop({ kind: 'add', priority: p, text });
  };

  useLayoutEffect(() => {
    animate(box.current, [{ opacity: 0, transform: 'translateY(-8px) scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: BOUNCY });
    animate(shade.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'linear' });
  }, []);
  useLayoutEffect(() => {
    if (!leaving) return;
    const a = animate(box.current, [{ opacity: 1 }, { opacity: 0, transform: 'scale(0.97)' }], { duration: 140, easing: STANDARD });
    animate(shade.current, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'linear' });
    if (a) a.onfinish = onExited;
    else onExited();
  }, [leaving]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (chosen.current) return;
      // Same rules as the widget's composer (lib/pickerKeys.ts). Typing straight away adds to
      // the highlighted priority, keeping the keystroke.
      const a = pickerKey(e, selRef.current);
      if (!a) return;
      e.preventDefault();
      if (a.type === 'choose') choose(a.priority, a.text);
      else if (a.priority !== selRef.current) {
        haptic('DRAG_TICK');
        setSel(a.priority);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div class="nx-layer nx-pick-layer" data-leaving={leaving || undefined}>
      <div ref={shade} class="nx-scrim" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onDismiss} />
      <div ref={box} class="nx-pick" role="dialog" aria-modal="true" aria-label="Choose a priority for the new task">
        <div class="nx-pick-head">
          <span>New task</span>
          <small>Pick a priority · or just start typing</small>
        </div>
        <div class="nx-pick-grid" role="listbox" aria-activedescendant={`pick-${sel}`}>
          {PRIORITIES.map((p, i) => {
            const meta = PRIORITY_META[p];
            const open = byPriority.value[p].filter((t) => !t.isCompleted && !t.isWontDo).length;
            return (
              <button
                key={p}
                id={`pick-${p}`}
                role="option"
                aria-selected={sel === p}
                class={`nx-pick-cell press ${sel === p ? 'on' : ''}`}
                style={{ '--c': meta.color } as JSX.CSSProperties}
                onMouseEnter={() => setSel(p)}
                onClick={() => choose(p)}
              >
                <span class="glyph">{meta.glyph}</span>
                <span class="label">{meta.label}</span>
                <span class="meta">{open === 0 ? 'Empty' : `${open} open`}</span>
                <kbd>{i + 1}</kbd>
              </button>
            );
          })}
        </div>
        <div class="nx-pick-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> move</span>
          <span><kbd>⏎</kbd> choose</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
