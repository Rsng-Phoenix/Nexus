/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import * as db from './db/tasks';
import { formatReminderLabel } from './reminder-label';
import { markCompleted } from './task-utils';
import { buildCalendar } from './calendar/items';
import { todayIso } from './calendar/deadline';
import type { Task } from './types';
import { PRIORITY_META } from './types';
import { addSnooze, deliverRing, meetingInfo, notifySettings, quietAck, type NotifySettings } from './reminders/notify';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// ─── Offline app shell ──────────────────────────────────────────────────────────
// New versions take over immediately (autoUpdate), so fixes reach installed apps on next open.
void self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// ─── Reminders ─────────────────────────────────────────────────────────────────
type SwSettings = NotifySettings;
type Push = { kind: 'task' | 'due' | 'task-s' | 'due-s' | 'meet' | 'checkin' | 'test'; ref: string; fireAt: number };

const swSettings = notifySettings;

async function taskByUuid(uuid: string): Promise<Task | undefined> {
  return (await db.getAllTasksIncludingDeleted()).find((t) => t.taskUuid === uuid);
}

const isRecurring = (t: Task) => t.reminderDateOnly || t.reminderEndDate > 0;

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data: Push = { kind: 'test', ref: 'test', fireAt: Date.now() };
      try {
        data = event.data?.json() as Push;
      } catch {
        /* keep default */
      }
      const s = await swSettings();
      if (data.kind === 'checkin') {
        if (s.pauseNotificationsUntil > Date.now()) return quietAck(self.registration);
        return showCheckIn(s);
      }
      if (data.kind === 'test') {
        return self.registration.showNotification('Nexus reminders are on', {
          body: 'You will get reminders here even when Nexus is closed.',
          icon: './icons/icon-192.png',
          tag: 'nexus-test'
        });
      }
      if (data.kind === 'meet') {
        const shown = await deliverRing(self.registration, { kind: 'meet', ref: data.ref, fireAt: data.fireAt }, undefined, await meetingInfo(data.ref));
        if (!shown) await quietAck(self.registration);
        return;
      }
      // "task-s" / "due-s" are snoozed rings (their time no longer matches the task's schedule).
      const raw = String(data.kind);
      const kind = raw.startsWith('due') ? 'due' : 'task';
      const snoozed = raw.endsWith('-s');
      const t = await taskByUuid(data.ref);
      const shown = await deliverRing(self.registration, { kind, ref: data.ref, fireAt: data.fireAt, snoozed }, t);
      if (!shown) await quietAck(self.registration);
      // Same as Android: an exact reminder has done its job once it rang.
      if (shown && t && kind === 'task' && !isRecurring(t) && t.reminderTime != null) {
        const label = formatReminderLabel(t.reminderTime, false, 0, 0) ?? '';
        await db.updateTask({
          ...t,
          reminderTime: null,
          reminderIntervalMinutes: 0,
          reminderEndDate: 0,
          reminderHistoryLabel: label,
          updatedAt: Date.now()
        });
        await afterBackgroundWrite();
      }
    })()
  );
});

async function showCheckIn(s: SwSettings): Promise<void> {
  const pending = (await db.getAllTasksIncludingDeleted()).filter(
    (t) => t.deletedAt === 0 && !t.isCompleted && !t.isWontDo && !(t.archivedAt > 0) && !t.taskUuid.startsWith('nexus-tutorial-')
  );
  if (!pending.length) return self.registration.showNotification('Nexus', { body: 'All clear. Nothing pending.', tag: 'checkin', silent: true });
  const counts = (['HIGH', 'MEDIUM', 'LOW', 'NONE'] as const)
    .map((p) => [p, pending.filter((t) => t.priority === p).length] as const)
    .filter(([, n]) => n > 0)
    .map(([p, n]) => `${n} ${PRIORITY_META[p].label.toLowerCase()}`);
  const summary = counts.length > 1 ? `${counts.slice(0, -1).join(', ')} and ${counts[counts.length - 1]}` : counts[0];
  const name = s.displayName.trim() || 'there';
  await self.registration.showNotification(`Hey ${name}, ${pending.length} task${pending.length === 1 ? '' : 's'} waiting`, {
    body: `You have ${summary} priority pending.`,
    tag: 'checkin',
    icon: './icons/icon-192.png'
  });
}

