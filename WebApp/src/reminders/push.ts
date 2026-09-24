import { PUSH_WORKER_URL } from '../config';
import * as db from '../db/tasks';
import { getSettings, subscribeSettings } from '../settings/store';
import { activeTasks, onTasksWritten } from '../state/store';
import type { Task } from '../types';
import { upcomingDueFires } from '../calendar/deadline';
import { linkedState, onLinkedUpdated } from '../calendar/linked';
import { upcomingMeetings } from '../calendar/meetings';
import { deliverRing, pendingSnoozes, type MeetInfo, type NotifySettings } from './notify';
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
  try {
    return raw ? (JSON.parse(raw) as Device) : null;
  } catch {
    return null;
  }
}

/** Authorization for this device's calls to the relay (null until notifications are on). */
export async function workerAuth(): Promise<Record<string, string> | null> {
  const d = pushConfigured() ? await device() : null;
  return d ? authHeader(d) : null;
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

type Ring = { ref: string; fireAt: number; kind: 'task' | 'due' | 'task-s' | 'due-s' | 'checkin' | 'meet' };

export function computeRings(tasks: Task[], now: number): Ring[] {
  const s = getSettings();
  const w = { startHour: s.windowStart, endHour: s.windowEnd };
  // Paused: nothing is scheduled before the pause ends (and nothing is replayed after it).
  const from = Math.max(now, s.pauseNotificationsUntil);
  const horizon = HORIZON_MS - (from - now);
  const rings: Ring[] = [];
  if (horizon > 0) {
    for (const t of tasks) {
      if (t.isCompleted || t.isWontDo || t.archivedAt > 0 || t.deletedAt > 0) continue;
      if (s.notifyReminders && t.reminderTime != null) {
        for (const at of upcomingFires(t, from, horizon, w)) rings.push({ ref: t.taskUuid, fireAt: at, kind: 'task' });
      }
      if (s.notifyDeadlines) {
        for (const f of upcomingDueFires(t, from, horizon)) rings.push({ ref: t.taskUuid, fireAt: f.fireAt, kind: 'due' });
      }
    }
  }
  // "You haven't opened Nexus in a while": re-armed every time the app is used.
  if (s.checkInEnabled) rings.push({ ref: 'checkin', fireAt: Math.max(from, now + s.checkInDays * 86_400_000), kind: 'checkin' });
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

let retryTimer = 0;
const RETRY_MS = 60_000;

async function publish(): Promise<void> {
  clearTimeout(retryTimer);
  await mirrorSettingsForSw();
  const now = Date.now();
  const s = getSettings();
  const rings = computeRings(activeTasks.value, now);
  // Snoozed rings (from notification buttons) survive every re-publish until they ring.
  const paused = s.pauseNotificationsUntil > now;
  for (const z of await pendingSnoozes(now)) {
    if (!paused) rings.push({ ref: z.ref, fireAt: z.fireAt, kind: z.kind === 'due' ? 'due-s' : 'task-s' });
  }
  // Meeting heads-ups: only titles stay on the device (meet_index); the relay sees an opaque id.
  const meetings = s.notifyMeetings
    ? upcomingMeetings(
        s.linkedCalendars.map((c) => ({ calendar: c, events: linkedState.value[c.id]?.events ?? [] })),
        s.meetingLeadMinutes,
        now,
        Math.max(now, s.pauseNotificationsUntil)
      )
    : [];
  const index: Record<string, MeetInfo> = {};
  for (const m of meetings) {
    index[m.ref] = m.info;
    rings.push({ ref: m.ref, fireAt: m.fireAt, kind: 'meet' });
  }
  await db.setMeta('meet_index', JSON.stringify(index));
  rings.sort((a, b) => a.fireAt - b.fireAt);
  armLocal(rings, index);
  const d = pushConfigured() ? await device() : null;
  if (!d) return;
  try {
    const res = await fetch(`${PUSH_WORKER_URL}/reminders`, {
      method: 'PUT',
      headers: authHeader(d),
      body: JSON.stringify({ reminders: rings })
    });
    if (res.status === 401) {
      // The relay forgot this device (unsubscribed or expired): register again, silently.
      await db.setMeta('push_device', '');
      if (Notification.permission === 'granted') await enableNotifications();
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    retryTimer = window.setTimeout(() => void publish(), RETRY_MS); // offline or relay hiccup
  }
}

/** While Nexus is open, fire due rings locally too (covers "no relay" and offline). */
function armLocal(rings: Ring[], meets: Record<string, MeetInfo>): void {
  localTimers.forEach(clearTimeout);
  localTimers = [];
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  const usePush = pushConfigured();
  const now = Date.now();
  for (const r of rings) {
    if (r.kind === 'checkin') continue;
    const kind = r.kind === 'meet' ? 'meet' : r.kind.startsWith('due') ? 'due' : 'task';
    const snoozed = r.kind.endsWith('-s');
    const delay = r.fireAt - now;
    if (delay < 0 || delay > 24 * 3600_000) continue;
    localTimers.push(
      window.setTimeout(async () => {
        // With push, the service worker already shows it; only ring locally without push.
        if (usePush && (await device())) return;
        const reg = await navigator.serviceWorker.ready;
        const t = activeTasks.value.find((x) => x.taskUuid === r.ref);
        await deliverRing(reg, { kind, ref: r.ref, fireAt: r.fireAt, snoozed }, t, meets[r.ref]);
      }, delay)
    );
  }
}

/** The service worker can't read localStorage; give it the few settings it needs. */
async function mirrorSettingsForSw(): Promise<void> {
  const s = getSettings();
  const mirror: NotifySettings = {
    snoozeMinutes: s.snoozeMinutes,
    displayName: s.displayName,
    worker: PUSH_WORKER_URL,
    notifyReminders: s.notifyReminders,
    notifyDeadlines: s.notifyDeadlines,
    notifyMeetings: s.notifyMeetings,
    groupNotifications: s.groupNotifications,
    maxNotificationsPerHour: s.maxNotificationsPerHour,
    pauseNotificationsUntil: s.pauseNotificationsUntil
  };
  await db.setMeta('sw_settings', JSON.stringify(mirror));
}

export function initReminders(): void {
  onTasksWritten(() => void scheduleAll());
  // New calendar data can move, add or cancel meetings.
  onLinkedUpdated(() => getSettings().notifyMeetings && void scheduleAll(1500));
  subscribeSettings(() => void scheduleAll(1500));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void publish(); // re-arm the check-in on leave
  });
  window.addEventListener('online', () => void scheduleAll(500));
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
