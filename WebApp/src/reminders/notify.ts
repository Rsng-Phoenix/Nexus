import { alertAt, daysBetween, dateToIso, dueAlertText, hasDeadline } from '../calendar/deadline';
import { parseDueAlerts } from '../calendar/due';
import * as db from '../db/tasks';
import { fromStorage, toPlainText } from '../notes/codec';
import type { Task } from '../types';
import { PRIORITY_META } from '../types';

/**
 * The one place a Nexus notification is shown, from the service worker (push) or the open app
 * (local timers). It enforces the user's controls and the "never spam" rules:
 * - master switches and pause (a paused ring is dropped, never replayed later);
 * - each ring (kind + task + time) is shown at most once, even if push and a timer both fire;
 * - a rolling-hour cap: extra rings fold into ONE "N more" notification that updates in place;
 * - rings landing within the same minute are grouped into one summary notification.
 */

export type RingKind = 'task' | 'due' | 'meet';
/** What a meeting heads-up shows (kept on the device in meta `meet_index`, keyed by ring ref). */
export type MeetInfo = { title: string; at: number; url?: string; source: string };

/** "In 10 min · 11:00 PM" / "Starting now · 11:00 PM". */
export function meetingLabel(info: MeetInfo, now: number): string {
  const time = new Date(info.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const m = Math.round((info.at - now) / 60_000);
  return m >= 1 ? `In ${m} min · ${time}` : `Starting now · ${time}`;
}

export async function meetingInfo(ref: string): Promise<MeetInfo | undefined> {
  try {
    return (JSON.parse((await db.getMeta('meet_index')) || '{}') as Record<string, MeetInfo>)[ref];
  } catch {
    return undefined;
  }
}
/** [snoozed]: a ring the user postponed — its time no longer matches the task's schedule. */
export type Ring = { kind: RingKind; ref: string; fireAt: number; snoozed?: boolean };

/** Settings the service worker can't read from localStorage (mirrored by the app). */
export type NotifySettings = {
  snoozeMinutes: number;
  displayName: string;
  worker: string;
  notifyReminders: boolean;
  notifyDeadlines: boolean;
  notifyMeetings: boolean;
  groupNotifications: boolean;
  maxNotificationsPerHour: number;
  pauseNotificationsUntil: number;
};

export const NOTIFY_DEFAULTS: NotifySettings = {
  snoozeMinutes: 10,
  displayName: '',
  worker: '',
  notifyReminders: true,
  notifyDeadlines: true,
  notifyMeetings: false,
  groupNotifications: true,
  maxNotificationsPerHour: 12,
  pauseNotificationsUntil: 0
};

const GROUP_WINDOW_MS = 60_000;
const HOUR = 3_600_000;
const RUNG_KEEP_MS = 3 * 86_400_000;
const GROUP_TAG = 'nexus-group';
const OVERFLOW_TAG = 'nexus-overflow';

export async function notifySettings(): Promise<NotifySettings> {
  try {
    return { ...NOTIFY_DEFAULTS, ...JSON.parse((await db.getMeta('sw_settings')) || '{}') };
  } catch {
    return { ...NOTIFY_DEFAULTS };
  }
}

type Log = { rung: Record<string, number>; shown: number[] };

async function readLog(): Promise<Log> {
  try {
    const l = JSON.parse((await db.getMeta('ring_log')) || '{}') as Partial<Log>;
    return { rung: l.rung ?? {}, shown: l.shown ?? [] };
  } catch {
    return { rung: {}, shown: [] };
  }
}

// Push events, timers and other tabs can overlap: serialise the read-modify-write of the log.
// Web Locks work across tabs and the service worker; the chain is the fallback.
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined);
  if (locks) return locks.request('nexus-ring-log', fn) as Promise<T>;
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

export const ringKey = (r: Ring) => `${r.kind}:${r.ref}:${r.fireAt}`;

/** Has this exact ring been shown already (so schedules can skip it)? */
export async function alreadyRung(r: Ring): Promise<boolean> {
  return !!(await readLog()).rung[ringKey(r)];
}

const isOpen = (t: Task) => t.deletedAt === 0 && !t.isCompleted && !t.isWontDo && !(t.archivedAt > 0);

/** Does this ring still belong to the task (the schedule on the relay can be stale)? */
function stillValid(r: Ring, t: Task): boolean {
  if (r.snoozed) return true;
  if (r.kind === 'task') return t.reminderTime != null;
  if (!hasDeadline(t)) return false;
  return parseDueAlerts(t.dueAlerts).some((o) => Math.abs(alertAt(t.dueDate, o, t.dueAlertTime) - r.fireAt) < 60_000);
}

function contentFor(r: Ring, t: Task): { label: string } {
  if (r.kind === 'due' && hasDeadline(t)) {
    const offset = daysBetween(t.dueDate, dateToIso(new Date(r.fireAt)));
    return { label: dueAlertText(t.dueDate, offset) };
  }
  const recurring = t.reminderDateOnly || t.reminderEndDate > 0;
  return { label: recurring ? `${PRIORITY_META[t.priority].label} · repeats today` : `${PRIORITY_META[t.priority].label} priority reminder` };
}

type Shown = { ref: string; kind: RingKind; at: number; title: string; label: string };

/**
 * Show [ring] for [t] if the user's settings allow it. Returns true if something was shown
 * (a push handler must always show *something*, so callers may fall back when false).
 */
