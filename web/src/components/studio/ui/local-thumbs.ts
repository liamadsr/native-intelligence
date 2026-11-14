// Small pictures for the rows of a linked folder (local-folders.ts) that are on screen: a still drawn down to a
// thumbnail, a frame from a video. Made in this page, two at a time, only for a row that is still wanted when its
// turn comes, and kept as small JPEG object URLs (the most recent THUMBS_KEPT; older ones are let go). The file is
// read through an object URL, never into memory whole; a still larger than THUMB_MAX_BYTES, or whose picture is over
// MAX_PIXELS (local-images.ts, learnt before decoding), gets no picture.
import { checkedPicture, MAX_PIXELS, type PictureSize } from './local-images';

export const THUMBS_KEPT = 400;
export const THUMB_MAX_BYTES = 40 * 1024 ** 2;
const SIDE = 96, AT_ONCE = 2, VIDEO_WAIT_MS = 8000;

type Job = { run: () => Promise<void>; wanted: () => boolean; skip: () => void };
const made = new Map<string, Promise<string | null>>(), urls = new Map<string, string>();
const queue: Job[] = [];
let running = 0;

function pump() {
  while (running < AT_ONCE && queue.length) {
    const job = queue.shift()!;
    if (!job.wanted()) { job.skip(); continue; }
    running++; void job.run().finally(() => { running--; pump(); });
  }
}

/** Keep at most THUMBS_KEPT pictures; the oldest are let go. */
function trim() {
  while (made.size > THUMBS_KEPT) {
    const oldest = made.keys().next().value as string;
    made.delete(oldest); const url = urls.get(oldest); if (url) { URL.revokeObjectURL(url); urls.delete(oldest); }
  }
}

function toThumb(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  const scale = Math.min(1, SIDE * 2 / Math.max(width, height, 1)), canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(blob => { canvas.width = canvas.height = 0; resolve(blob); }, 'image/jpeg', 0.8));
}

/** A still's thumbnail. Its size is learnt first without decoding it (local-images.ts): a picture over MAX_PIXELS gets
 *  none. Where the browser can, it decodes straight to the thumbnail's size (createImageBitmap with resizeWidth);
 *  otherwise (an SVG, or a browser without resize options) through an <img>. */
export async function stillThumb(file: File): Promise<Blob | null> {
  if (file.size > THUMB_MAX_BYTES) return null;
  let size: PictureSize | null;
  try { size = await checkedPicture(file, MAX_PIXELS); } catch { return null; }
  if (!size) return null;
  if (size.width > 0 && size.height > 0 && typeof createImageBitmap === 'function') {
    const scale = Math.min(1, SIDE * 2 / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * scale)), height = Math.max(1, Math.round(size.height * scale));
    try {
      const bitmap = await createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
      try { return await toThumb(bitmap, width, height); } finally { bitmap.close(); }
    } catch { /* an SVG, or no resize options here: the <img> below */ }
  }
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.decoding = 'async'; img.src = url; await img.decode(); return await toThumb(img, img.naturalWidth || SIDE, img.naturalHeight || SIDE); }
  finally { URL.revokeObjectURL(url); }
}

async function frame(file: File): Promise<Blob | null> {
  const url = URL.createObjectURL(file), video = document.createElement('video');
  video.muted = true; video.preload = 'metadata'; video.playsInline = true;
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), VIDEO_WAIT_MS);
      video.onloadedmetadata = () => { video.currentTime = Math.min(1, (video.duration || 0) * 0.25) || 0; };
      video.onseeked = () => { clearTimeout(timer); void toThumb(video, video.videoWidth, video.videoHeight).then(resolve, reject); };
      video.onerror = () => { clearTimeout(timer); resolve(null); };
      video.src = url;
    });
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}

/** A thumbnail's object URL for `key` (a place, a path, a size and a date), or null when there is none to make.
 *  `wanted` is asked when the job's turn comes: a row scrolled away by then costs nothing. */
export function localThumb(key: string, kind: 'image' | 'video', file: () => Promise<File>, wanted: () => boolean): Promise<string | null> {
  const known = made.get(key);
  if (known) { made.delete(key); made.set(key, known); return known; }
  let settle!: (url: string | null) => void;
  const promise = new Promise<string | null>(resolve => { settle = resolve; });
  queue.push({
    wanted,
    skip: () => settle(null),
    run: async () => {
      try {
        const blob = await (kind === 'image' ? stillThumb : frame)(await file());
        if (!blob) { made.set(key, Promise.resolve(null)); trim(); settle(null); return; }
        const url = URL.createObjectURL(blob); urls.set(key, url); made.set(key, Promise.resolve(url)); trim(); settle(url);
      } catch { made.set(key, Promise.resolve(null)); trim(); settle(null); }
    },
  });
  pump();
  return promise;
}

/** Let go of a place's pictures (it was removed or chosen again). */
export function forgetThumbs(prefix: string) {
  for (const key of [...made.keys()]) if (key.startsWith(prefix)) { made.delete(key); const url = urls.get(key); if (url) { URL.revokeObjectURL(url); urls.delete(key); } }
}
