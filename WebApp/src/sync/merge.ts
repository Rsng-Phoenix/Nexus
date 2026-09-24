import type { Task } from '../types';
import { effectiveTimestamp, isDeleted, pruneTombstones, TUTORIAL_UUID_PREFIX } from './backup';

export interface MergeResult {
  tasks: Task[];
  downloaded: number;
  uploaded: number;
  deleted: number;
  conflictsResolved: number;
}

function pickWinner(local: Task, remote: Task): Task {
  const localTs = effectiveTimestamp(local);
  const remoteTs = effectiveTimestamp(remote);
  return remoteTs >= localTs ? remote : local;
}

/** Same uuid appearing twice (e.g. from duplicate Drive files): keep the newest. */
function newestByUuid(tasks: Task[]): Map<string, Task> {
  const m = new Map<string, Task>();
  for (const t of tasks) {
    const prev = m.get(t.taskUuid);
    m.set(t.taskUuid, prev ? pickWinner(prev, t) : t);
  }
  return m;
}

export function mergeTasks(local: Task[], remote: Task[]): MergeResult {
  const localByUuid = newestByUuid(local);
  const remoteByUuid = newestByUuid(
    remote.filter((t) => !t.taskUuid.startsWith(TUTORIAL_UUID_PREFIX))
  );
  const allUuids = new Set([...localByUuid.keys(), ...remoteByUuid.keys()]);

  let downloaded = 0;
  let uploaded = 0;
  let deleted = 0;
  let conflicts = 0;

  const merged: Task[] = [];
  for (const uuid of allUuids) {
    const l = localByUuid.get(uuid);
    const r = remoteByUuid.get(uuid);
    if (!l && r) {
      downloaded++;
      merged.push(r);
    } else if (l && !r) {
      uploaded++;
      merged.push(l);
    } else if (l && r) {
      const winner = pickWinner(l, r);
      if (
        winner.updatedAt !== l.updatedAt ||
        winner.deletedAt !== l.deletedAt
      ) {
        conflicts++;
      }
      if (isDeleted(winner) && !isDeleted(l)) deleted++;
      merged.push(winner);
    }
  }

  return {
    tasks: pruneTombstones(merged),
    downloaded,
    uploaded,
    deleted,
    conflictsResolved: conflicts
  };
}

export function countActiveRemovals(localActive: Task[], merged: Task[]): number {
  const mergedByUuid = new Map(merged.map((t) => [t.taskUuid, t]));
  return localActive.filter((local) => {
    const m = mergedByUuid.get(local.taskUuid);
    return !m || isDeleted(m);
  }).length;
}
