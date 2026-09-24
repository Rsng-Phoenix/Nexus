/**
 * Minimal ZIP reader, enough for .xlsx: end-of-central-directory → central directory → local
 * headers. Stored (0) and deflate (8) entries; deflate goes through the platform's
 * DecompressionStream('deflate-raw'), so no dependency. Entries inflate lazily on read().
 *
 * Hostile-file guards: entry count and total uncompressed size are capped, an entry that inflates
 * past its declared size is rejected, CRC-32 is verified, and entries with odd paths (absolute,
 * drive letters, "..", NUL) are ignored. ZIP64, multi-disk and encrypted archives are refused.
 */
export const ZIP_MAX_ENTRIES = 5000;
export const ZIP_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export type ZipLimits = { maxEntries?: number; maxTotalBytes?: number };

export interface ZipArchive {
  /** Entry names (files only, normalised to forward slashes), in central-directory order. */
  list(): string[];
  has(name: string): boolean;
  /** Inflates one entry; null when the archive has no such file. */
  read(name: string): Promise<Uint8Array | null>;
  readText(name: string): Promise<string | null>;
}

type Entry = {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

let CRC_TABLE: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Forward slashes, no leading "./"; null for anything that could escape or confuse a path. */
function safeEntryName(raw: string): string | null {
  if (raw.includes('\0')) return null;
  let name = raw.replace(/\\/g, '/');
  while (name.startsWith('./')) name = name.slice(2);
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  if (name.split('/').some((seg) => seg === '..')) return null;
  return name;
}

function findEocd(view: DataView): number {
  const len = view.byteLength;
  if (len < EOCD_MIN) return -1;
  const stop = Math.max(0, len - EOCD_MIN - MAX_COMMENT);
  for (let i = len - EOCD_MIN; i >= stop; i--) {
    if (view.getUint32(i, true) === SIG_EOCD && i + EOCD_MIN + view.getUint16(i + 20, true) <= len) {
      return i;
    }
  }
  return -1;
}

async function inflateRaw(data: Uint8Array<ArrayBuffer>, maxOut: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('This browser cannot read compressed files');
  }
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(data).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxOut) {
        reader.cancel().catch(() => {});
        throw new ZipError('A file inside the archive is larger than it claims');
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError('The archive is damaged (bad compressed data)');
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}

export async function readZip(buf: ArrayBuffer | Uint8Array, limits: ZipLimits = {}): Promise<ZipArchive> {
  const maxEntries = limits.maxEntries ?? ZIP_MAX_ENTRIES;
  const maxTotal = limits.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;

  const eocd = findEocd(view);
  if (eocd < 0) throw new ZipError('Not a ZIP file');
  const diskNo = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported');
  }
  if (diskNo !== 0 || cdDisk !== 0) throw new ZipError('Multi-part ZIP archives are not supported');
  if (total > maxEntries) throw new ZipError(`Too many files in the archive (${total})`);
  if (cdOffset + cdSize > eocd) throw new ZipError('The archive is damaged (central directory)');

  const decoder = new TextDecoder('utf-8');
  const entries = new Map<string, Entry>();
  let declaredTotal = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipError('The archive is damaged (central directory entry)');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen > eocd) throw new ZipError('The archive is damaged (entry name)');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('ZIP64 archives are not supported');
    }
    const rawName = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const name = safeEntryName(rawName);
    if (name === null || name.endsWith('/') || entries.has(name)) continue;
    declaredTotal += size;
    if (declaredTotal > maxTotal) throw new ZipError('The archive is too large when uncompressed');
    if (localOffset + 30 > len) throw new ZipError('The archive is damaged (entry offset)');
    entries.set(name, { name, method, flags, crc, compressedSize, size, localOffset });
  }

  async function read(name: string): Promise<Uint8Array | null> {
    const e = entries.get(name);
    if (!e) return null;
    if (e.flags & 1) throw new ZipError('Encrypted files are not supported');
    const lo = e.localOffset;
    if (view.getUint32(lo, true) !== SIG_LOCAL) throw new ZipError('The archive is damaged (local header)');
    const start = lo + 30 + view.getUint16(lo + 26, true) + view.getUint16(lo + 28, true);
    const end = start + e.compressedSize;
    if (end > len) throw new ZipError('The archive is damaged (truncated entry)');
    const raw = new Uint8Array(e.compressedSize);
    raw.set(bytes.subarray(start, end));

    let out: Uint8Array;
    if (e.method === 0) {
      if (e.compressedSize !== e.size) throw new ZipError('The archive is damaged (stored size)');
      out = raw;
    } else if (e.method === 8) {
      out = await inflateRaw(raw, e.size);
    } else {
      throw new ZipError(`Unsupported compression method ${e.method}`);
    }
    if (out.byteLength !== e.size) throw new ZipError('The archive is damaged (size mismatch)');
    if (crc32(out) !== e.crc) throw new ZipError('The archive is damaged (checksum mismatch)');
    return out;
  }

  return {
    list: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    async readText(name) {
      const data = await read(name);
      return data ? decoder.decode(data) : null;
    }
  };
}
