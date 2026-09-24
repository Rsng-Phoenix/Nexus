import { PUSH_WORKER_URL } from '../config';
import * as db from '../db/tasks';
import { fromStorage, toPlainText } from '../notes/codec';
import { getSettings, subscribeSettings } from '../settings/store';
import { activeTasks, onTasksWritten } from '../state/store';
import type { Task } from '../types';
import { PRIORITY_META } from '../types';
import { upcomingFires } from './schedule';

/**
 * Reminders on the web.
 * - With the push relay: the device registers once; after every change the next 7 days of rings
 *   are sent to the relay, which wakes the service worker even when Nexus is closed.
 * - Without it (or before permission): rings are fired by timers while the app is open.
 * The service worker reads tasks from IndexedDB, so titles never leave the device.
 */

type Device = { deviceId: string; secret: string };
const HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

export const pushConfigured = () => !!PUSH_WORKER_URL;
export const notificationsSupported = () => typeof Notification !== 'undefined' && 'serviceWorker' in navigator;

async function device(): Promise<Device | null> {
  const raw = await db.getMeta('push_device');
  return raw ? (JSON.parse(raw) as Device) : null;
}

function authHeader(d: Device) {
  return { Authorization: `Bearer ${d.deviceId}.${d.secret}`, 'Content-Type': 'application/json' };
}

function urlB64ToBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Ask permission (must run from a tap on iPhone) and register this device with the relay. */
export async function enableNotifications(): Promise<'on' | 'local' | 'denied' | 'unsupported' | 'error'> {
  if (!notificationsSupported()) return 'unsupported';
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (perm !== 'granted') return 'denied';
  if (!pushConfigured()) {
    void scheduleAll();
    return 'local';
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = (await (await fetch(`${PUSH_WORKER_URL}/vapid`)).json()) as { publicKey: string };
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(publicKey) as BufferSource });
    const existing = await device();
    const res = await fetch(`${PUSH_WORKER_URL}/register`, {
      method: 'POST',
      headers: existing ? authHeader(existing) : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() })
    });
    if (!res.ok) return 'error';
    const out = (await res.json()) as { deviceId: string; secret?: string };
    await db.setMeta('push_device', JSON.stringify({ deviceId: out.deviceId, secret: out.secret ?? existing?.secret }));
    await scheduleAll();
    return 'on';
  } catch {
    return 'error';
  }
}

export async function notificationState(): Promise<'on' | 'local' | 'off' | 'blocked' | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  return pushConfigured() && (await device()) ? 'on' : 'local';
}

type Ring = { ref: string; fireAt: number; kind: 'task' | 'checkin' };

function computeRings(tasks: Task[], now: number): Ring[] {
  const s = getSettings();
  const w = { startHour: s.windowStart, endHour: s.windowEnd };
  const rings: Ring[] = [];
  for (const t of tasks) {
    if (t.reminderTime == null || t.isCompleted || t.isWontDo || t.archivedAt > 0 || t.deletedAt > 0) continue;
    for (const at of upcomingFires(t, now, HORIZON_MS, w)) rings.push({ ref: t.taskUuid, fireAt: at, kind: 'task' });
  }
  // "You haven't opened Nexus in a while": re-armed every time the app is used.
  if (s.checkInEnabled) rings.push({ ref: 'checkin', fireAt: now + s.checkInDays * 86_400_000, kind: 'checkin' });
  return rings.sort((a, b) => a.fireAt - b.fireAt).slice(0, 500);
}

let timer = 0;
let localTimers: number[] = [];

/** Recompute and publish the schedule (debounced). */
export function scheduleAll(delay = 800): Promise<void> {
  clearTimeout(timer);
  return new Promise((resolve) => {
    timer = window.setTimeout(async () => {
      await publish();
      resolve();
    }, delay);
  });
}

async function publish(): Promise<void> {
  await mirrorSettingsForSw();
  const rings = computeRings(activeTasks.value, Date.now());
  armLocal(rings);
  const d = pushConfigured() ? await device() : null;
  if (!d) return;
  try {
    await fetch(`${PUSH_WORKER_URL}/reminders`, {
      method: 'PUT',
      headers: authHeader(d),
      body: JSON.stringify({ reminders: rings })
    });
  } catch {
    /* offline: the next change or app open republishes */
  }
}

/** While Nexus is open, fire due rings locally too (covers "no relay" and offline). */
function armLocal(rings: Ring[]): void {
  localTimers.forEach(clearTimeout);
  localTimers = [];
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  const usePush = pushConfigured();
  const now = Date.now();
  for (const r of rings) {
    if (r.kind !== 'task') continue;
    const delay = r.fireAt - now;
    if (delay < 0 || delay > 24 * 3600_000) continue;
    localTimers.push(
      window.setTimeout(async () => {
        // With push, the service worker already shows it; only ring locally if the page is visible
        // and push isn't set up.
        if (usePush && (await device())) return;
        const reg = await navigator.serviceWorker.ready;
        const t = activeTasks.value.find((x) => x.taskUuid === r.ref);
        if (!t) return;
        await reg.showNotification(t.description, notificationOptions(t, getSettings().snoozeMinutes));
      }, delay)
    );
  }
}

export function notificationOptions(t: Task, snoozeMin: number): NotificationOptions & { actions?: unknown[] } {
  const notes = toPlainText(fromStorage(t.notes)).trim().slice(0, 240);
  const recurring = t.reminderDateOnly || t.reminderEndDate > 0;
  return {
    body: notes || (recurring ? 'Reminder · repeats today' : 'Reminder'),
    tag: `task:${t.taskUuid}`,
    icon: './icons/icon-192.png',
    badge: './icons/badge-72.png',
    data: { ref: t.taskUuid, kind: 'task' },
    requireInteraction: t.isPinned,
    actions: [
      { action: 'done', title: 'Done' },
      { action: 'snooze', title: `Snooze ${snoozeMin < 60 ? `${snoozeMin}m` : `${snoozeMin / 60}h`}` }
    ],
    // Some browsers show this under the title.
    ...({ subtitle: `${PRIORITY_META[t.priority].label} priority` } as object)
  };
}

/** The service worker can't read localStorage; give it the few settings it needs. */
async function mirrorSettingsForSw(): Promise<void> {
  const s = getSettings();
  await db.setMeta(
    'sw_settings',
    JSON.stringify({ snoozeMinutes: s.snoozeMinutes, displayName: s.displayName, worker: PUSH_WORKER_URL })
  );
}

export function initReminders(): void {
  onTasksWritten(() => void scheduleAll());
  subscribeSettings(() => void scheduleAll(1500));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void publish(); // re-arm the check-in on leave
  });
  void scheduleAll(1200);
}

/** Ask the relay to push a test notification to this device right now. */
export async function sendTestPush(): Promise<boolean> {
  const d = pushConfigured() ? await device() : null;
  if (!d) return false;
  try {
    const res = await fetch(`${PUSH_WORKER_URL}/test`, { method: 'POST', headers: authHeader(d) });
    return res.ok && ((await res.json()) as { status: number }).status < 300;
  } catch {
    return false;
  }
}

/** iPhone/iPad only allow web notifications for an app added to the Home Screen. */
export const needsHomeScreenInstall = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) &&
  !(navigator as Navigator & { standalone?: boolean }).standalone &&
  !matchMedia('(display-mode: standalone)').matches;
