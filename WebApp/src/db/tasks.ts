import type { Task } from '../types';
import { SYNC_TOMBSTONE_RETENTION_MS } from '../sync/backup';

const DB_NAME = 'nexus_web';
const STORE = 'tasks';
const META = 'meta';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        os.createIndex('taskUuid', 'taskUuid', { unique: true });
        os.createIndex('deletedAt', 'deletedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
      }
    };
  });
}

export async function getAllTasksIncludingDeleted(): Promise<Task[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as Task[]);
    req.onerror = () => reject(req.error);
  });
}

export async function getActiveTasks(): Promise<Task[]> {
  const all = await getAllTasksIncludingDeleted();
  return all.filter((t) => t.deletedAt === 0);
}

export async function insertTask(task: Omit<Task, 'id'>): Promise<Task> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const req = t.objectStore(STORE).add(task);
    req.onsuccess = () =>
      resolve({ ...task, id: req.result as number } as Task);
    req.onerror = () => reject(req.error);
  });
}

export async function updateTask(task: Task): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    if (task.taskUuid) {
      const idx = store.index('taskUuid');
      const req = idx.get(task.taskUuid);
      req.onsuccess = () => {
        const existing = req.result as Task | undefined;
        const targetId = existing && existing.id > 0 ? existing.id : task.id;
        const putReq = store.put({ ...task, id: targetId });
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      req.onerror = () => {
        const putReq = store.put(task);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
    } else {
      const req = store.put(task);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }
  });
}

export async function softDeleteTask(task: Task): Promise<void> {
  const now = Date.now();
  await updateTask({ ...task, deletedAt: now, updatedAt: now });
}

/**
 * "Replace everything" restore. Existing tasks are tombstoned rather than wiped, otherwise the
 * next sync would pull them straight back from Drive.
 */
export async function replaceAllTasks(tasks: Task[]): Promise<void> {
  const existing = await getAllTasksIncludingDeleted();
  const now = Date.now();
  const incomingUuids = new Set(tasks.map((t) => t.taskUuid));
  const byUuid = new Map(existing.map((t) => [t.taskUuid, t]));
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    for (const old of existing) {
      if (!incomingUuids.has(old.taskUuid) && old.deletedAt === 0) {
        store.put({ ...old, deletedAt: now, updatedAt: now });
      }
    }
    for (const task of tasks) {
      const local = byUuid.get(task.taskUuid);
      const row = { ...task, deletedAt: 0, updatedAt: now };
      if (local) store.put({ ...row, id: local.id });
      else {
        const { id: _id, ...fresh } = row;
        store.add(fresh);
      }
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function mergeRestoreTasks(incoming: Task[]): Promise<number> {
  const existing = await getAllTasksIncludingDeleted();
  const keys = new Set(existing.map((t) => taskKey(t)));
  let added = 0;
  for (const t of incoming) {
    const k = taskKey(t);
    if (!keys.has(k)) {
      const { id: _id, ...row } = t;
      await insertTask(row);
      keys.add(k);
      added++;
    }
  }
  return added;
}

function taskKey(t: Task): string {
  if (t.taskUuid.trim()) return `uuid:${t.taskUuid}`;
  return `${t.description.trim().toLowerCase()}|${t.priority}|${t.notes.trim()}`;
}

const stamp = (t: Task) => Math.max(t.updatedAt, t.deletedAt);

/**
 * Writes a merge result. [snapshot] is what the merge was computed from: any row the user
 * edited while the sync was on the network is newer than its snapshot and is left alone
 * (the next sync uploads it) instead of being overwritten by the older merged copy.
 */
export async function mergeIntoDb(merged: Task[], snapshot: Task[]): Promise<{ skipped: number }> {
  const before = new Map(snapshot.map((t) => [t.taskUuid, stamp(t)]));
  const mergedUuids = new Set(merged.map((t) => t.taskUuid));
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    let skipped = 0;
    const req = store.getAll();
    req.onsuccess = () => {
      const current = req.result as Task[];
      const byUuid = new Map(current.map((row) => [row.taskUuid, row]));
      // Tombstones past the sync retention window were pruned from the merge result.
      for (const row of current) {
        if (!mergedUuids.has(row.taskUuid) && row.deletedAt > 0) store.delete(row.id);
      }
      for (const m of merged) {
        const local = byUuid.get(m.taskUuid);
        if (!local) {
          const { id: _id, ...fresh } = m;
          store.add(fresh);
          continue;
        }
        const seen = before.get(m.taskUuid);
        if (seen !== undefined && stamp(local) > seen && stamp(local) > stamp(m)) {
          skipped++;
          continue;
        }
        if (stamp(local) === stamp(m) && local.deletedAt === m.deletedAt) continue; // no-op write
        store.put({ ...m, id: local.id });
      }
    };
    t.oncomplete = () => resolve({ skipped });
    t.onerror = () => reject(t.error);
  });
}

export async function purgeExpired(retentionDays: number): Promise<void> {
  const all = await getAllTasksIncludingDeleted();
  const now = Date.now();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const tombstoneCutoff = now - SYNC_TOMBSTONE_RETENTION_MS;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    for (const task of all) {
      if (task.deletedAt > 0 && task.deletedAt < tombstoneCutoff) {
        store.delete(task.id);
      } else if (
        task.deletedAt === 0 &&
        !(task.archivedAt > 0) &&
        ((task.isCompleted && task.completedAt > 0 && task.completedAt < cutoff) ||
         (task.isWontDo && task.skippedAt > 0 && task.skippedAt < cutoff))
      ) {
        store.put({ ...task, deletedAt: now, updatedAt: now });
      }
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getMeta(key: string): Promise<string> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(META, 'readonly');
    const req = t.objectStore(META).get(key);
    req.onsuccess = () => resolve((req.result as string) ?? '');
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(META, 'readwrite');
    const req = t.objectStore(META).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Tour demo rows are device-local and never synced, so they can be hard-deleted. */
export async function deleteTutorialDemos(): Promise<void> {
  const all = await getAllTasksIncludingDeleted();
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    for (const row of all) if (row.taskUuid.startsWith('nexus-tutorial-')) store.delete(row.id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
