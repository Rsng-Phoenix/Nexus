import type { Task } from '../types';

const BACKUP_VERSION = 1;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const SYNC_FILE_NAME = 'nexus_backup.json';

export function isDeleted(t: Task): boolean {
  return t.deletedAt > 0;
}

export function effectiveTimestamp(t: Task): number {
  return Math.max(t.updatedAt, t.deletedAt);
}

export function taskKey(t: Task): string {
  if (t.taskUuid.trim()) return `uuid:${t.taskUuid}`;
  return `${t.description.trim().toLowerCase()}|${t.priority}|${t.notes.trim()}`;
}

export function pruneTombstones(tasks: Task[], now = Date.now()): Task[] {
  const cutoff = now - TOMBSTONE_RETENTION_MS;
  return tasks.filter((t) => !isDeleted(t) || t.deletedAt >= cutoff);
}

function taskToSyncJson(t: Task): Record<string, unknown> {
  return {
    taskUuid: t.taskUuid,
    description: t.description,
    priority: t.priority,
    position: t.position,
    isCompleted: t.isCompleted,
    isWontDo: t.isWontDo,
    isPinned: t.isPinned,
    reminderTime: t.reminderTime,
    reminderDateOnly: t.reminderDateOnly,
    reminderIntervalMinutes: t.reminderIntervalMinutes,
    reminderEndDate: t.reminderEndDate,
    reminderHistoryLabel: t.reminderHistoryLabel,
    notes: t.notes,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    deletedAt: t.deletedAt,
    completedAt: t.completedAt,
    skippedAt: t.skippedAt
  };
}

const PRIOS = new Set(['HIGH', 'MEDIUM', 'LOW', 'NONE']);

function parsePriority(raw: unknown): Task['priority'] {
  const p = String(raw ?? 'NONE').toUpperCase();
  return PRIOS.has(p) ? (p as Task['priority']) : 'NONE';
}

function str(o: Record<string, unknown>, key: string, fallback = ''): string {
  const v = o[key];
  if (v === null || v === undefined) return fallback;
  return String(v);
}

export function syncJsonToTask(o: Record<string, unknown>): Task {
  const uuid =
    typeof o.taskUuid === 'string' && o.taskUuid.trim()
      ? o.taskUuid
      : crypto.randomUUID();
  return {
    id: Number(o.id ?? 0),
    taskUuid: uuid,
    description: str(o, 'description', 'Untitled'),
    priority: parsePriority(o.priority),
    position: Number(o.position ?? 0),
    isCompleted: Boolean(o.isCompleted),
    isWontDo: Boolean(o.isWontDo),
    isPinned: Boolean(o.isPinned),
    reminderTime:
      o.reminderTime === null || o.reminderTime === undefined
        ? null
        : Number(o.reminderTime),
    reminderDateOnly: Boolean(o.reminderDateOnly),
    reminderIntervalMinutes: Number(o.reminderIntervalMinutes ?? 0),
    reminderEndDate: Number(o.reminderEndDate ?? 0),
    reminderHistoryLabel: str(o, 'reminderHistoryLabel'),
    notes: str(o, 'notes'),
    createdAt: Number(o.createdAt ?? Date.now()),
    updatedAt: Number(o.updatedAt ?? Date.now()),
    deletedAt: Number(o.deletedAt ?? 0),
    completedAt: Number(o.completedAt ?? 0),
    skippedAt: Number(o.skippedAt ?? 0)
  };
}

export function exportSyncJson(tasks: Task[], lastSync = Date.now()): string {
  const pruned = pruneTombstones(tasks);
  return JSON.stringify({
    version: BACKUP_VERSION,
    lastSync,
    tasks: pruned.map(taskToSyncJson)
  });
}

function parseBackupRoot(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error('Backup file is empty');
    return JSON.parse(trimmed) as Record<string, unknown>;
  }
  return raw;
}

export function parseSyncJson(
  raw: string | Record<string, unknown>
): { version: number; lastSync: number; tasks: Task[] } {
  const root = parseBackupRoot(raw);
  const version = Number(root.version ?? root.backupVersion ?? BACKUP_VERSION);
  if (version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${version}`);
  }
  const lastSync = Number(root.lastSync ?? 0);
  const tasksRaw = root.tasks;
  const arr = Array.isArray(tasksRaw)
    ? (tasksRaw as Record<string, unknown>[])
    : [];
  return { version, lastSync, tasks: arr.map(syncJsonToTask) };
}

export function exportFullBackup(tasks: Task[]): string {
  const now = Date.now();
  return JSON.stringify(
    {
      backupVersion: BACKUP_VERSION,
      version: BACKUP_VERSION,
      generatedAt: now,
      exportedAt: now,
      tasks: tasks.map((t) => ({ ...taskToSyncJson(t), id: t.id }))
    },
    null,
    2
  );
}

function extractTaskArray(root: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(root.tasks)) return root.tasks as Record<string, unknown>[];
  if (Array.isArray(root.data)) return root.data as Record<string, unknown>[];
  return [];
}

export function parseFullBackup(raw: string): Task[] {
  const root = JSON.parse(raw) as Record<string, unknown>;
  const ver = Number(root.version ?? root.backupVersion ?? BACKUP_VERSION);
  if (ver > BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${ver}`);
  }
  const arr = extractTaskArray(root);
  if (!arr.length) {
    throw new Error('No tasks found in backup file');
  }
  return arr.map((o) => syncJsonToTask(o));
}

export function previewRestore(
  existing: Task[],
  incoming: Task[]
): { duplicateCount: number; uniqueCount: number } {
  const keys = new Set(existing.map(taskKey));
  const dup = incoming.filter((t) => keys.has(taskKey(t))).length;
  return { duplicateCount: dup, uniqueCount: incoming.length - dup };
}
