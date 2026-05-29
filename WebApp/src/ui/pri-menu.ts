import { PRIORITIES, PRIORITY_META, type Priority } from '../types';

export function priMenuHtml(current: Priority, flipOrder = false): string {
  const order = flipOrder ? [...PRIORITIES].reverse() : PRIORITIES;
  const options = order.map((p) => {
    const m = PRIORITY_META[p];
    const active = p === current ? ' nx-pri-active' : '';
    return `<button type="button" data-p="${p}" class="nx-pri-opt${active}" style="--q-color:${m.color}">
      <span class="nx-pri-glyph">${m.glyph}</span>
      <span>${m.label}</span>
    </button>`;
  }).join('');
  return options;
}

export function bindPriMenu(
  wrap: HTMLElement,
  getPriority: () => Priority,
  onSelect: (p: Priority) => void
): { close: () => void; refresh: () => void } {
  const btn = wrap.querySelector('[data-pri-btn]') as HTMLButtonElement;
  const menu = wrap.querySelector('[data-pri-menu]') as HTMLElement;

  const flipOrder = wrap.closest('.nx-add-foot') != null;

  const refresh = (): void => {
    menu.innerHTML = priMenuHtml(getPriority(), flipOrder);
  };

  const close = (): void => {
    menu.classList.remove('nx-menu-open');
  };

  menu.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-p], .nx-pri-opt');
    if (!target?.dataset.p) return;
    onSelect(target.dataset.p as Priority);
    close();
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('nx-menu-open')) close();
    else {
      refresh();
      menu.classList.add('nx-menu-open');
    }
  });

  refresh();
  return { close, refresh };
}
