import { Fragment, type JSX } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { rankFuzzy } from '../lib/fuzzy';
import { getSettings } from '../settings/store';
import * as nav from '../state/nav';
import { byPriority, importedByPriority, setChecked } from '../state/store';
import { offerUndo } from '../state/toasts';
import { runSync } from '../sync/manager';
import type { Task } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import type { LayerProps } from './App';
import { Icon, type IconName } from './icons';
import { DueBadge } from './Matrix';
import { closeMiniWindow, miniOpen, miniSupported, openMiniWindow } from './MiniWindow';
import { animate, STANDARD, useEnterExit } from './motion';
import { MOD, shortcutsOpen } from './Shortcuts';

type Item =
  | { id: string; kind: 'task'; task: Task; text: string }
  | { id: string; kind: 'action'; text: string; icon: IconName; keys?: string; run: () => void }
  | { id: string; kind: 'add'; text: string };

/** Tasks the palette searches: every open one, Imported folders included, in matrix order. */
function openTasks(): Task[] {
  const out: Task[] = [];
  for (const p of PRIORITIES) {
    for (const t of byPriority.value[p]) if (!t.isCompleted && !t.isWontDo) out.push(t);
    for (const t of importedByPriority.value[p]) if (!t.isCompleted && !t.isWontDo) out.push(t);
  }
  return out;
}

const TASK_LIMIT = 12;

/**
 * Command palette (⌘K / Ctrl+K, or "/"): one field that finds any open task or runs any action.
 * Enter opens the task (or runs the action), ⌘/Ctrl+Enter ticks the task off, and text that
 * matches nothing can be added as a new task. Replaces itself with whatever it opens.
 */
