import './styles/main.css';
import * as db from './db/tasks';
import {
  getSettings,
  initSettings,
  patchSettings,
  sanitizeNickname,
  subscribeSettings,
  syncStatusLabel,
  topBarGreeting
} from './settings/store';
import { isSyncing, runSync, scheduleSync, signIn, signOut } from './sync/manager';
import { exportFullBackup, parseFullBackup, previewRestore } from './sync/backup';
import { showAboutSheet } from './ui/about-sheet';
import { nexusLogoHtml } from './ui/nexus-logo';
import { showProfileSheet, showProfileSignInSheet } from './ui/profile-sheet';
import { countDriveTasks } from './sync/manager';
import { showAddTaskSheet } from './ui/add-task-sheet';
import { bindTaskRows } from './ui/bind-tasks';
import { mountFab } from './ui/fab';
import { showTaskDetailSheet } from './ui/task-detail-sheet';
import { vibrateDelete, vibrateDragStep } from './lib/haptics';
import { hapticPulse, newTask, reorderIncomplete, tasksForPriority } from './task-utils';
import type { Priority, Task } from './types';
import { PRIORITIES, PRIORITY_META } from './types';

type View = { kind: 'matrix' } | { kind: 'quadrant'; priority: Priority };

export class NexusApp {
  private root: HTMLElement;
  private tasks: Task[] = [];
  private view: View = { kind: 'matrix' };
  private quadrantBounds = new Map<Priority, DOMRect>();
  private drag: {
    task: Task;
    ghost: HTMLElement;
    bounds: Map<Priority, DOMRect>;
  } | null = null;
  private snackTimer: ReturnType<typeof setTimeout> | null = null;
  private fabEl: HTMLButtonElement | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    initSettings();
    subscribeSettings(() => this.render());
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    this.tasks = await db.getActiveTasks();
    this.render();
    if (getSettings().googleEmail) void runSync().then(() => this.reload());
    setInterval(() => {
      if (getSettings().googleEmail && !isSyncing()) void runSync();
    }, 15 * 60 * 1000);
  }

  private async reload(): Promise<void> {
    this.tasks = await db.getActiveTasks();
    this.render();
  }

  private async save(task: Task): Promise<void> {
    const t = { ...task, updatedAt: Date.now() };
    await db.updateTask(t);
    this.tasks = await db.getActiveTasks();
    scheduleSync();
    this.render();
    hapticPulse();
  }

  private async insert(partial: Omit<Task, 'id'>): Promise<void> {
    await db.insertTask(partial);
    this.tasks = await db.getActiveTasks();
    scheduleSync();
    this.render();
    hapticPulse();
  }

  private snack(msg: string): void {
    const el = document.querySelector('.nx-snackbar');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (this.snackTimer) clearTimeout(this.snackTimer);
    this.snackTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  private getTask = (id: number): Task | undefined =>
    this.tasks.find((t) => t.id === id);

  private openAdd(priority: Priority, lock = false): void {
    showAddTaskSheet(priority, lock, (description, notes, p) => {
      void this.addTask(description, notes, p);
    });
  }

  private async addTask(
    description: string,
    notes: string,
    priority: Priority
  ): Promise<void> {
    await this.insert({
      ...newTask(description, priority),
      notes,
      position: 2147483647
    });
    this.snack('Task added');
  }

  private openTask(task: Task): void {
    showTaskDetailSheet(
      task,
      (t) => this.save(t),
      async (t) => {
        vibrateDelete();
        await db.softDeleteTask(t);
        this.tasks = await db.getActiveTasks();
        scheduleSync();
        this.render();
      }
    );
  }

  private render(): void {
    if (this.view.kind === 'quadrant') {
      this.renderFullQuadrant(this.view.priority);
      return;
    }
    this.renderMatrix();
  }

  private refreshBounds(): void {
    this.quadrantBounds.clear();
    PRIORITIES.forEach((p) => {
      const q = this.root.querySelector(`[data-q="${p}"]`) as HTMLElement | null;
      if (q) this.quadrantBounds.set(p, q.getBoundingClientRect());
    });
  }

  private renderMatrix(): void {
    this.root.innerHTML = `
      <div class="nx-shell">
        <header class="nx-topbar">
          <div class="nx-brand" data-about>
            <span class="nx-brand-logo">${nexusLogoHtml(32)}</span>
            <div class="nx-brand-text">
              <h1>NEXUS</h1>
              <span>priority matrix</span>
            </div>
          </div>
          <button class="nx-profile" type="button" data-settings aria-label="Profile and settings">
            <div class="nx-avatar">${avatarHtml()}</div>
            <span class="nx-greeting">${escape(topBarGreeting())}</span>
          </button>
        </header>
        <main class="nx-main" data-pull>
          <div class="nx-matrix-wrap">
            <div class="nx-matrix-row">${rowHtml(this.tasks, ['HIGH', 'MEDIUM'])}</div>
            <div class="nx-matrix-row">${rowHtml(this.tasks, ['LOW', 'NONE'])}</div>
          </div>
        </main>
        <div class="nx-fab-slot"></div>
        <div class="nx-snackbar"></div>
      </div>`;

    this.root.querySelector('[data-about]')?.addEventListener('click', () => {
      showAboutSheet(() => this.showSettings());
    });
    this.root.querySelector('[data-settings]')?.addEventListener('click', () => {
      void this.showProfile();
    });

    const slot = this.root.querySelector('.nx-fab-slot') as HTMLElement;
    this.fabEl = mountFab({
      onOpenAdd: (p) => this.openAdd(p),
      getQuadrantBounds: () => {
        this.refreshBounds();
        return this.quadrantBounds;
      },
      onHighlight: (p) => {
        this.root.querySelectorAll('.nx-quadrant').forEach((q) => {
          q.classList.toggle('nx-highlight', q.getAttribute('data-q') === p);
        });
      },
      onQuadrantHover: () => vibrateDragStep()
    });
    slot.appendChild(this.fabEl);

    const main = this.root.querySelector('[data-pull]') as HTMLElement;
    this.bindPullRefresh(main);

    requestAnimationFrame(() => {
      this.refreshBounds();
      PRIORITIES.forEach((p) => {
        const q = this.root.querySelector(`[data-q="${p}"]`) as HTMLElement;
        q?.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('.nx-task')) return;
          this.view = { kind: 'quadrant', priority: p };
          this.render();
        });
        bindTaskRows(
          q,
          this.getTask,
          (t) => this.save(t),
          (t) => this.openTask(t),
          {
            dragEnabled: true,
            onDragStart: (task, el, e) =>
              this.startDrag(task, el, this.quadrantBounds, e)
          }
        );
      });
    });
  }

  private bindPullRefresh(main: HTMLElement): void {
    let startY = 0;
    main.addEventListener(
      'touchstart',
      (e) => {
        if (main.scrollTop === 0) startY = e.touches[0].clientY;
      },
      { passive: true }
    );
    main.addEventListener(
      'touchend',
      async (e) => {
        const dy = e.changedTouches[0].clientY - startY;
        if (dy > 80 && getSettings().googleEmail) {
          this.snack('Syncing…');
          const r = await runSync();
          await this.reload();
          this.snack(r.message);
        }
      },
      { passive: true }
    );
  }

  private startDrag(
    task: Task,
    el: HTMLElement,
    bounds: Map<Priority, DOMRect>,
    e: PointerEvent
  ): void {
    el.setPointerCapture(e.pointerId);
    const ghost = document.createElement('div');
    ghost.className = 'nx-drag-ghost';
    ghost.textContent = task.description;
    document.body.appendChild(ghost);
    el.classList.add('dragging');
    this.drag = { task, ghost, bounds };

    const move = (ev: PointerEvent) => {
      ghost.style.left = `${ev.clientX}px`;
      ghost.style.top = `${ev.clientY}px`;
      let found: Priority | null = null;
      for (const [p, r] of bounds) {
        if (pointInRect(ev.clientX, ev.clientY, r)) found = p;
      }
      this.root.querySelectorAll('.nx-quadrant').forEach((q) => {
        q.classList.toggle('nx-highlight', q.getAttribute('data-q') === found);
      });
    };

    const up = async (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.classList.remove('dragging');
      ghost.remove();
      let target: Priority | null = null;
      for (const [p, r] of bounds) {
        if (pointInRect(ev.clientX, ev.clientY, r)) target = p;
      }
      if (target && target !== task.priority) {
        vibrateDragStep();
        await this.save({ ...task, priority: target });
      }
      this.drag = null;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      this.render();
    };

    move(e);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  private renderFullQuadrant(priority: Priority): void {
    const meta = PRIORITY_META[priority];
    const list = tasksForPriority(this.tasks, priority);
    const incomplete = list.filter((t) => !t.isCompleted && !t.isWontDo);
    const wont = list.filter((t) => t.isWontDo);
    const done = list.filter((t) => t.isCompleted);

    const section = (label: string, items: Task[], reorder: boolean) => `
      <div class="nx-section-label">${label}</div>
      ${items.map((t, i) => taskRowHtml(t, reorder ? i : -1, priority)).join('')}`;

    this.root.innerHTML = `
      <div class="nx-full-q" style="--q-color:${meta.color}">
        <div class="nx-full-q-head">
          <button class="nx-btn ghost" type="button" data-back>←</button>
          <h2>${meta.label}</h2>
          <span class="nx-q-count">${list.length}</span>
        </div>
        <div class="nx-full-list">
          ${section('ACTIVE', incomplete, true)}
          ${wont.length ? section("WON'T DO", wont, false) : ''}
          ${done.length ? section('COMPLETED', done, false) : ''}
        </div>
        <div class="nx-fab-slot nx-fab-slot--q"></div>
      </div>`;

    this.root.querySelector('[data-back]')?.addEventListener('click', () => {
      this.view = { kind: 'matrix' };
      this.render();
    });

    const slot = this.root.querySelector('.nx-fab-slot') as HTMLElement;
    const qFab = mountFab({
      onOpenAdd: () => this.openAdd(priority, true),
      getQuadrantBounds: () => new Map(),
      onHighlight: () => {},
      onQuadrantHover: () => vibrateDragStep()
    });
    qFab.classList.add('nx-fab--quadrant');
    qFab.style.setProperty('--q-color', meta.color);
    slot.appendChild(qFab);

    bindTaskRows(
      this.root,
      this.getTask,
      (t) => this.save(t),
      (t) => this.openTask(t),
      {
        dragEnabled: true,
        onDragStart: (task, el, e) => {
          void task;
          void el;
          void e;
        }
      }
    );

    this.bindFullListReorder(priority, incomplete);
  }

  private bindFullListReorder(priority: Priority, incomplete: Task[]): void {
    let dragIdx = -1;
    let lastY = 0;
    const step = 52;

    this.root.querySelectorAll<HTMLElement>('.nx-task[data-idx]').forEach((el) => {
      const idx = Number(el.dataset.idx);
      if (idx < 0) return;
      let timer: ReturnType<typeof setTimeout> | null = null;

      el.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('.nx-task-check')) return;
        timer = setTimeout(() => {
          dragIdx = idx;
          lastY = e.clientY;
          el.classList.add('dragging');
        }, 420);
      });
      const clear = () => {
        if (timer) clearTimeout(timer);
      };
      el.addEventListener('pointerup', clear);
      el.addEventListener('pointercancel', clear);

      el.addEventListener('pointermove', async (e) => {
        if (dragIdx < 0) return;
        const dy = e.clientY - lastY;
        if (Math.abs(dy) < step) return;
        const to = dy > 0 ? dragIdx + 1 : dragIdx - 1;
        if (to < 0 || to >= incomplete.length) return;
        lastY = e.clientY;
        this.tasks = reorderIncomplete(this.tasks, priority, dragIdx, to);
        dragIdx = to;
        for (const t of this.tasks.filter(
          (x) => x.priority === priority && !x.isCompleted && !x.isWontDo
        )) {
          await db.updateTask({ ...t, updatedAt: Date.now() });
        }
        scheduleSync();
        this.renderFullQuadrant(priority);
      });

      el.addEventListener('pointerup', () => {
        dragIdx = -1;
        el.classList.remove('dragging');
      });
    });
  }

  private async showProfile(): Promise<void> {
    const s = getSettings();
    const localTaskCount = this.tasks.filter((t) => t.deletedAt === 0).length;
    if (!s.googleEmail) {
      showProfileSignInSheet({
        onOpenSettings: () => this.showSettings(),
        onReload: () => this.reload(),
        snack: (m) => this.snack(m)
      });
      return;
    }
    const driveTaskCount = await countDriveTasks();
    showProfileSheet({
      localTaskCount,
      driveTaskCount,
      onOpenSettings: () => this.showSettings(),
      onReload: () => this.reload(),
      snack: (m) => this.snack(m)
    });
  }

  private showSettings(): void {
    const s = getSettings();
    const overlay = document.createElement('div');
    overlay.className = 'nx-overlay';
    overlay.innerHTML = `
      <div class="nx-sheet wide" role="dialog">
        <div class="nx-sheet-head"><strong>Settings</strong><button class="nx-btn ghost" data-x>✕</button></div>
        <div class="nx-sheet-body">
          <div class="nx-setting">
            <div><label>Layout</label><small>Auto uses full width on desktop</small></div>
            <div class="nx-seg">
              <button type="button" data-layout="auto" class="${s.layoutMode === 'auto' ? 'on' : ''}">Auto</button>
              <button type="button" data-layout="phone" class="${s.layoutMode === 'phone' ? 'on' : ''}">Phone</button>
              <button type="button" data-layout="desktop" class="${s.layoutMode === 'desktop' ? 'on' : ''}">Desktop</button>
            </div>
          </div>
          <div class="nx-setting">
            <div><label>Theme</label></div>
            <div class="nx-seg">
              ${(['SYSTEM', 'LIGHT', 'DARK'] as const)
                .map(
                  (m) =>
                    `<button type="button" data-theme="${m}" class="${s.themeMode === m ? 'on' : ''}">${m[0] + m.slice(1).toLowerCase()}</button>`
                )
                .join('')}
            </div>
          </div>
          <div class="nx-setting">
            <div><label>Display name</label></div>
            <input class="nx-input" data-name value="${escapeAttr(s.displayName)}" maxlength="12" />
          </div>
          <div class="nx-setting">
            <div><label>Font size</label><small>${Math.round(s.fontScale * 100)}%</small></div>
            <input type="range" data-font min="0.85" max="1.45" step="0.05" value="${s.fontScale}" style="width:120px" />
          </div>
          <div class="nx-setting">
            <div><label>Auto-arrange checkboxes</label></div>
            <input type="checkbox" data-arrange ${s.autoArrange ? 'checked' : ''} />
          </div>
          <div class="nx-setting">
            <div><label>Google sync</label><small>${escape(syncStatusLabel())}</small></div>
            ${s.googleEmail ? `<button class="nx-btn ghost" data-sync>Refresh</button>` : ''}
          </div>
          ${
            s.googleEmail
              ? `<p style="font-size:12px;color:var(--nx-textSec);margin:8px 0">${escape(s.googleEmail)}</p>
                 <button class="nx-btn ghost" data-signout style="width:100%">Sign out</button>`
              : `<button class="nx-btn" data-signin style="width:100%">Sign in with Google</button>`
          }
          <div class="nx-setting" style="margin-top:12px">
            <button class="nx-btn ghost" data-export>Export backup</button>
            <label class="nx-btn ghost" style="cursor:pointer">Import<input type="file" data-import accept=".json" hidden /></label>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('[data-x]')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    overlay.querySelector('[data-name]')?.addEventListener('change', (e) => {
      patchSettings({
        displayName: sanitizeNickname((e.target as HTMLInputElement).value)
      });
    });

    overlay.querySelectorAll('[data-layout]').forEach((b) => {
      b.addEventListener('click', () => {
        patchSettings({
          layoutMode: (b as HTMLElement).dataset.layout as 'auto' | 'phone' | 'desktop'
        });
        close();
        this.render();
      });
    });
    overlay.querySelectorAll('[data-theme]').forEach((b) => {
      b.addEventListener('click', () => {
        patchSettings({
          themeMode: (b as HTMLElement).dataset.theme as 'SYSTEM' | 'LIGHT' | 'DARK'
        });
        close();
        this.showSettings();
      });
    });
    overlay.querySelector('[data-font]')?.addEventListener('input', (e) => {
      patchSettings({
        fontScale: parseFloat((e.target as HTMLInputElement).value)
      });
    });
    overlay.querySelector('[data-arrange]')?.addEventListener('change', (e) => {
      patchSettings({
        autoArrange: (e.target as HTMLInputElement).checked
      });
    });
    overlay.querySelector('[data-signin]')?.addEventListener('click', async () => {
      const ok = await signIn();
      this.snack(ok ? 'Signed in' : 'Sign-in failed');
      await this.reload();
      close();
    });
    overlay.querySelector('[data-signout]')?.addEventListener('click', () => {
      signOut();
      close();
      this.render();
    });
    overlay.querySelector('[data-sync]')?.addEventListener('click', async () => {
      const r = await runSync();
      await this.reload();
      this.snack(r.message);
    });
    overlay.querySelector('[data-export]')?.addEventListener('click', async () => {
      const all = await db.getAllTasksIncludingDeleted();
      const blob = new Blob([exportFullBackup(all)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `nexus_backup_${Date.now()}.json`;
      a.click();
    });
    overlay.querySelector('[data-import]')?.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const incoming = parseFullBackup(text);
        if (!incoming.length) {
          this.snack('No tasks in backup file');
          return;
        }
        const existing = await db.getAllTasksIncludingDeleted();
        if (!existing.length) {
          await db.replaceAllTasks(incoming);
          scheduleSync();
          await this.reload();
          close();
          this.snack(`Restored ${incoming.length} tasks`);
          return;
        }
        const { duplicateCount, uniqueCount } = previewRestore(existing, incoming);
        const choice = await this.restoreChoiceDialog(
          incoming.length,
          existing.length,
          uniqueCount,
          duplicateCount
        );
        if (!choice) return;
        if (choice === 'replace') await db.replaceAllTasks(incoming);
        else await db.mergeRestoreTasks(incoming);
        scheduleSync();
        await this.reload();
        close();
        this.snack(choice === 'replace' ? 'Backup replaced' : `Added ${uniqueCount} tasks`);
      } catch (err) {
        this.snack(err instanceof Error ? err.message : 'Invalid backup file');
      }
    });
  }

  private restoreChoiceDialog(
    backupCount: number,
    localCount: number,
    uniqueCount: number,
    duplicateCount: number
  ): Promise<'merge' | 'replace' | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'nx-overlay';
      overlay.innerHTML = `
        <div class="nx-sheet" role="dialog">
          <div class="nx-sheet-head"><strong>Restore backup</strong></div>
          <div class="nx-sheet-body">
            <p style="font-size:13px;color:var(--nx-textSec);line-height:1.5">
              Backup has ${backupCount} tasks. You have ${localCount} tasks now.<br>
              ${uniqueCount} new · ${duplicateCount} duplicates
            </p>
            <button type="button" class="nx-btn" data-merge style="width:100%;margin-top:12px">Add new only</button>
            <button type="button" class="nx-btn ghost" data-replace style="width:100%;margin-top:8px">Replace all (deletes current)</button>
            <button type="button" class="nx-btn ghost" data-cancel style="width:100%;margin-top:8px">Cancel</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const done = (v: 'merge' | 'replace' | null) => {
        overlay.remove();
        resolve(v);
      };
      overlay.querySelector('[data-merge]')?.addEventListener('click', () => done('merge'));
      overlay.querySelector('[data-replace]')?.addEventListener('click', () => done('replace'));
      overlay.querySelector('[data-cancel]')?.addEventListener('click', () => done(null));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) done(null);
      });
    });
  }
}