/** Tell open tabs to refresh, and make the next app open sync these changes to Drive. */
async function afterBackgroundWrite(): Promise<void> {
  await db.setMeta('pending_local_changes', '1');
  void renderAllWidgets();
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((c) => c.postMessage({ type: 'nexus:reload' }));
}

/** A task finished from a notification or widget: drop its future rings on the relay. */
async function cancelRemoteRings(ref: string): Promise<void> {
  const s = await swSettings();
  const auth = await deviceAuth();
  if (!s.worker || !auth) return;
  await fetch(`${s.worker}/cancel`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref })
  }).catch(() => undefined);
}

async function deviceAuth(): Promise<string | null> {
  try {
    const d = JSON.parse((await db.getMeta('push_device')) || 'null') as { deviceId: string; secret: string } | null;
    return d ? `Bearer ${d.deviceId}.${d.secret}` : null;
  } catch {
    return null;
  }
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = (n.data ?? {}) as { ref?: string; kind?: string; url?: string };
  n.close();
  event.waitUntil(
    (async () => {
      // Meeting heads-up: Join opens the video call; a tap opens the Nexus calendar.
      if (data.kind === 'meet') {
        if (event.action === 'join' && data.url && /^https:\/\//.test(data.url)) {
          await self.clients.openWindow(data.url);
          return;
        }
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = clients[0] as WindowClient | undefined;
        if (existing) {
          await existing.focus();
          existing.postMessage({ type: 'nexus:open-calendar' });
        } else await self.clients.openWindow(new URL('./?open=calendar', self.registration.scope).href);
        return;
      }
      if (event.action === 'done' && data.ref) {
        const t = await taskByUuid(data.ref);
        if (t && !t.isCompleted) await db.updateTask(markCompleted(t));
        await cancelRemoteRings(data.ref);
        await afterBackgroundWrite();
        return;
      }
      if (event.action === 'snooze' && data.ref) {
        const s = await swSettings();
        const auth = await deviceAuth();
        const fireAt = Date.now() + s.snoozeMinutes * 60_000;
        const kind = data.kind === 'due' ? 'due' : 'task';
        // Kept on the device too, so the app's next schedule publish includes it.
        await addSnooze({ ref: data.ref, kind, fireAt });
        if (s.worker && auth) {
          await fetch(`${s.worker}/snooze`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: data.ref, fireAt, kind: `${kind}-s` })
          }).catch(() => undefined);
        }
        return;
      }
      // Tap: focus Nexus (or open it) on that task.
      const one = data.ref && (data.kind === 'task' || data.kind === 'due');
      const url = new URL(one ? `./?task=${encodeURIComponent(data.ref!)}` : './', self.registration.scope).href;
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clients[0] as WindowClient | undefined;
      if (existing) {
        await existing.focus();
        if (one) existing.postMessage({ type: 'nexus:open-task', ref: data.ref });
      } else await self.clients.openWindow(url);
    })()
  );
});

// ─── Windows 11 widgets (Edge-installed app) ────────────────────────────────────
type WidgetDef = { tag: string; msAcTemplate?: string; data?: string };
type WidgetsApi = {
  getByTag: (tag: string) => Promise<{ definition: WidgetDef } | undefined>;
  updateByTag: (tag: string, payload: { template: string; data: string }) => Promise<void>;
};
type WidgetEvent = ExtendableEvent & { widget?: { definition: WidgetDef }; action?: string; data?: { json?: () => unknown } | string };
const widgetsApi = () => (self as unknown as { widgets?: WidgetsApi }).widgets;

