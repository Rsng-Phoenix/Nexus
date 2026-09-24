import { parseSyncJson, SYNC_FILE_NAME } from './backup';
import type { Task } from '../types';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveBackup {
  fileId: string;
  /** Tasks from every nexus_backup.json found (duplicates are merged by the caller). */
  tasks: Task[];
  /** Extra copies that should be deleted once the merged result is written to [fileId]. */
  duplicateIds: string[];
}

export class DriveError extends Error {
  constructor(readonly status: number, body: string) {
    super(body || `Drive error ${status}`);
  }
}

async function driveFetch(token: string, url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) }
  });
  if (!res.ok) throw new DriveError(res.status, await res.text());
  return res;
}

export async function downloadFileContent(token: string, fileId: string): Promise<string> {
  return (await driveFetch(token, `${DRIVE}/files/${fileId}?alt=media`)).text();
}

/** Oldest first. Android uses the same rule, so both always settle on the same file. */
async function listBackupFiles(token: string): Promise<{ id: string; createdTime?: string }[]> {
  const q = encodeURIComponent(
    `name = '${SYNC_FILE_NAME}' and 'appDataFolder' in parents and trashed = false`
  );
  const res = await driveFetch(
    token,
    `${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,createdTime)&orderBy=createdTime`
  );
  const list = (await res.json()) as { files?: { id: string; createdTime?: string }[] };
  return list.files ?? [];
}

/**
 * Loads nexus_backup.json from the Drive app folder (shared with Android NexusSyncManager).
 * If two devices ever raced and created two files, all of them are read so nothing is lost;
 * the oldest one is kept as the canonical file.
 */
export async function findBackup(token: string): Promise<DriveBackup | null> {
  const files = await listBackupFiles(token);
  if (files.length === 0) return null;
  const tasks: Task[] = [];
  for (const f of files) {
    try {
      tasks.push(...parseSyncJson(await downloadFileContent(token, f.id)).tasks);
    } catch (e) {
      // An unreadable canonical file must stop the sync; unreadable extras are just skipped.
      if (f.id === files[0].id) throw e;
    }
  }
  return { fileId: files[0].id, tasks, duplicateIds: files.slice(1).map((f) => f.id) };
}

export async function deleteFile(token: string, fileId: string): Promise<void> {
  try {
    await driveFetch(token, `${DRIVE}/files/${fileId}`, { method: 'DELETE' });
  } catch (e) {
    if (!(e instanceof DriveError && e.status === 404)) throw e;
  }
}

export async function uploadBackup(
  token: string,
  json: string,
  existingFileId: string | null
): Promise<string> {
  const body = new Blob([json], { type: 'application/json' });
  if (existingFileId) {
    // Content updates must go to the /upload endpoint; /drive/v3/files only changes metadata.
    await driveFetch(token, `${UPLOAD}/files/${existingFileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    return existingFileId;
  }
  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify({ name: SYNC_FILE_NAME, parents: ['appDataFolder'] })], {
      type: 'application/json'
    })
  );
  form.append('file', body);
  const res = await driveFetch(token, `${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    body: form
  });
  const created = (await res.json()) as { id: string };
  // Another device may have created one at the same moment: the oldest wins everywhere.
  const files = await listBackupFiles(token);
  return files[0]?.id ?? created.id;
}
