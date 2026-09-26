import * as db from '../db/tasks';
import { fromStorage, imageIdOf } from '../notes/codec';
import {
  IMAGE_FILE_PREFIX,
  imageFileName,
  isImageId,
  measureImage,
  mimeForFileName,
  parseImageFileName,
  type ImageMime
} from '../notes/images';
import { getAccessToken } from './auth';
import { deleteFile, DriveError } from './drive';

/**
 * Note pictures on Drive (docs §4.5): every image referenced by a task lives in the app folder as
 * `nexus_img_<id>.jpg|png`, next to nexus_backup.json. Android's ImageSync.kt does the same, so a
 * picture pasted on one device shows up on the others after their next sync.
 *
 * Only the raw fetch calls live here: sync/drive.ts is owned by another workstream.
 */

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

interface RemoteImage {
  fileId: string;
  name: string;
}

async function driveFetch(token: string, url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) }
  });
  if (!res.ok) throw new DriveError(res.status, await res.text());
  return res;
}

/** All `nexus_img_*` files in the app folder, by image id (oldest copy wins on duplicates). */
async function listRemoteImages(token: string): Promise<Map<string, RemoteImage>> {
  const out = new Map<string, RemoteImage>();
  let pageToken: string | undefined;
  do {
    const q = encodeURIComponent(
      `name contains '${IMAGE_FILE_PREFIX}' and 'appDataFolder' in parents and trashed = false`
    );
    const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const res = await driveFetch(
      token,
      `${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=nextPageToken,files(id,name)&orderBy=createdTime&pageSize=200${page}`
    );
    const list = (await res.json()) as { files?: { id: string; name: string }[]; nextPageToken?: string };
    for (const f of list.files ?? []) {
      const id = parseImageFileName(f.name);
      if (id && !out.has(id)) out.set(id, { fileId: f.id, name: f.name });
    }
    pageToken = list.nextPageToken;
  } while (pageToken);
  return out;
}

async function findRemoteImage(token: string, id: string): Promise<RemoteImage | null> {
  const q = encodeURIComponent(
    `(name = '${imageFileName(id, 'image/jpeg')}' or name = '${imageFileName(id, 'image/png')}') and 'appDataFolder' in parents and trashed = false`
  );
  const res = await driveFetch(
    token,
    `${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,name)&orderBy=createdTime`
  );
  const files = ((await res.json()) as { files?: { id: string; name: string }[] }).files ?? [];
  return files.length ? { fileId: files[0].id, name: files[0].name } : null;
}

async function downloadBlob(token: string, fileId: string, mime: ImageMime): Promise<Blob> {
  const res = await driveFetch(token, `${DRIVE}/files/${fileId}?alt=media`);
  const buf = await res.arrayBuffer();
  return new Blob([buf], { type: mime });
}

async function uploadImage(token: string, id: string, blob: Blob): Promise<string> {
  const mime: ImageMime = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify({ name: imageFileName(id, mime), parents: ['appDataFolder'] })], {
      type: 'application/json'
    })
  );
  form.append('file', blob.type ? blob : new Blob([blob], { type: mime }));
  const res = await driveFetch(token, `${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    body: form
  });
  return ((await res.json()) as { id: string }).id;
}

/** Image ids referenced by any task, tombstones included (they may be restored). */
export function referencedImageIds(tasks: { notes: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!t.notes || !t.notes.includes('img:')) continue;
    for (const b of fromStorage(t.notes)) {
      const id = imageIdOf(b);
      if (id && isImageId(id)) ids.add(id);
    }
  }
  return ids;
}

/**
 * Runs after the task merge (the lead wires this into sync/manager.ts):
 *  1. upload every referenced image Drive does not have yet (`uploaded` is only a hint — a copy
 *     another device deleted while this one still referenced it is re-uploaded);
 *  2. delete Drive copies no task references any more (deleted tasks keep theirs for the
 *     tombstone window, since the merge keeps those rows);
 *  3. drop the local cache of unreferenced pictures.
 * Never throws for a single picture: one bad file must not fail the whole sync.
 */
export async function syncImages(token: string): Promise<void> {
  const tasks = await db.getAllTasksIncludingDeleted();
  const referenced = referencedImageIds(tasks);
  const local = await db.getAllImages();
  const remote = await listRemoteImages(token);

  for (const rec of local) {
    if (!referenced.has(rec.id)) {
      await db.deleteImage(rec.id).catch(() => {});
      continue;
    }
    if (remote.has(rec.id)) {
      if (!rec.uploaded) await db.markImageUploaded(rec.id).catch(() => {});
      continue;
    }
    try {
      const fileId = await uploadImage(token, rec.id, rec.blob);
      remote.set(rec.id, { fileId, name: imageFileName(rec.id, rec.blob.type === 'image/png' ? 'image/png' : 'image/jpeg') });
      await db.markImageUploaded(rec.id);
    } catch (e) {
      if (e instanceof DriveError && (e.status === 401 || e.status === 403)) throw e;
      // Retried on the next sync.
    }
  }

  for (const [id, r] of remote) {
    if (referenced.has(id)) continue;
    await deleteFile(token, r.fileId).catch(() => {});
  }
}

const inflight = new Map<string, Promise<db.ImageRecord | null>>();

/**
 * The local record for [id], downloading it from Drive when this device has never seen it
 * (a picture added on another device). Null when offline / signed out / not on Drive either.
 */
export function ensureImage(id: string): Promise<db.ImageRecord | null> {
  const running = inflight.get(id);
  if (running) return running;
  const p = (async () => {
    const have = await db.getImage(id).catch(() => undefined);
    if (have) return have;
    if (!isImageId(id)) return null;
    let token: string | null = null;
    try {
      token = await getAccessToken({ interactive: false });
    } catch {
      return null;
    }
    if (!token) return null;
    try {
      const remote = await findRemoteImage(token, id);
      if (!remote) return null;
      const mime = mimeForFileName(remote.name);
      const blob = await downloadBlob(token, remote.fileId, mime);
      const { w, h } = await measureImage(blob);
      const rec: db.ImageRecord = { id, blob, w, h, addedAt: Date.now(), uploaded: true };
      await db.putImage(rec);
      return rec;
    } catch {
      return null;
    }
  })();
  inflight.set(id, p);
  p.finally(() => inflight.delete(id)).catch(() => {});
  return p;
}