export async function deliverRing(reg: ServiceWorkerRegistration, ring: Ring, t: Task | undefined, meet?: MeetInfo): Promise<boolean> {
  return locked(async () => {
    const s = await notifySettings();
    const now = Date.now();
    if (ring.kind === 'meet') {
      // Dropped if the meeting moved or disappeared since it was scheduled, or is long over.
      if (!meet || !s.notifyMeetings || now - meet.at > 15 * 60_000) return false;
    } else if (!t || !isOpen(t) || !stillValid(ring, t)) return false;
    if (s.pauseNotificationsUntil > now) return false;
    if (ring.kind === 'task' && !s.notifyReminders) return false;
    if (ring.kind === 'due' && !s.notifyDeadlines) return false;

    const log = await readLog();
    const key = ringKey(ring);
    if (log.rung[key]) return false;
    log.rung[key] = now;
    for (const [k, v] of Object.entries(log.rung)) if (now - v > RUNG_KEEP_MS) delete log.rung[k];
    log.shown = log.shown.filter((x) => now - x < HOUR);

    const label = ring.kind === 'meet' ? meetingLabel(meet!, now) : contentFor(ring, t!).label;
    const title = ring.kind === 'meet' ? meet!.title : t!.description;
    const snooze = s.snoozeMinutes < 60 ? `${s.snoozeMinutes}m` : `${s.snoozeMinutes / 60}h`;
    const icon = './icons/icon-192.png';
    const badge = './icons/badge-72.png';

    // Over the hourly cap: one quiet summary, updated in place.
    if (log.shown.length >= Math.max(1, s.maxNotificationsPerHour)) {
      const prev = (await reg.getNotifications({ tag: OVERFLOW_TAG }))[0];
      const n = ((prev?.data as { n?: number } | undefined)?.n ?? 0) + 1;
      await reg.showNotification(`${n} more reminder${n === 1 ? '' : 's'}`, {
        body: 'Open Nexus to see them. (Your hourly limit is in Settings → Notifications.)',
        tag: OVERFLOW_TAG,
        icon,
        badge,
        silent: true,
        data: { n, kind: 'overflow' }
      });
      await db.setMeta('ring_log', JSON.stringify(log));
      return true;
    }
    log.shown.push(now);
    await db.setMeta('ring_log', JSON.stringify(log));

    const me: Shown = { ref: ring.kind === 'meet' ? ring.ref : t!.taskUuid, kind: ring.kind, at: now, title, label };

    // Same-minute rings: one summary instead of a stack.
    if (s.groupNotifications) {
      const recent = (await reg.getNotifications()).filter((n) => {
        const d = n.data as Partial<Shown> & { items?: Shown[] } | undefined;
        return d && now - (d.at ?? 0) < GROUP_WINDOW_MS && (n.tag === GROUP_TAG || d.kind === 'task' || d.kind === 'due' || d.kind === 'meet');
      });
      if (recent.length) {
        const items: Shown[] = [];
        for (const n of recent) {
          const d = n.data as Shown & { items?: Shown[] };
          if (n.tag === GROUP_TAG) items.push(...(d.items ?? []));
          else items.push({ ref: d.ref, kind: d.kind, at: d.at, title: d.title, label: d.label });
          n.close();
        }
        items.push(me);
        const allDueToday = items.every((i) => i.label === 'Due today');
        const title = allDueToday ? `${items.length} tasks due today` : `${items.length} reminders`;
        await reg.showNotification(title, {
          body: items.map((i) => `• ${i.title}${allDueToday ? '' : ` — ${i.label}`}`).join('\n'),
          tag: GROUP_TAG,
          icon,
          badge,
          data: { kind: 'group', at: now, items }
        });
        return true;
      }
    }

    if (ring.kind === 'meet') {
      await reg.showNotification(title, {
        body: `${label}\n${meet!.source}`,
        tag: `meet:${ring.ref}`,
        icon,
        badge,
        data: { ...me, kind: 'meet', url: meet!.url },
        actions: meet!.url ? [{ action: 'join', title: 'Join' }] : []
      } as NotificationOptions);
      return true;
    }
    const task = t!;
    const notes = toPlainText(fromStorage(task.notes)).trim().slice(0, 240);
    await reg.showNotification(task.description, {
      body: notes ? `${label}\n${notes}` : label,
      tag: `${ring.kind}:${task.taskUuid}`,
      icon,
      badge,
      requireInteraction: task.isPinned,
      data: { ...me, kind: ring.kind },
      actions: [
        { action: 'done', title: 'Done' },
        { action: 'snooze', title: `Snooze ${snooze}` }
      ]
    } as NotificationOptions);
    return true;
  });
}

/**
 * A push must always end with a notification, or browsers show their own "updated in the
 * background" notice and iPhone may cancel the subscription. When a ring is skipped on purpose
 * (done, paused, duplicate), show a silent one and close it at once.
 */
export async function quietAck(reg: ServiceWorkerRegistration): Promise<void> {
  await reg.showNotification('Nexus', { tag: 'nexus-quiet', silent: true, body: 'Up to date' } as NotificationOptions);
  for (const n of await reg.getNotifications({ tag: 'nexus-quiet' })) n.close();
}

const SNOOZE_KEY = 'snoozes';
export type Snooze = { ref: string; kind: RingKind; fireAt: number };

/** Snoozes live on the device too, so a later schedule publish never drops them. */
export async function addSnooze(s: Snooze): Promise<void> {
  const list = await pendingSnoozes();
  list.push(s);
  await db.setMeta(SNOOZE_KEY, JSON.stringify(list));
}

export async function pendingSnoozes(now = Date.now()): Promise<Snooze[]> {
  try {
    return (JSON.parse((await db.getMeta(SNOOZE_KEY)) || '[]') as Snooze[]).filter((x) => x.fireAt > now - 60_000);
  } catch {
    return [];
  }
}
