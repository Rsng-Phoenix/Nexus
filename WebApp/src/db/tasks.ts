import type { Task } from '../types';

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
    const req = t.objectStore(STORE).put(task);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function softDeleteTask(task: Task): Promise<void> {
  const now = Date.now();
  await updateTask({ ...task, deletedAt: now, updatedAt: now });
}

export async function replaceAllTasks(tasks: Task[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    const clear = store.clear();
    clear.onsuccess = () => {
      let pending = tasks.length;
      if (!pending) {
        resolve();
        return;
      }
      for (const task of tasks) {
        const { id: _id, ...row } = task;
        const req = store.add(row);
        req.onsuccess = () => {
          pending--;
          if (!pending) resolve();
        };
        req.onerror = () => reject(req.error);
      }
    };
    clear.onerror = () => reject(clear.error);
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

export async function mergeIntoDb(merged: Task[]): Promise<void> {
  const existing = await getAllTasksIncludingDeleted();
  const byUuid = new Map(existing.map((t) => [t.taskUuid, t]));
  const out: Task[] = [];
  for (const m of merged) {
    const local = byUuid.get(m.taskUuid);
    out.push(local ? { ...m, id: local.id } : { ...m, id: 0 });
  }
  await replaceAllTasks(out);
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
