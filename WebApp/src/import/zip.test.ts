import { describe, expect, it } from 'vitest';
import { makeZip } from './testing/zip-writer';
import { ZipError, crc32, readZip } from './zip';

const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

describe('readZip', () => {
  it('reads stored and deflated entries lazily', async () => {
    const zip = await readZip(
      await makeZip([
        { name: 'a.txt', data: 'hello stored', method: 0 },
        { name: 'dir/b.xml', data: '<x>'.repeat(1000), method: 8 }
      ])
    );
    expect(zip.list()).toEqual(['a.txt', 'dir/b.xml']);
    expect(text(await zip.read('a.txt'))).toBe('hello stored');
    expect(await zip.readText('dir/b.xml')).toBe('<x>'.repeat(1000));
    expect(await zip.read('missing')).toBeNull();
  });

  it('accepts an ArrayBuffer', async () => {
    const bytes = await makeZip([{ name: 'x', data: 'y' }]);
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const zip = await readZip(ab);
    expect(await zip.readText('x')).toBe('y');
  });

  it('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('rejects non-zip data', async () => {
    await expect(readZip(new TextEncoder().encode('just text, no zip here'))).rejects.toThrow(ZipError);
    await expect(readZip(new Uint8Array(3))).rejects.toThrow('Not a ZIP file');
  });

  it('ignores entries with dangerous or odd paths', async () => {
    const zip = await readZip(
      await makeZip([
        { name: '../evil.txt', data: 'x' },
        { name: '/etc/passwd', data: 'x' },
        { name: 'C:/win.ini', data: 'x' },
        { name: 'a/../../up', data: 'x' },
        { name: 'nul\0byte', data: 'x' },
        { name: 'folder/', data: '' },
        { name: 'win\\style.txt', data: 'ok' },
        { name: './dot.txt', data: 'ok' }
      ])
    );
    expect(zip.list()).toEqual(['win/style.txt', 'dot.txt']);
    expect(await zip.readText('win/style.txt')).toBe('ok');
  });

  it('refuses a zip bomb by declared size before inflating anything', async () => {
    const zeros = new Uint8Array(51 * 1024 * 1024);
    const bomb = await makeZip([{ name: 'bomb.xml', data: zeros }]);
    expect(bomb.byteLength).toBeLessThan(200 * 1024);
    await expect(readZip(bomb)).rejects.toThrow('too large when uncompressed');
  });

  it('refuses an entry that inflates past its declared size', async () => {
    const zip = await readZip(
      await makeZip([{ name: 'liar.xml', data: new Uint8Array(1024 * 1024), declaredSize: 10 }])
    );
    await expect(zip.read('liar.xml')).rejects.toThrow('larger than it claims');
  });

  it('caps the number of entries', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}`, data: '', method: 0 as const }));
    await expect(readZip(await makeZip(many))).rejects.toThrow('Too many files');
    const few = await makeZip([{ name: 'a', data: '1' }, { name: 'b', data: '2' }]);
    await expect(readZip(few, { maxEntries: 1 })).rejects.toThrow('Too many files');
  });

  it('detects checksum mismatches and corrupt data', async () => {
    const zip = await readZip(await makeZip([{ name: 'a', data: 'abc', crc: 1234 }]));
    await expect(zip.read('a')).rejects.toThrow('checksum');
    const bytes = await makeZip([{ name: 'b', data: 'hello hello hello hello' }]);
    bytes[30 + 1] ^= 0xff; // flip the first deflate byte
    bytes[30 + 2] ^= 0xff;
    const bad = await readZip(bytes);
    await expect(bad.read('b')).rejects.toThrow(ZipError);
  });

  it('fails gracefully on ZIP64 archives', async () => {
    const z64 = await makeZip([{ name: 'a', data: 'x' }], (v) => {
      v.setUint16(8, 0xffff, true);
      v.setUint16(10, 0xffff, true);
    });
    await expect(readZip(z64)).rejects.toThrow('ZIP64');
  });
});
