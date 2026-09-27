import { describe, expect, it } from 'vitest';
import {
  fitWithin,
  hasTransparency,
  imageFileName,
  imageIdFor,
  isImageId,
  mimeForFileName,
  parseImageFileName
} from './images';

describe('fitWithin', () => {
  it('never upscales', () => expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 }));
  it('scales the longest edge to 1600', () => {
    expect(fitWithin(4000, 3000)).toEqual({ w: 1600, h: 1200 });
    expect(fitWithin(1000, 3200)).toEqual({ w: 500, h: 1600 });
  });
  it('keeps at least 1 px', () => expect(fitWithin(10000, 1)).toEqual({ w: 1600, h: 1 }));
});

describe('file names', () => {
  it('round-trips the id', () => {
    expect(imageFileName('0123456789abcdef', 'image/jpeg')).toBe('nexus_img_0123456789abcdef.jpg');
    expect(imageFileName('0123456789abcdef', 'image/png')).toBe('nexus_img_0123456789abcdef.png');
    expect(parseImageFileName('nexus_img_0123456789abcdef.jpg')).toBe('0123456789abcdef');
    expect(parseImageFileName('nexus_img_0123456789ABCDEF.png')).toBe('0123456789abcdef');
    expect(mimeForFileName('nexus_img_x.png')).toBe('image/png');
    expect(mimeForFileName('nexus_img_x.jpg')).toBe('image/jpeg');
  });
  it('ignores other app files', () => {
    expect(parseImageFileName('nexus_backup.json')).toBeNull();
    expect(parseImageFileName('nexus_img_short.jpg')).toBeNull();
    expect(isImageId('0123456789abcdef')).toBe(true);
    expect(isImageId('0123456789abcdeg')).toBe(false);
  });
});

describe('imageIdFor', () => {
  it('is the first 16 hex chars of sha-256 (same as Android)', async () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await imageIdFor(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea');
  });
});

describe('hasTransparency', () => {
  it('detects any non-opaque pixel', () => {
    const opaque = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(hasTransparency(opaque, 1)).toBe(false);
    const alpha = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 10]);
    expect(hasTransparency(alpha, 1)).toBe(true);
  });
});