const AC_COLOR: Record<Task['priority'], string> = { HIGH: 'Attention', MEDIUM: 'Warning', LOW: 'Accent', NONE: 'Good' };
const openTask = (t: Task) => t.deletedAt === 0 && !t.isCompleted && !t.isWontDo && !(t.archivedAt > 0) && !t.taskUuid.startsWith('nexus-tutorial-');

async function widgetData(tag: string): Promise<unknown> {
  const tasks = (await db.getAllTasksIncludingDeleted()).filter(openTask);
  if (tag === 'nexus-matrix') {
    const cell = (p: Task['priority']) => {
      const list = tasks.filter((t) => t.priority === p).sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || a.position - b.position);
      return { priority: p, label: PRIORITY_META[p].label, color: AC_COLOR[p], count: String(list.length), top1: list[0]?.description ?? 'Nothing here', top2: list[1]?.description ?? '' };
    };
    return { rows: [{ cells: [cell('HIGH'), cell('MEDIUM')] }, { cells: [cell('LOW'), cell('NONE')] }] };
  }
  const today = todayIso();
  const day = buildCalendar(tasks, [], today, today).get(today) ?? [];
  const overdue = tasks.filter((t) => t.dueDate && t.dueDate < today);
  const seen = new Set<string>();
  const items: unknown[] = [];
  const push = (t: Task, meta: string, late = false) => {
    if (seen.has(t.taskUuid) || items.length >= 8) return;
    seen.add(t.taskUuid);
    items.push({ uuid: t.taskUuid, text: t.description, meta, color: AC_COLOR[t.priority], metaColor: late ? 'Attention' : 'Default' });
  };
  for (const t of overdue) push(t, 'Overdue', true);
  for (const i of day) {
    if (i.type === 'event') continue;
    const meta = i.type === 'due' ? 'Due today' : i.time != null ? new Date(i.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'Reminder today';
    push(i.task, meta);
  }
  return {
    title: 'Today',
    subtitle: new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
    count: items.length,
    countLabel: items.length ? String(items.length) : '',
    items,
    empty: 'All clear today ✓'
  };
}

async function renderWidget(tag: string): Promise<void> {
  const api = widgetsApi();
  if (!api) return;
  const w = await api.getByTag(tag);
  if (!w?.definition.msAcTemplate) return;
  const template = await (await fetch(w.definition.msAcTemplate)).text();
  await api.updateByTag(tag, { template, data: JSON.stringify(await widgetData(tag)) });
}

async function renderAllWidgets(): Promise<void> {
  await Promise.all(['nexus-today', 'nexus-matrix'].map((t) => renderWidget(t).catch(() => undefined)));
}

for (const type of ['widgetinstall', 'widgetresume']) {
  self.addEventListener(type, (e) => {
    const ev = e as WidgetEvent;
    ev.waitUntil(ev.widget ? renderWidget(ev.widget.definition.tag) : renderAllWidgets());
  });
}

self.addEventListener('widgetclick', (e) => {
  const ev = e as WidgetEvent;
  ev.waitUntil(
    (async () => {
      let data: { uuid?: string; priority?: string } = {};
      try {
        data = (typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data?.json?.()) as typeof data ?? {};
      } catch {
        /* no payload */
      }
      if (ev.action === 'done' && data.uuid) {
        const t = await taskByUuid(data.uuid);
        if (t && !t.isCompleted) await db.updateTask(markCompleted(t));
        await cancelRemoteRings(data.uuid);
        await afterBackgroundWrite();
        await renderAllWidgets();
        return;
      }
      const q =
        ev.action === 'add' ? '?action=add' : data.uuid ? `?task=${encodeURIComponent(data.uuid)}` : data.priority ? `?open=quadrant&p=${data.priority}` : '';
      await self.clients.openWindow(new URL(`./${q}`, self.registration.scope).href);
    })()
  );
});

// The app asks for a refresh after any change; also re-render on each push.
self.addEventListener('message', (e) => {
  if (e.data?.type === 'nexus:widgets') e.waitUntil(renderAllWidgets());
});
