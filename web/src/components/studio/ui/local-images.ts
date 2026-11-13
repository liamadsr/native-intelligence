// A picture's size before it is decoded, for stills in a folder on this computer (local-folders.ts). A small file can
// hold an enormous picture (a 3 MB PNG of 40,000 by 40,000 pixels takes 6.4 GB once decoded), and a linked folder's
// rows draw thumbnails on their own as they scroll into view, so nothing is decoded before its size is known and
// within MAX_PIXELS.
//
// How the size is learnt, without decoding:
//   1. the file's own header, read from its first bytes (PNG, JPEG, GIF, WebP, BMP): exact, and the same in every
//      browser, since no image code runs at all;
//   2. for the rest (HEIC, AVIF, TIFF, SVG), an <img> that is never put in the page nor asked to decode: its `load`
//      event comes once the browser has read the header, and `naturalWidth`/`naturalHeight` are known then. Chromium
//      and WebKit both decode a bitmap lazily, when it is first drawn or `decode()` is called, so an image that is
//      only loaded and measured is never decoded. (WebKit's BitmapImage decodes frames on draw; Blink's
//      ImageResourceContent keeps the encoded bytes until paint or an explicit decode.)
export const MAX_PIXELS = 64_000_000;
const HEAD_BYTES = 256 * 1024;

export type PictureSize = { width: number; height: number };
export class PictureTooLarge extends Error {
  constructor(readonly file: string, readonly size: PictureSize) {
    super(`${file} is ${size.width.toLocaleString('en-US')} × ${size.height.toLocaleString('en-US')} pixels, too large a picture to open here. Save a smaller copy first.`);
  }
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const i32le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** A picture's size from its header bytes (PNG, JPEG, GIF, WebP, BMP), or null for a format it does not know. */
export function sizeFromHeader(b: Uint8Array): PictureSize | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') return { width: u32be(b, 16), height: u32be(b, 20) };
  if (b.length >= 10 && ascii(b, 0, 4) === 'GIF8') return { width: u16le(b, 6), height: u16le(b, 8) };
  if (b.length >= 26 && ascii(b, 0, 2) === 'BM') return { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8L' && b.length >= 25) return { width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!), height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)) };
    if (b.length < 30) return null;
    if (chunk === 'VP8X') return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
    if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the JPEG's segments to its frame header (SOFn), which holds the size.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
      i += 2 + u16be(b, i + 2);
    }
    return null;
  }
  return null;
}

/** Measure a picture with an <img> that is loaded but never drawn nor decoded (see the top of this file). */
export function naturalSize(file: Blob): Promise<PictureSize | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file), img = new Image();
    const done = (size: PictureSize | null) => { img.onload = img.onerror = null; img.removeAttribute('src'); URL.revokeObjectURL(url); resolve(size); };
    img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => done(null);
    img.src = url;
  });
}

/** A picture's size, from its header when the format is known, else by measuring it undecoded. */
export async function pictureSize(file: Blob, measure: (file: Blob) => Promise<PictureSize | null> = naturalSize): Promise<PictureSize | null> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  return sizeFromHeader(head) ?? measure(file);
}

/** The picture's size when it is within `budget` pixels; PictureTooLarge when it is not; null when it can't be read. */
export async function checkedPicture(file: File, budget = MAX_PIXELS, measure?: (file: Blob) => Promise<PictureSize | null>): Promise<PictureSize | null> {
  const size = await pictureSize(file, measure);
  if (size && size.width * size.height > budget) throw new PictureTooLarge(file.name, size);
  return size;
}
