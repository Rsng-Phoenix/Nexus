/**
 * Image encoding for notes (see docs/premium-desk-architecture.md §4.5). The numbers are format
 * limits, not user settings: the same constants live in Android's ImageSync.kt.
 */

/** Longest edge after downscaling. */
export const MAX_EDGE_PX = 1600;
/** JPEG quality for photos. */
export const JPEG_QUALITY = 0.82;
/** A PNG with transparency is kept as PNG only while it stays under this size. */
export const PNG_KEEP_MAX_BYTES = 300 * 1024;
/** Anything bigger than this after resizing is refused. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const IMAGE_FILE_PREFIX = 'nexus_img_';
export const IMAGE_ID_LENGTH = 16;

export type ImageMime = 'image/jpeg' | 'image/png';

export interface EncodedImage {
  id: string;
  blob: Blob;
  w: number;
  h: number;
}

export class ImageTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super('Image is too large');
  }
}

/** Scales (w, h) down so the longest edge is ≤ [max]; never upscales. */
export function fitWithin(w: number, h: number, max = MAX_EDGE_PX): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: Math.max(1, w), h: Math.max(1, h) };
  const longest = Math.max(w, h);
  if (longest <= max) return { w, h };
  const k = max / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

export function isImageId(id: string): boolean {
  return /^[0-9a-f]{16}$/.test(id);
}

/** `nexus_img_<id>.jpg` / `.png` — the Drive file name for an image. */
export function imageFileName(id: string, mime: ImageMime): string {
  return `${IMAGE_FILE_PREFIX}${id}${mime === 'image/png' ? '.png' : '.jpg'}`;
}

/** The image id in a Drive file name, or null for any other file. */
export function parseImageFileName(name: string): string | null {
  const m = /^nexus_img_([0-9a-f]{16})\.(?:jpe?g|png)$/i.exec(name);
  return m ? m[1].toLowerCase() : null;
}

export function mimeForFileName(name: string): ImageMime {
  return /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
}

/** First 16 hex chars of the sha-256 of the encoded bytes (both platforms). */
export async function imageIdFor(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer: subtle.digest refuses a view over a SharedArrayBuffer.
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest).slice(0, IMAGE_ID_LENGTH / 2))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Whether the alpha channel is used anywhere (sampled, so large images stay cheap). */
export function hasTransparency(data: Uint8ClampedArray, step = 7): boolean {
  for (let i = 3; i < data.length; i += 4 * step) if (data[i] < 250) return true;
  return false;
}

function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Not an image'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: ImageMime, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality)
  );
}

/**
 * Downscales to ≤ 1600 px and re-encodes: JPEG q 0.82, or PNG when the picture has transparency
 * and the PNG stays under 300 KB. Throws ImageTooLargeError above 4 MB. Browser only.
 */
export async function encodeImage(file: Blob): Promise<EncodedImage> {
  const src = await decode(file);
  const sw = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const sh = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const { w, h } = fitWithin(sw, sh);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(src, 0, 0, w, h);
  if ('close' in src) src.close();

  let blob: Blob | null = null;
  const mayHaveAlpha = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/webp';
  if (mayHaveAlpha && hasTransparency(ctx.getImageData(0, 0, w, h).data)) {
    const png = await canvasToBlob(canvas, 'image/png');
    if (png.size < PNG_KEEP_MAX_BYTES) blob = png;
  }
  if (!blob) {
    // Flatten any transparency onto white before the JPEG (otherwise it turns black).
    if (mayHaveAlpha) {
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
    blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
  }
  if (blob.size > MAX_IMAGE_BYTES) throw new ImageTooLargeError(blob.size);
  const id = await imageIdFor(await blob.arrayBuffer());
  return { id, blob, w, h };
}

/** Image size of a stored blob (0×0 when it cannot be decoded). */
export async function measureImage(blob: Blob): Promise<{ w: number; h: number }> {
  try {
    const src = await decode(blob);
    const w = 'naturalWidth' in src ? src.naturalWidth : src.width;
    const h = 'naturalHeight' in src ? src.naturalHeight : src.height;
    if ('close' in src) src.close();
    return { w, h };
  } catch {
    return { w: 0, h: 0 };
  }
}

/** Image files in a clipboard or drop payload (pasting a screenshot, dragging a photo in). */
export function imageFilesOf(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  if (!out.length) for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith('image/')) out.push(f);
  return out;
}
