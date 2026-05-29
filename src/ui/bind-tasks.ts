import { markCompleted } from '../task-utils';
import type { Task } from '../types';

export function bindTaskRows(
  root: ParentNode,
  getTask: (id: number) => Task | undefined,
  onSave: (task: Task) => void | Promise<void>,
  onOpen: (task: Task) => void,
  opts?: {
    dragEnabled?: boolean;
    onDragStart?: (task: Task, el: HTMLElement, e: PointerEvent) => void;
  }
): void {
  root.querySelectorAll<HTMLElement>('.nx-task').forEach((el) => {
    const id = Number(el.dataset.id);
    const task = getTask(id);
    if (!task) return;

    const check = el.querySelector<HTMLInputElement>('.nx-task-check');
    if (check) {
      for (const ev of ['pointerdown', 'mousedown', 'click'] as const) {
        check.addEventListener(ev, (e) => e.stopPropagation());
      }
      check.addEventListener('change', () => {
        const t = getTask(id);
        if (!t) return;
        void onSave(
          check.checked
            ? markCompleted(t)
            : {
                ...t,
                isCompleted: false,
                completedAt: 0,
                updatedAt: Date.now()
              }
        );
      });
    }

    el.querySelector('.nx-task-body')?.addEventListener('click', () => {
      const t = getTask(id);
      if (t) onOpen(t);
    });

    if (opts?.dragEnabled && opts.onDragStart) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest('.nx-task-check')) return;
        timer = setTimeout(() => {
          const t = getTask(id);
          if (t) opts.onDragStart!(t, el, e);
        }, 420);
      };
      const clear = () => {
        if (timer) clearTimeout(timer);
      };
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointerup', clear);
      el.addEventListener('pointercancel', clear);
      el.addEventListener('pointerleave', clear);
    }
  });
}
