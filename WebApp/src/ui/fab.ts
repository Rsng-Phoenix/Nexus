import { vibrateTap } from '../lib/haptics';
import type { Priority } from '../types';

export function mountFab(opts: {
  onOpenAdd: (priority: Priority) => void;
  getQuadrantBounds: () => Map<Priority, DOMRect>;
  onHighlight: (p: Priority | null) => void;
  onQuadrantHover?: () => void;
}): HTMLButtonElement {
  const fab = document.createElement('button');
  fab.className = 'nx-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Add task');
  fab.textContent = '+';

  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let lastHover: Priority | null = null;
  const dragThreshold = 8;

  const applyOffset = (): void => {
    fab.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
  };

  const hitQuadrant = (x: number, y: number): Priority | null => {
    for (const [p, r] of opts.getQuadrantBounds()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return p;
    }
    return null;
  };

  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    fab.setPointerCapture(e.pointerId);
  });

  fab.addEventListener('pointermove', (e) => {
    if (!fab.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) > dragThreshold) dragging = true;
    if (!dragging) return;
    offsetX += e.movementX;
    offsetY += e.movementY;
    applyOffset();
    const hit = hitQuadrant(e.clientX, e.clientY);
    if (hit !== lastHover) {
      lastHover = hit;
      if (hit) opts.onQuadrantHover?.();
    }
    opts.onHighlight(hit);
  });

  fab.addEventListener('pointerup', (e) => {
    if (!fab.hasPointerCapture(e.pointerId)) return;
    fab.releasePointerCapture(e.pointerId);
    if (dragging) {
      const p = hitQuadrant(e.clientX, e.clientY);
      if (p) opts.onOpenAdd(p);
      offsetX = 0;
      offsetY = 0;
      applyOffset();
      opts.onHighlight(null);
      lastHover = null;
    } else {
      vibrateTap();
      opts.onOpenAdd('HIGH');
    }
    dragging = false;
  });

  fab.addEventListener('pointercancel', () => {
    offsetX = 0;
    offsetY = 0;
    applyOffset();
    opts.onHighlight(null);
    dragging = false;
  });

  return fab;
}
