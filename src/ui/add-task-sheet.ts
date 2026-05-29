import { toStorage } from '../notes/codec';
import { bindPriMenu } from './pri-menu';
import { PRIORITY_META, type Priority } from '../types';

export function showAddTaskSheet(
  initialPriority: Priority,
  lockPriority: boolean,
  onSave: (description: string, notes: string, priority: Priority) => void
): () => void {
  let priority = initialPriority;
  const overlay = document.createElement('div');
  overlay.className = 'nx-overlay nx-overlay-sheet';
  overlay.innerHTML = `
    <div class="nx-bottom-sheet" role="dialog" data-sheet>
      <div class="nx-sheet-grab"></div>
      <input class="nx-add-title" data-title placeholder="What needs to be done?" />
      <input class="nx-add-notes" data-notes placeholder="Description" />
      <div class="nx-add-foot">
        <div class="nx-pri-wrap">
          <button type="button" class="nx-pri-pill" data-pri-btn style="--q-color:${PRIORITY_META[priority].color}">
            <span class="nx-pri-dot"></span>
            <span data-pri-label>${PRIORITY_META[priority].label.toUpperCase()}</span>
          </button>
          <div class="nx-pri-menu" data-pri-menu></div>
        </div>
        <button type="button" class="nx-send-btn" data-send aria-label="Save">➤</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const titleEl = overlay.querySelector('[data-title]') as HTMLInputElement;
  const notesEl = overlay.querySelector('[data-notes]') as HTMLInputElement;
  const priWrap = overlay.querySelector('.nx-pri-wrap') as HTMLElement;
  const priLabel = overlay.querySelector('[data-pri-label]') as HTMLElement;
  const priBtn = overlay.querySelector('[data-pri-btn]') as HTMLButtonElement;

  const paintPri = (): void => {
    const m = PRIORITY_META[priority];
    priBtn.style.setProperty('--q-color', m.color);
    priLabel.textContent = m.label.toUpperCase();
  };

  if (!lockPriority) {
    bindPriMenu(priWrap, () => priority, (p) => {
      priority = p;
      paintPri();
    });
    document.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.nx-pri-wrap')) {
        priWrap.querySelector('[data-pri-menu]')?.classList.remove('nx-menu-open');
      }
    });
  } else {
    priBtn.style.pointerEvents = 'none';
    priBtn.style.opacity = '0.85';
  }

  const close = (): void => overlay.remove();

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const submit = (): void => {
    const desc = titleEl.value.trim();
    if (!desc) return;
    const notesRaw = notesEl.value.trim();
    const notes = notesRaw
      ? toStorage([
          {
            id: crypto.randomUUID(),
            type: 'TEXT' as const,
            text: notesRaw,
            checked: false,
            indent: 0,
            bold: false,
            underline: false,
            localScale: 1,
            spans: [],
            sortKey: -1
          }
        ])
      : '';
    onSave(desc, notes, priority);
    close();
  };

  overlay.querySelector('[data-send]')?.addEventListener('click', submit);
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  setTimeout(() => titleEl.focus(), 80);
  return close;
}
