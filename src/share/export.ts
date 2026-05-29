import { fromStorage, toPlainText } from '../notes/codec';
import type { Task } from '../types';

export interface SharePayload {
  title: string;
  subject: string;
  fullText: string;
  contentBody: string;
}

export function taskSharePayload(task: Task): SharePayload {
  const blocks = fromStorage(task.notes);
  const body = toPlainText(blocks);
  const full = body ? `${task.description}\n${'─'.repeat(16)}\n${body}` : task.description;
  return {
    title: task.description,
    subject: `NEXUS: ${task.description}`,
    fullText: full,
    contentBody: body
  };
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

export function renderShareImage(title: string, body: string): HTMLCanvasElement {
  const pad = 32;
  const w = 520;
  const lineH = 22;
  const lines = wrapLines(body || ' ', w - pad * 2, '14px sans-serif');
  const h = Math.min(14000, pad * 2 + 36 + 16 + lines.length * lineH + 24);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.fillText(title.slice(0, 80), pad, pad + 24);
  ctx.strokeStyle = '#dddddd';
  ctx.beginPath();
  ctx.moveTo(pad, pad + 36);
  ctx.lineTo(w - pad, pad + 36);
  ctx.stroke();
  ctx.font = '14px system-ui, sans-serif';
  let y = pad + 56;
  lines.forEach((line) => {
    ctx.fillText(line, pad, y);
    y += lineH;
  });
  return canvas;
}

function wrapLines(text: string, maxWidth: number, font: string): string[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  const out: string[] = [];
  text.split('\n').forEach((para) => {
    if (!para) {
      out.push('');
      return;
    }
    let line = '';
    para.split(' ').forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = word;
      } else line = test;
    });
    if (line) out.push(line);
  });
  return out.length ? out : [''];
}

export function downloadCanvas(canvas: HTMLCanvasElement, name: string): void {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = name;
  a.click();
}

export async function shareCanvas(canvas: HTMLCanvasElement, fileName: string): Promise<void> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) return;
  const file = new File([blob], fileName, { type: 'image/png' });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'NEXUS' });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  downloadCanvas(canvas, fileName);
}

/** Minimal PDF writer (text only) for save/share without extra deps */
export function buildPdfBlob(title: string, body: string): Blob {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const lines = wrapLines(body || ' ', 480, '13px sans-serif');
  const content: string[] = ['BT', '/F1 22 Tf', `48 794 Td (${esc(title.slice(0, 120))}) Tj`, 'ET'];
  let y = 760;
  content.push('BT', '/F1 13 Tf');
  lines.forEach((line) => {
    if (y < 48) return;
    content.push(`48 ${y} Td (${esc(line)}) Tj`);
    y -= 18;
  });
  content.push('ET');
  const stream = content.join('\n');
  const parts = [
    '%PDF-1.4',
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj',
    `4 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj`,
    '5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj',
    'xref\n0 6',
    '0000000000 65535 f ',
    'trailer<< /Size 6 /Root 1 0 R >>',
    'startxref\n0\n%%EOF'
  ];
  return new Blob([parts.join('\n')], { type: 'application/pdf' });
}

export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function sharePdf(payload: SharePayload): Promise<void> {
  const blob = buildPdfBlob(payload.title, payload.contentBody);
  const file = new File([blob], 'nexus_share.pdf', { type: 'application/pdf' });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: payload.subject });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  downloadBlob(blob, 'nexus_share.pdf');
}
