/**
 * Saving a finished export (or any stored Studio file: an ad's image, a reel) onto the person's computer.
 *
 * An export is rendered by the Studio's worker and stored with the workspace's Studio files (kept 30 days,
 * lib/studio/server/sweep.ts); its link (`EditorJob.downloadUrl`) answers the MP4 as an attachment. Getting it onto the
 * computer goes one of four ways, whichever this page can do:
 *
 *   desktop          the desktop app, a file up to DESKTOP_SAVE_LIMIT: its native Save panel (lib/download.ts → the
 *                    `save_file` command), where the person picks the folder and the name. The released app's command
 *                    takes the whole file as a JSON array of numbers (about 16 bytes of memory per byte of video on the
 *                    way), so only a small file goes this way.
 *   desktop-browser  the desktop app, a larger file: a short-lived download link (POST file-links) opened in the
 *                    person's own browser, which downloads it to its downloads folder. Nothing large is held in the page.
 *   picker           a browser with a save picker (Chrome, Edge): the person picks the folder and the name first, then the
 *                    file streams straight into it.
 *   downloads        any other browser: a plain download, which the browser puts in its downloads folder (or asks, if the
 *                    person set it to).
 *
 * Every way checks the file is still there before it says anything was saved (an export older than 30 days is gone).
 */
import { downloadFile } from '@/lib/download';
import { openInSystemBrowser } from '@/lib/open-external';
import { isDesktopApp } from '@/lib/platform';

export type SaveWay = 'desktop' | 'desktop-browser' | 'picker' | 'downloads';
export type SaveResult = { kind: 'saved'; where: string } | { kind: 'downloads'; name: string } | { kind: 'browser'; name: string } | { kind: 'cancelled' };
/** What is saved: a stored file's link (/api/account/studio/file/<workspace>/<key>), the name to give it, its size when known. */
export type ExportFile = { url: string; fileName: string; bytes?: number | null };

/** The stored file's key, from its link. */
export function fileKeyOf(url: string): string | null {
  try {
    const path = new URL(url, 'http://studio.invalid').pathname, prefix = '/api/account/studio/file/';
    if (!path.startsWith(prefix)) return null;
    const key = path.slice(prefix.length).split('/').slice(1).map(decodeURIComponent).join('/');
    return key || null;
  } catch { return null; }
}

/**
 * The largest export handed to the desktop app's Save panel. Its `save_file` takes the bytes as a JSON array of numbers:
 * the file, an array of one number per byte, and that array as JSON text are all in memory at once (about 16 bytes per
 * byte), so 20 MB costs about 320 MB for a moment. Above it the file goes through the browser.
 */
export const DESKTOP_SAVE_LIMIT = 20 * 1024 * 1024;

type SaveHandle = { name: string; createWritable: () => Promise<WritableStream<Uint8Array>>; remove?: () => Promise<void> };
type SavePicker = (options: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<SaveHandle>;
const picker = (): SavePicker | null => {
  const found = typeof window === 'undefined' ? undefined : (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  return typeof found === 'function' ? found.bind(window) : null;
};

/** What the save picker offers to save as, from the name's extension. */
function pickerTypes(fileName: string): { types?: { description: string; accept: Record<string, string[]> }[] } {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  const known: Record<string, [string, string]> = { mp4: ['MP4 video', 'video/mp4'], png: ['PNG image', 'image/png'], jpg: ['JPEG image', 'image/jpeg'], jpeg: ['JPEG image', 'image/jpeg'], webm: ['WebM video', 'video/webm'] };
  const type = ext ? known[ext] : undefined;
  return type ? { types: [{ description: type[0], accept: { [type[1]]: [`.${ext}`] } }] } : {};
}

/** How this page saves a file of this size (unknown: the desktop app asks the file first, see saveExport). */
export function saveWay(bytes?: number | null): SaveWay {
  if (isDesktopApp()) return typeof bytes === 'number' && bytes > 0 && bytes <= DESKTOP_SAVE_LIMIT ? 'desktop' : 'desktop-browser';
  return picker() ? 'picker' : 'downloads';
}

/** The file name an export's link asks for (its `download` parameter), else the title's. */
export function exportFileName(url: string, title: string): string {
  try {
    const named = new URL(url, 'http://studio.invalid').searchParams.get('download');
    if (named) return named;
  } catch { /* a malformed link names nothing */ }
  return `${title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'video'}.mp4`;
}

async function failure(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: string; message?: string };
    if (body.error || body.message) return new Error(body.error ?? body.message);
  } catch { /* not JSON */ }
  return new Error(response.status === 404 ? 'This export is no longer kept: exports are kept for 30 days. Export the video again.' : `The video could not be fetched (${response.status}).`);
}

/** The file's size, asked of the server without fetching it; throws the server's sentence when it is gone. */
async function sizeOf(url: string): Promise<number | null> {
  const response = await fetch(url, { method: 'HEAD' });
  if (!response.ok) throw await failure(response);
  const length = Number(response.headers.get('content-length'));
  return Number.isFinite(length) && length > 0 ? length : null;
}

/**
 * Save an export. Call it straight from a click: the browser's save picker opens only then. `way` is worked out from
 * the size when not given. Throws a sentence the dialog can show.
 */
export async function saveExport(file: ExportFile, way?: SaveWay): Promise<SaveResult> {
  const { url, fileName } = file;
  if (isDesktopApp() && way !== 'desktop-browser') {
    // The size decides the way: asked of the server when the job did not say (which also checks it is still kept).
    const bytes = typeof file.bytes === 'number' && file.bytes > 0 ? file.bytes : await sizeOf(url);
    way = saveWay(bytes);
  }
  way ??= saveWay(file.bytes);
  if (way === 'desktop') {
    const path = await downloadFile(url, fileName);
    return path ? { kind: 'saved', where: path } : { kind: 'cancelled' };
  }
  if (way === 'desktop-browser') {
    const key = fileKeyOf(url);
    if (!key) throw new Error('This file cannot be downloaded from here.');
    const minted = await fetch('/api/account/studio/file-links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, name: fileName }) });
    if (!minted.ok) throw await failure(minted);
    const { url: link } = await minted.json() as { url: string };
    if (!await openInSystemBrowser(new URL(link, window.location.origin).toString())) throw new Error('Your browser could not be opened. Try again.');
    return { kind: 'browser', name: fileName };
  }
  const pick = way === 'picker' ? picker() : null;
  if (pick) {
    let handle: SaveHandle;
    try { handle = await pick({ suggestedName: fileName, ...pickerTypes(fileName) }); }
    catch (cause) {
      if ((cause as { name?: string })?.name === 'AbortError') return { kind: 'cancelled' };
      // The picker refused this page (a frame, a policy): the plain download still works.
      return saveExport(file, 'downloads');
    }
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      // The picker made an empty file: take it away again.
      await handle.remove?.().catch(() => undefined);
      throw await failure(response);
    }
    const writable = await handle.createWritable();
    try { await response.body.pipeTo(writable); }
    catch (cause) { await writable.abort(cause).catch(() => undefined); throw new Error(`The video could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`); }
    return { kind: 'saved', where: handle.name };
  }
  // A plain link: the browser streams it to its downloads folder under the name the server gives it. Checked first,
  // so a file that is gone says so instead of "sent".
  await sizeOf(url);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  return { kind: 'downloads', name: fileName };
}
