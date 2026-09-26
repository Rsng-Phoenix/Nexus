import { PUSH_WORKER_URL } from '../config';
import * as db from '../db/tasks';
import { getSettings, refreshLabel, subscribeSettings } from '../settings/store';
import { deskPost, inNexusDesk } from '../state/desk';
import { activeTasks, allTasks, onTasksWritten, updateTask } from '../state/store';
import { markCompleted } from '../task-utils';
import type { Task } from '../types';
import { upcomingDueFires } from '../calendar/deadline';
import { calendarSourceLabel, linkedState, onLinkedUpdated } from '../calendar/linked';
import { upcomingMeetings } from '../calendar/meetings';
import { upcomingClashes } from '../calendar/clashes';
import { addSnooze, deliverRing, pendingSnoozes, type MeetInfo, type NotifySettings } from './notify';
import { upcomingFires } from './schedule';
import { showSnack } from '../state/toasts';

export { inNexusDesk };

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

/** What the Desk needs to show a notification and to act on its buttons (ref/kind/url → userInfo). */
type DeskNote = { id: string; title: string; body: string; silent: boolean; ref?: string; kind?: string; url?: string };
type DeskBridge = { postMessage(m: { show?: DeskNote; clear?: string[] }): void };
/** Nexus Desk for Mac shows reminders as real macOS notifications (see nexus-desk-mac.jxa); the widget view has this handler. */
function deskNotify(): DeskBridge | null {
  const w = window as Window & { webkit?: { messageHandlers?: Record<string, DeskBridge> } };
  return w.webkit?.messageHandlers?.nexusNotify ?? null;
}

/**
 * Stands in for the service worker registration inside Nexus Desk (WebKit there has no web
 * notifications), so every rule in deliverRing (pause, hourly cap, grouping) applies unchanged.
 * While you're using the Desk window, macOS keeps banners quiet: a snackbar says it instead.
 */
function deskRegistration(bridge: DeskBridge): ServiceWorkerRegistration {
  return {
    showNotification: async (title: string, o: NotificationOptions = {}) => {
      const body = o.body ?? '';
      if (document.hasFocus() && document.visibilityState === 'visible') showSnack(body ? `${title} · ${body.split('\n')[0]}` : title);
      const data = (o.data ?? {}) as { ref?: string; kind?: string; url?: string };
      const note: DeskNote = { id: o.tag ?? `nexus:${Date.now()}`, title, body, silent: !!o.silent };
      if (typeof data.ref === 'string') note.ref = data.ref;
      if (typeof data.kind === 'string') note.kind = data.kind;
      if (typeof data.url === 'string') note.url = data.url;
      bridge.postMessage({ show: note });
    },
    getNotifications: async () => []
  } as unknown as ServiceWorkerRegistration;
}

type NoteAction = { action: string; ref?: string; kind?: string; url?: string };

/**
 * A button on a Desk notification (mirror of sw.ts `notificationclick`): Done completes the
 * task, Snooze re-rings after the Snooze setting, Join opens the meeting link, Open/tap is
 * handled by the Desk itself (it shows the full window on the task).
 */
async function noteAction(a: NoteAction): Promise<void> {
  const ref = a.ref ?? '';
  if (a.action === 'done' && ref) {
    const t = allTasks.value.find((x) => x.taskUuid === ref && x.deletedAt === 0);
    if (t && !t.isCompleted) await updateTask(markCompleted(t));
    await cancelRemoteRings(ref);
    return;
  }
  if (a.action === 'snooze' && ref) {
    const s = getSettings();
    const fireAt = Date.now() + s.snoozeMinutes * 60_000;
    const kind = a.kind === 'due' ? 'due' : 'task';
    // Kept on the device too, so the next schedule publish (and the local timers) include it.
    await addSnooze({ ref, kind, fireAt });
    const auth = await workerAuth();
    if (auth) {
      await fetch(`${PUSH_WORKER_URL}/snooze`, { method: 'POST', headers: auth, body: JSON.stringify({ ref, fireAt, kind: `${kind}-s` }) }).catch(() => undefined);
    }
    void scheduleAll(200);
    return;
  }
  if (a.action === 'join' && a.url && /^https:\/\//.test(a.url)) {
    if (!deskPost({ openUrl: a.url })) window.open(a.url, '_blank', 'noopener');
  }
}

/** The relay must not ring a task that was just completed from a notification. */
async function cancelRemoteRings(ref: string): Promise<void> {
  const auth = await workerAuth();
  if (!auth) return;
  await fetch(`${PUSH_WORKER_URL}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ ref }) }).catch(() => undefined);
}

/** The Desk's notification categories carry the Snooze button's label ("Snooze 10 min"). */
function publishCategories(): void {
  deskPost({ categories: { snooze: refreshLabel(getSettings().snoozeMinutes) } });
}
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
  const linkedNow = s.linkedCalendars.map((c) => ({ calendar: c, events: linkedState.value[c.id]?.events ?? [] }));
  const meetings = s.notifyMeetings ? upcomingMeetings(linkedNow, s.meetingLeadMinutes, now, Math.max(now, s.pauseNotificationsUntil)) : [];
  // Clash radar: a heads-up for a meeting that overlaps another says so.
  const clashNote = new Map<string, string>();
  if (s.clashRadar && meetings.length) {
    const hhmm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    for (const c of upcomingClashes(linkedNow, s.clashMinMinutes, s.ignoredClashes, now, 3)) {
      for (const [me, other] of [[c.a, c.b], [c.b, c.a]] as const) {
        const k = `${me.event.uid}|${me.start}`;
        if (!clashNote.has(k)) clashNote.set(k, `Clashes with ${other.title} (${calendarSourceLabel(other.calendar)}) at ${hhmm(other.start)}`);
      }
    }
  }
  const index: Record<string, MeetInfo> = {};
  for (const m of meetings) {
    const clash = clashNote.get(m.key);
    index[m.ref] = clash ? { ...m.info, clash } : m.info;
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
  const desk = deskNotify();
  if (!desk && (!notificationsSupported() || Notification.permission !== 'granted')) return;
  const usePush = !desk && pushConfigured();
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
        const reg = desk ? deskRegistration(desk) : await navigator.serviceWorker.ready;
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
  // Nexus Desk stays open for days: local timers only reach 24 hours ahead, so re-arm hourly.
  if (deskNotify()) window.setInterval(() => void scheduleAll(), 60 * 60_000);
  if (inNexusDesk()) {
    // Buttons on the Desk's notifications come back here (this window owns the reminders).
    (window as Window & { __nexusNoteAction?: (a: NoteAction) => void }).__nexusNoteAction = (a) => void noteAction(a).catch(() => undefined);
    publishCategories();
    let snooze = getSettings().snoozeMinutes;
    subscribeSettings(() => {
      if (getSettings().snoozeMinutes === snooze) return;
      snooze = getSettings().snoozeMinutes;
      publishCategories();
    });
  }
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
