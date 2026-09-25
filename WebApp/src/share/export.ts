import { fromStorage, toPlainText } from '../notes/codec';
import type { Task } from '../types';
import { shareDocText, taskShareDoc, type ShareDoc } from './doc';

export interface SharePayload {
  title: string;
  subject: string;
  fullText: string;
  contentBody: string;
  /** The structured version every format is drawn from (text, image, PDF). */
  doc: ShareDoc;
}

export function sharePayloadFromDoc(doc: ShareDoc, contentBody = ''): SharePayload {
  return { title: doc.title, subject: `Nexus: ${doc.title}`, fullText: shareDocText(doc), contentBody, doc };
}

export function taskSharePayload(task: Task): SharePayload {
  return sharePayloadFromDoc(taskShareDoc(task), toPlainText(fromStorage(task.notes)));
}

export async function shareText(payload: SharePayload): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share({ title: payload.subject, text: payload.fullText });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(payload.fullText);
  } catch {
    downloadBlob(
      new Blob([payload.fullText], { type: 'text/plain;charset=utf-8' }),
      'nexus_share.txt'
    );
  }
}

export async function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not draw the image');
  return blob;
}

export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Share a file through the system sheet where possible, else save it. */
export async function shareFile(blob: Blob, fileName: string, title: string): Promise<void> {
  const file = new File([blob], fileName, { type: blob.type });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  downloadBlob(blob, fileName);
}
