import { markWontDo } from '../task-utils';
import { fromStorage, toStorage } from '../notes/codec';
import { taskSharePayload } from '../share/export';
import { notesToolbar, renderNotesEditor } from './notes';
import { bindPriMenu } from './pri-menu';
import { showShareSheet } from './share-sheet';
import { PRIORITY_META, type Priority, type Task } from '../types';

export function showTaskDetailSheet(
  task: Task,
  onSave: (task: Task) => void | Promise<void>,
  onDelete: (task: Task) => void | Promise<void>
): () => void {
  let current = { ...task };
  let priority = task.priority;

  const overlay = document.createElement('div');
  overlay.className = 'nx-overlay nx-overlay-sheet';
  overlay.innerHTML = `
    <div class="nx-bottom-sheet nx-detail-sheet" role="dialog" data-sheet>
      <div class="nx-sheet-grab"></div>
      <div class="nx-detail-top">
        <div class="nx-pri-wrap">
          <button type="button" class="nx-pri-pill" data-pri-btn>
            <span class="nx-pri-dot"></span>
            <span data-pri-label></span>
          </button>
          <div class="nx-pri-menu" data-pri-menu></div>
        </div>
        <div class="nx-detail-actions">
          <div class="nx-more-wrap">
            <button type="button" class="nx-icon-btn" data-more title="More">⋮</button>
            <div class="nx-dropdown" data-more-menu>
              <button type="button" data-pin><span>★</span> Pin</button>
              <button type="button" data-skip><span>✕</span> Skip</button>
              <button type="button" data-reminder><span>🔔</span> Add reminder</button>
              <button type="button" data-share><span>⎘</span> Share</button>
              <button type="button" data-del><span>🗑</span> Delete</button>
            </div>
          </div>
          <button type="button" class="nx-send-btn" data-save aria-label="Save">➤</button>
        </div>
      </div>
      <div class="nx-detail-title-row">
        <input type="checkbox" class="nx-task-check nx-detail-check" data-done />
        <input class="nx-detail-title" data-title placeholder="Task title" />
      </div>
      <p class="nx-detail-notes-label">Description</p>
      <div class="nx-detail-notes" data-notes></div>
      <div class="nx-toolbar" data-toolbar></div>
    </div>`;

  document.body.appendChild(overlay);
  const sheet = overlay.querySelector('[data-sheet]') as HTMLElement;
  const priWrap = overlay.querySelector('.nx-pri-wrap') as HTMLElement;
  const priLabel = overlay.querySelector('[data-pri-label]') as HTMLElement;
  const priBtn = overlay.querySelector('[data-pri-btn]') as HTMLButtonElement;
  const titleEl = overlay.querySelector('[data-title]') as HTMLInputElement;
  const doneEl = overlay.querySelector('[data-done]') as HTMLInputElement;
  const titleRow = overlay.querySelector('.nx-detail-title-row') as HTMLElement;
  const notesEl = overlay.querySelector('[data-notes]') as HTMLElement;
  const moreMenu = overlay.querySelector('[data-more-menu]') as HTMLElement;
  const moreBtn = overlay.querySelector('[data-more]') as HTMLButtonElement;

  sheet.addEventListener('click', (e) => e.stopPropagation());
  sheet.addEventListener('pointerdown', (e) => e.stopPropagation());

  const paintPri = (): void => {
    const m = PRIORITY_META[priority];
    priBtn.style.setProperty('--q-color', m.color);
    sheet.style.setProperty('--q-color', m.color);
    titleRow.style.setProperty('--q-color', m.color);
    priLabel.textContent = m.label.toUpperCase();
  };

  const paintDone = (): void => {
    doneEl.checked = current.isCompleted;
    titleEl.classList.toggle('is-done', current.isCompleted);
    titleRow.classList.toggle('is-done', current.isCompleted);
  };

  const pri = bindPriMenu(priWrap, () => priority, (p) => {
    priority = p;
    current.priority = priority;
    paintPri();
  });

  titleEl.value = current.description;
  paintPri();
  paintDone();

  let blocks = fromStorage(current.notes);
  const editor = renderNotesEditor(notesEl, current.notes, (storage) => {
    current.notes = storage;
    blocks = fromStorage(storage);
  });
  const toolbar = overlay.querySelector('[data-toolbar]') as HTMLElement;
  notesToolbar(
    toolbar,
    notesEl,
    editor.getBlocks,
    (b) => {
      blocks = b;
      editor.setBlocks(b);
    },
    () => {
      blocks = editor.getBlocks();
      current.notes = toStorage(blocks);
    },
    () =>
      (document.activeElement as HTMLElement | null)?.closest('.nx-note-edit') as HTMLElement | null
  );

  const closeMenus = (): void => {
    pri.close();
    moreMenu.classList.remove('nx-menu-open');
  };

  document.addEventListener(
    'click',
    (e) => {
      if (!(e.target as HTMLElement).closest('.nx-pri-wrap, .nx-more-wrap')) closeMenus();
    },
    { capture: true }
  );

  const close = (): void => {
    document.removeEventListener('click', closeMenus, { capture: true });
    overlay.remove();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      void persist();
      close();
    }
  });

  const persist = async (): Promise<void> => {
    current.description = titleEl.value.trim() || current.description;
    current.isCompleted = doneEl.checked;
    current.priority = priority;
    current.updatedAt = Date.now();
    if (current.isCompleted && !current.completedAt) current.completedAt = Date.now();
    if (!current.isCompleted) current.completedAt = 0;
    await onSave(current);
  };

  overlay.querySelector('[data-save]')?.addEventListener('click', async () => {
    await persist();
    close();
  });

  doneEl.addEventListener('click', (e) => e.stopPropagation());
  doneEl.addEventListener('input', () => {
    current.isCompleted = doneEl.checked;
    paintDone();
  });
  doneEl.addEventListener('change', () => {
    current.isCompleted = doneEl.checked;
    paintDone();
  });

  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pri.close();
    moreMenu.classList.toggle('nx-menu-open');
  });

  const pinBtn = overlay.querySelector('[data-pin]') as HTMLButtonElement;
  const paintPin = (): void => {
    pinBtn.innerHTML = current.isPinned ? '<span>★</span> Unpin' : '<span>★</span> Pin';
  };
  paintPin();
  pinBtn.addEventListener('click', () => {
    current.isPinned = !current.isPinned;
    paintPin();
    moreMenu.classList.remove('nx-menu-open');
  });

  overlay.querySelector('[data-skip]')?.addEventListener('click', async () => {
    await onSave(markWontDo(current));
    close();
  });

  overlay.querySelector('[data-reminder]')?.addEventListener('click', () => {
    moreMenu.classList.remove('nx-menu-open');
    alert('Reminders are available in the Android app. Web sync keeps reminder data.');
  });

  overlay.querySelector('[data-share]')?.addEventListener('click', () => {
    moreMenu.classList.remove('nx-menu-open');
    showShareSheet(
      taskSharePayload({
        ...current,
        description: titleEl.value.trim() || current.description,
        notes: toStorage(blocks)
      })
    );
  });

  overlay.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!confirm('Delete this task?')) return;
    await onDelete(current);
    close();
  });

  return close;
}
