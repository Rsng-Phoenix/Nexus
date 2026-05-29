import type { Task } from '../types';
import { effectiveTimestamp, isDeleted, pruneTombstones } from './backup';

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

export function mergeTasks(local: Task[], remote: Task[]): MergeResult {
  const localByUuid = new Map(local.map((t) => [t.taskUuid, t]));
  const remoteByUuid = new Map(remote.map((t) => [t.taskUuid, t]));
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