export function Palette({ leaving, onExited, onDismiss }: LayerProps) {
  const box = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);

  useEnterExit(
    box,
    leaving,
    onExited,
    [{ opacity: 0, transform: 'translateY(-10px) scale(0.97)' }, { opacity: 1, transform: 'none' }],
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.98)' }],
    { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    { duration: 140, easing: STANDARD }
  );
  useLayoutEffect(() => {
    animate(shade.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'linear' });
    input.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (leaving) animate(shade.current, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'linear' });
  }, [leaving]);

  const go = (layer: nav.Layer) => nav.replaceTop(layer);
  const actions = useMemo<Item[]>(() => {
    const a: Item[] = [
      { id: 'new', kind: 'action', text: 'New task', icon: 'add', keys: '⏎', run: () => go({ kind: 'pick' }) },
      ...PRIORITIES.map<Item>((p) => ({
        id: `new-${p}`, kind: 'action', text: `New ${PRIORITY_META[p].label} task`, icon: 'add', run: () => go({ kind: 'add', priority: p })
      })),
      { id: 'calendar', kind: 'action', text: 'Open Calendar', icon: 'calendar', keys: 'C', run: () => go({ kind: 'calendar' }) },
      ...PRIORITIES.map<Item>((p, i) => ({
        id: `open-${p}`, kind: 'action', text: `Open ${PRIORITY_META[p].label}`, icon: 'openInFull', keys: String(i + 1), run: () => go({ kind: 'full', priority: p })
      })),
      ...PRIORITIES.filter((p) => importedByPriority.value[p].length > 0).map<Item>((p) => ({
        id: `folder-${p}`,
        kind: 'action',
        text: `Open Imported · ${PRIORITY_META[p].label} (${importedByPriority.value[p].length})`,
        icon: 'folder',
        run: () => go({ kind: 'full', priority: p, folder: true })
      }))
    ];
    if (getSettings().googleEmail) a.push({ id: 'sync', kind: 'action', text: 'Sync now', icon: 'sync', keys: 'S', run: () => { onDismiss(); void runSync(); } });
    a.push({ id: 'settings', kind: 'action', text: 'Settings', icon: 'settings', keys: ',', run: () => go({ kind: 'settings' }) });
    a.push({ id: 'keys', kind: 'action', text: 'Keyboard shortcuts', icon: 'keyboard', keys: '?', run: () => { onDismiss(); shortcutsOpen.value = true; } });
    if (miniSupported()) {
      a.push({
        id: 'mini', kind: 'action', text: miniOpen.value ? 'Close mini window' : 'Open mini window', icon: 'pip', keys: 'M',
        run: () => { onDismiss(); void (miniOpen.value ? closeMiniWindow() : openMiniWindow()); }
      });
    }
    return a;
  }, []);

  const q = query.trim();
  const tasks = openTasks();
  const items = useMemo<Item[]>(() => {
    const taskItems = tasks.map<Item>((t) => ({ id: `t${t.id}`, kind: 'task', task: t, text: t.description }));
    if (!q) return [...actions, ...taskItems.slice(0, TASK_LIMIT)];
    const found = rankFuzzy(q, taskItems, (i) => i.text, TASK_LIMIT);
    const acts = rankFuzzy(q, actions, (i) => i.text);
    const add: Item[] = found.length ? [] : [{ id: 'add', kind: 'add', text: q }];
    return [...found, ...acts, ...add];
  }, [q, tasks.map((t) => `${t.id}:${t.description}`).join('|'), actions]);
  const cur = Math.min(sel, Math.max(0, items.length - 1));

  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>('.nx-palette-row.on')?.scrollIntoView({ block: 'nearest' });
  }, [cur, items]);

  const run = (it: Item, mod = false) => {
    if (it.kind === 'task') {
      if (mod) {
        const t = it.task;
        void setChecked(t, true);
        offerUndo('Task done', () => void setChecked(t, false));
      } else go({ kind: 'detail', taskId: it.task.id });
    } else if (it.kind === 'add') go({ kind: 'add', priority: 'HIGH', text: it.text });
    else it.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (leaving || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      setSel((cur + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setSel(e.key === 'Home' ? 0 : items.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[cur];
      if (it) run(it, e.metaKey || e.ctrlKey);
    }
  };

  // Section headings: tasks first when searching, actions first on an empty field.
  let lastKind: Item['kind'] | null = null;
  const heading = (k: Item['kind']) => (k === 'task' ? 'Tasks' : k === 'action' ? 'Actions' : 'New');

  return (
    <div class="nx-layer nx-palette-layer" data-leaving={leaving || undefined}>
      <div ref={shade} class="nx-scrim nx-palette-scrim" onClick={onDismiss} />
      <div ref={box} class="nx-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="nx-palette-input">
          <Icon name="search" size={20} />
          <input
            ref={input}
            type="text"
            placeholder="Search tasks or type a command…"
            value={query}
            spellcheck={false}
            autocomplete="off"
            aria-label="Search tasks or actions"
            aria-activedescendant={items[cur] ? `pal-${items[cur].id}` : undefined}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSel(0);
            }}
            onKeyDown={onKey}
          />
          <kbd>esc</kbd>
        </div>
        <div ref={list} class="nx-palette-list" role="listbox">
          {items.length === 0 && <div class="nx-palette-empty">Nothing here yet</div>}
          {items.map((it, i) => {
            const head = it.kind !== lastKind ? <div class="nx-palette-sec">{heading(it.kind)}</div> : null;
            lastKind = it.kind;
            const on = i === cur;
            return (
              <Fragment key={it.id}>
                {head}
                <button
                  id={`pal-${it.id}`}
                  role="option"
                  aria-selected={on}
                  class={`nx-palette-row ${on ? 'on' : ''}`}
                  style={it.kind === 'task' ? ({ '--c': PRIORITY_META[it.task.priority].color } as JSX.CSSProperties) : undefined}
                  onMouseMove={() => !on && setSel(i)}
                  onClick={(e) => run(it, e.metaKey || e.ctrlKey)}
                >
                  {it.kind === 'task' ? <span class="dot" /> : <span class="ic"><Icon name={it.kind === 'add' ? 'add' : it.icon} size={18} /></span>}
                  <span class="t">{it.kind === 'add' ? <>Add “{it.text}” as a new task</> : it.text}</span>
                  {it.kind === 'task' && <DueBadge task={it.task} />}
                  {it.kind === 'task' && <span class="hint">{on && <><kbd>⏎</kbd> open · <kbd>{MOD}</kbd><kbd>⏎</kbd> done</>}</span>}
                  {it.kind === 'action' && it.keys && <span class="hint"><kbd>{it.keys}</kbd></span>}
                  {it.kind === 'add' && <span class="hint"><kbd>⏎</kbd></span>}
                </button>
              </Fragment>
            );
          })}
        </div>
        <div class="nx-palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>⏎</kbd> open · run</span>
          <span><kbd>{MOD}</kbd><kbd>⏎</kbd> done</span>
        </div>
      </div>
    </div>
  );
}
