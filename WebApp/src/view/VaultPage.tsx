import '../styles/settings.css';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/haptics';
import { settingsSig } from '../settings/store';
import {
  archivedTasks,
  archiveTasks,
  deleteTasks,
  recentlyDeleted,
  restoreTasks,
  unarchiveTasks
} from '../state/store';
import { offerUndo } from '../state/toasts';
import type { Task } from '../types';
import { PRIORITY_META } from '../types';
import type { LayerProps } from './App';
import { Icon } from './icons';
import { IconButton, Page, PageHeader, TextButton } from './kit';
import { animate, ENTER, EXIT, reducedMotion } from './motion';

const Red = '#FF4060';

function stampLabel(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/** "High · completed · Sep 24, 8:05 AM" (TaskVaultSheet.kt buildString). */
function metaLine(t: Task, stamp: number): string {
  let s = PRIORITY_META[t.priority].label;
  if (t.isCompleted) s += ' · completed';
  if (t.isWontDo) s += " · won't do";
  if (stamp > 0) s += ` · ${stampLabel(stamp)}`;
  return s;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

type Ghost = { task: Task; index: number };

/**
 * Keeps removed rows rendered while they animate out (LazyColumn animateItem) and FLIPs the
 * rows around them into their new slots. Only transform/opacity animate.
 */
function useAnimatedList(source: Task[]) {
  const [, force] = useState(0);
  const ghosts = useRef(new Map<number, Ghost>());
  const prev = useRef<Task[]>(source);
  const rendered = useRef<Task[]>(source);
  const container = useRef<HTMLDivElement>(null);
  const rects = useRef(new Map<number, number>());
  const known = useRef(new Set<number>(source.map((t) => t.id)));
  const mounted = useRef(false);

  // Derive ghosts during render (DOM still shows the previous frame, so snapshot it too).
  if (prev.current !== source) {
    const live = new Set(source.map((t) => t.id));
    rendered.current.forEach((t, index) => {
      if (!live.has(t.id) && !ghosts.current.has(t.id)) ghosts.current.set(t.id, { task: t, index });
    });
    for (const id of live) ghosts.current.delete(id);
    prev.current = source;
  }
  rects.current.clear();
  container.current?.querySelectorAll<HTMLElement>('[data-vid]').forEach((el) => {
    rects.current.set(Number(el.dataset.vid), el.getBoundingClientRect().top);
  });

  const list: Array<{ task: Task; leaving: boolean }> = source.map((task) => ({ task, leaving: false }));
  [...ghosts.current.values()]
    .sort((a, b) => a.index - b.index)
    .forEach((g) => list.splice(Math.min(g.index, list.length), 0, { task: g.task, leaving: true }));
  rendered.current = list.map((r) => r.task);

  useLayoutEffect(() => {
    const el = container.current;
    if (!el || reducedMotion()) {
      mounted.current = true;
      return;
    }
    el.querySelectorAll<HTMLElement>('[data-vid]').forEach((row) => {
      const id = Number(row.dataset.vid);
      if (row.dataset.leaving) return;
      const before = rects.current.get(id);
      if (before === undefined) {
        // New since the last frame (e.g. undo brought it back): fade and rise in.
        if (mounted.current && !known.current.has(id)) {
          animate(row, [{ opacity: 0, transform: 'translateY(8px) scale(0.98)' }, { opacity: 1, transform: 'none' }], {
            ...ENTER,
            fill: 'none'
          });
        }
        return;
      }
      const dy = before - row.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) {
        animate(row, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { ...ENTER, fill: 'none' });
      }
    });
    source.forEach((t) => known.current.add(t.id));
    mounted.current = true;
  });

  const finishGhost = (id: number) => {
    known.current.delete(id);
    if (ghosts.current.delete(id)) force((n) => n + 1);
  };

  return { list, container, finishGhost };
}

function VaultRow({ task, stamp, leaving, archived, onRestore, onDelete, onGone }: {
  task: Task;
  stamp: number;
  leaving: boolean;
  archived: boolean;
  onRestore: () => void;
  onDelete: () => void;
  onGone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!leaving) {
      el.getAnimations().forEach((a) => a.cancel());
      return;
    }
    const a = animate(
      el,
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateX(24px) scale(0.98)' }
      ],
      EXIT
    );
    if (!a) onGone();
    else a.onfinish = onGone;
  }, [leaving]);

  return (
    <div ref={ref} class="nx-vault-row" role="listitem" data-vid={task.id} data-leaving={leaving || undefined} aria-hidden={leaving || undefined}>
      <span class="bar" style={{ background: PRIORITY_META[task.priority].color }} />
      <div class="body">
        <span class="title">{task.description}</span>
        <span class="meta">{metaLine(task, stamp)}</span>
      </div>
      <IconButton icon="restore" label="Restore" size={20} color="var(--nx-accent)" onClick={onRestore} />
      {archived && <IconButton icon="deleteOutline" label="Delete" size={20} color={Red} onClick={onDelete} />}
    </div>
  );
}

export function VaultPage(p: LayerProps & { which: 'archived' | 'deleted' }) {
  const archived = p.which === 'archived';
  const trashDays = settingsSig.value.trashDays;
  const source = archived ? archivedTasks.value : recentlyDeleted.value;
  const { list, container, finishGhost } = useAnimatedList(source);

  const title = archived ? 'Archived' : 'Recently deleted';
  const subtitle = archived
    ? 'Hidden from the matrix, kept and backed up. Never auto-deleted.'
    : `Deleted tasks stay here for ${trashDays} days, then disappear for good.`;

  const restore = (ids: number[]) => {
    if (!ids.length) return;
    haptic('CHECK');
    const msg = plural(ids.length, 'Task restored', 'tasks restored');
    if (archived) {
      void unarchiveTasks(ids);
      offerUndo(msg, () => void archiveTasks(ids));
    } else {
      void restoreTasks(ids);
      offerUndo(msg, () => void deleteTasks(ids));
    }
  };

  const remove = (id: number) => {
    haptic('DELETE');
    void deleteTasks([id]);
    offerUndo('Task deleted', () => void restoreTasks([id]));
  };

  return (
    <Page leaving={p.leaving} onExited={p.onExited} onDismiss={p.onDismiss} class="nx-vault">
      <PageHeader
        title={title}
        subtitle={subtitle}
        onBack={p.onDismiss}
        trailing={
          source.length > 0 ? (
            <TextButton onClick={() => restore(source.map((t) => t.id))}>Restore all</TextButton>
          ) : undefined
        }
      />
      <div class="nx-vault-divider" />
      {list.length === 0 ? (
        <div class="nx-vault-empty">
          <span class="circle">
            <Icon name={archived ? 'archive' : 'deleteOutline'} size={28} />
          </span>
          <span class="head">{archived ? 'Nothing archived' : 'Nothing deleted recently'}</span>
          <span class="cap">
            {archived ? 'Archive a task from its menu or a Completed section' : 'Deleted tasks show up here'}
          </span>
        </div>
      ) : (
        <div class="nx-vault-list" ref={container} role="list" aria-label={title}>
          {list.map(({ task, leaving }) => (
            <VaultRow
              key={task.id}
              task={task}
              stamp={archived ? task.archivedAt : task.deletedAt}
              leaving={leaving}
              archived={archived}
              onRestore={() => restore([task.id])}
              onDelete={() => remove(task.id)}
              onGone={() => finishGhost(task.id)}
            />
          ))}
        </div>
      )}
    </Page>
  );
}
