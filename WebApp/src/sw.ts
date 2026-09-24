/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import * as db from './db/tasks';
import { fromStorage, toPlainText } from './notes/codec';
import { formatReminderLabel } from './reminder-label';
import { markCompleted } from './task-utils';
import type { Task } from './types';
import { PRIORITY_META } from './types';

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
type SwSettings = { snoozeMinutes: number; displayName: string; worker: string };
type Push = { kind: 'task' | 'checkin' | 'test'; ref: string; fireAt: number };

async function swSettings(): Promise<SwSettings> {
  try {
    return { snoozeMinutes: 10, displayName: '', worker: '', ...JSON.parse((await db.getMeta('sw_settings')) || '{}') };
  } catch {
    return { snoozeMinutes: 10, displayName: '', worker: '' };
  }
}

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
      if (data.kind === 'checkin') return showCheckIn(s);
      if (data.kind === 'test') {
        return self.registration.showNotification('Nexus reminders are on', {
          body: 'You will get reminders here even when Nexus is closed.',
          icon: './icons/icon-192.png',
          tag: 'nexus-test'
        });
      }
      const t = await taskByUuid(data.ref);
      // A push must always show something; if the task changed elsewhere, still say what it was.
      if (!t || t.deletedAt > 0 || t.isCompleted || t.isWontDo) {
        return self.registration.showNotification('Nexus', {
          body: t ? `“${t.description}” is already taken care of.` : 'A reminder from Nexus',
          tag: `task:${data.ref}`,
          icon: './icons/icon-192.png',
          silent: true
        });
      }
      const notes = toPlainText(fromStorage(t.notes)).trim().slice(0, 240);
      const snooze = s.snoozeMinutes < 60 ? `${s.snoozeMinutes}m` : `${s.snoozeMinutes / 60}h`;
      await self.registration.showNotification(t.description, {
        body: notes || (isRecurring(t) ? `${PRIORITY_META[t.priority].label} · repeats today` : `${PRIORITY_META[t.priority].label} priority reminder`),
        tag: `task:${t.taskUuid}`,
        icon: './icons/icon-192.png',
        badge: './icons/badge-72.png',
        requireInteraction: t.isPinned,
        data: { ref: t.taskUuid, kind: 'task' },
        actions: [
          { action: 'done', title: 'Done' },
          { action: 'snooze', title: `Snooze ${snooze}` }
        ]
      } as NotificationOptions);
      // Same as Android: an exact reminder has done its job once it rang.
      if (!isRecurring(t)) {
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
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((c) => c.postMessage({ type: 'nexus:reload' }));
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
  const data = (n.data ?? {}) as { ref?: string; kind?: string };
  n.close();
  event.waitUntil(
    (async () => {
      if (event.action === 'done' && data.ref) {
        const t = await taskByUuid(data.ref);
        if (t && !t.isCompleted) await db.updateTask(markCompleted(t));
        await afterBackgroundWrite();
        return;
      }
      if (event.action === 'snooze' && data.ref) {
        const s = await swSettings();
        const auth = await deviceAuth();
        const fireAt = Date.now() + s.snoozeMinutes * 60_000;
        if (s.worker && auth) {
          await fetch(`${s.worker}/snooze`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: data.ref, fireAt, kind: 'task' })
          }).catch(() => undefined);
        }
        return;
      }
      // Tap: focus Nexus (or open it) on that task.
      const url = new URL(data.ref && data.kind === 'task' ? `./?task=${encodeURIComponent(data.ref)}` : './', self.registration.scope).href;
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clients[0] as WindowClient | undefined;
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'nexus:open-task', ref: data.ref });
      } else await self.clients.openWindow(url);
    })()
  );
});
