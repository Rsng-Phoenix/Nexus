import { PRIORITIES, PRIORITY_META, type Priority } from '../types';

export function priMenuHtml(current: Priority): string {
  const cur = PRIORITY_META[current];
  const options = PRIORITIES.map((p) => {
    const m = PRIORITY_META[p];
    return `<button type="button" data-p="${p}" class="${p === current ? 'nx-pri-active' : ''}">
      <span class="nx-pri-glyph" style="color:${m.color}">${m.glyph}</span>
      <span style="color:${m.color}">${m.label}</span>
    </button>`;
  }).join('');
  return `
    <div class="nx-pri-menu-current" style="--q-color:${cur.color}">
      <span class="nx-pri-glyph">${cur.glyph}</span>
      <span>${cur.label.toUpperCase()}</span>
    </div>
    ${options}`;
}

export function bindPriMenu(
  wrap: HTMLElement,
  getPriority: () => Priority,
  onSelect: (p: Priority) => void
): { close: () => void; refresh: () => void } {
  const btn = wrap.querySelector('[data-pri-btn]') as HTMLButtonElement;
  const menu = wrap.querySelector('[data-pri-menu]') as HTMLElement;

  const refresh = (): void => {
    menu.innerHTML = priMenuHtml(getPriority());
  };

  const close = (): void => {
    menu.classList.remove('nx-menu-open');
  };

  menu.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-p]');
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