function taskRowHtml(t: Task, idx: number, priority: Priority): string {
  const dim = t.isCompleted || t.isWontDo;
  return `<div class="nx-task ${dim ? 'dim' : ''}" data-id="${t.id}" data-idx="${idx}" data-p="${priority}">
    <div class="nx-task-bar" style="background:${barColor(t)}"></div>
    <input type="checkbox" class="nx-task-check" ${t.isCompleted ? 'checked' : ''} aria-label="Complete" />
    <div class="nx-task-body">
      <span class="nx-task-title ${t.isCompleted ? 'done' : ''} ${t.isWontDo ? 'skip' : ''}">${escape(t.description)}</span>
      ${t.isPinned ? '<span class="nx-pin">★</span>' : ''}
    </div>
  </div>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escape(s).replace(/'/g, '&#39;');
}

function avatarHtml(): string {
  const s = getSettings();
  if (s.googlePhotoUrl)
    return `<img src="${escapeAttr(s.googlePhotoUrl)}" alt="" />`;
  const init = (s.displayName || s.googleEmail || 'U')[0]?.toUpperCase() ?? 'U';
  return init;
}

function barColor(t: Task): string {
  if (t.isPinned) return 'var(--nx-accent)';
  if (t.isWontDo) return 'var(--nx-textTer)';
  return PRIORITY_META[t.priority].color;
}

function pointInRect(x: number, y: number, r: DOMRect): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function rowHtml(tasks: Task[], priorities: Priority[]): string {
  return priorities
    .map((p) => {
      const meta = PRIORITY_META[p];
      const list = tasksForPriority(tasks, p);
      const tasksHtml = list.map((t) => taskRowHtml(t, -1, p)).join('');
      return `<div class="nx-quadrant" data-q="${p}" style="--q-color:${meta.color}">
        <div class="nx-q-head">
          <div class="nx-q-glyph">${meta.glyph}</div>
          <span class="nx-q-label">${meta.label}</span>
          ${list.length ? `<span class="nx-q-count">${list.length}</span>` : ''}
        </div>
        <div class="nx-q-tasks">${tasksHtml}</div>
      </div>`;
    })
    .join('');
}
