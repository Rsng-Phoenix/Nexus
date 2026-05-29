import { parseSyncJson, SYNC_FILE_NAME } from './backup';

const DRIVE = 'https://www.googleapis.com/drive/v3';

export interface DriveBackup {
  fileId: string;
  content: string;
}

/** Always returns raw file text (Drive may send application/json for .json files). */
export async function downloadFileContent(
  token: string,
  fileId: string
): Promise<string> {
  const res = await fetch(`${DRIVE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}

async function driveJson<T>(
  token: string,
  url: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {})
    }
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

async function listBackupFiles(
  token: string
): Promise<{ id: string; modifiedTime?: string }[]> {
  const q = encodeURIComponent(
    `name = '${SYNC_FILE_NAME}' and 'appDataFolder' in parents and trashed = false`
  );
  const list = await driveJson<{ files?: { id: string; modifiedTime?: string }[] }>(
    token,
    `${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`
  );
  return list.files ?? [];
}

/**
 * Load nexus_backup.json from Drive appDataFolder (same file as Android NexusSyncManager).
 */
export async function findBackup(
  token: string,
  knownFileId?: string | null
): Promise<DriveBackup | null> {
  const files = await listBackupFiles(token);
  if (files.length > 0) {
    const file = files[0];
    const content = await downloadFileContent(token, file.id);
    return { fileId: file.id, content };
  }

  if (knownFileId?.trim()) {
    try {
      const content = await downloadFileContent(token, knownFileId);
      parseSyncJson(content);
      return { fileId: knownFileId, content };
    } catch {
      return null;
    }
  }

  return null;
}

export async function uploadBackup(
  token: string,
  json: string,
  existingFileId: string | null
): Promise<string> {
  const blob = new Blob([json], { type: 'application/json' });
  if (existingFileId) {
    await driveJson(
      token,
      `${DRIVE}/files/${existingFileId}?uploadType=media`,
      { method: 'PATCH', body: blob }
    );
    return existingFileId;
  }
  const meta = { name: SYNC_FILE_NAME, parents: ['appDataFolder'] };
  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify(meta)], { type: 'application/json' })
  );
  form.append('file', blob);
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    }
  );
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { id: string };
  return data.id;
}
