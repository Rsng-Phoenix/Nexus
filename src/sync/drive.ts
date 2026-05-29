import { SYNC_FILE_NAME } from './backup';

const DRIVE = 'https://www.googleapis.com/drive/v3';

export interface DriveBackup {
  fileId: string;
  content: string;
}

export async function findBackup(token: string): Promise<DriveBackup | null> {
  const q = encodeURIComponent(
    `name = '${SYNC_FILE_NAME}' and 'appDataFolder' in parents and trashed = false`
  );
  const list = await driveFetch(
    token,
    `${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,name)`
  );
  const files = (list as { files?: { id: string }[] }).files;
  const file = files?.[0];
  if (!file) return null;
  const content = await driveFetch(
    token,
    `${DRIVE}/files/${file.id}?alt=media`
  );
  return { fileId: file.id, content: content as unknown as string };
}

export async function uploadBackup(
  token: string,
  json: string,
  existingFileId: string | null
): Promise<string> {
  const blob = new Blob([json], { type: 'application/json' });
  if (existingFileId) {
    await driveFetch(
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

async function driveFetch(
  token: string,
  url: string,
  init?: RequestInit
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {})
    }
  });
  if (!res.ok) throw new Error(await res.text());
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}
