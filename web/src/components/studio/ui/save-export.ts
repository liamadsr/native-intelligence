/**
 * Saving a finished export onto the person's computer.
 *
 * An export is rendered by the Studio's worker and stored with the workspace's Studio files (kept 30 days,
 * lib/studio/server/sweep.ts); its link (`EditorJob.downloadUrl`) answers the MP4 as an attachment. Getting it onto the
 * computer goes one of three ways, whichever this page can do:
 *
 *   desktop    the desktop app: its native Save panel (lib/download.ts → the `save_file` command), where the person
 *              picks the folder and the name. The bytes are fetched first, then handed to the app.
 *   picker     a browser with a save picker (Chrome, Edge): the person picks the folder and the name first, then the
 *              file streams straight into it.
 *   downloads  any other browser: a plain download, which the browser puts in its downloads folder (or asks, if the
 *              person set it to).
 */
import { downloadFile } from '@/lib/download';
import { isDesktopApp } from '@/lib/platform';

export type SaveWay = 'desktop' | 'picker' | 'downloads';
export type SaveResult = { kind: 'saved'; where: string } | { kind: 'downloads'; name: string } | { kind: 'cancelled' };

type SaveHandle = { name: string; createWritable: () => Promise<WritableStream<Uint8Array>> };
type SavePicker = (options: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<SaveHandle>;
const picker = (): SavePicker | null => {
  const found = typeof window === 'undefined' ? undefined : (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  return typeof found === 'function' ? found.bind(window) : null;
};

/** How this page saves a file. */
export function saveWay(): SaveWay {
  if (isDesktopApp()) return 'desktop';
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
  return new Error(`The video could not be fetched (${response.status}).`);
}

/**
 * Save the export at `url` as `fileName`. Call it straight from a click: the browser's save picker opens only then.
 * Throws a sentence the dialog can show.
 */
export async function saveExport(url: string, fileName: string, way: SaveWay = saveWay()): Promise<SaveResult> {
  if (way === 'desktop') {
    const path = await downloadFile(url, fileName);
    return path ? { kind: 'saved', where: path } : { kind: 'cancelled' };
  }
  const pick = way === 'picker' ? picker() : null;
  if (pick) {
    let handle: SaveHandle;
    try { handle = await pick({ suggestedName: fileName, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] }); }
    catch (cause) {
      if ((cause as { name?: string })?.name === 'AbortError') return { kind: 'cancelled' };
      // The picker refused this page (a frame, a policy): the plain download still works.
      return saveExport(url, fileName, 'downloads');
    }
    const response = await fetch(url);
    if (!response.ok || !response.body) throw await failure(response);
    const writable = await handle.createWritable();
    try { await response.body.pipeTo(writable); }
    catch (cause) { await writable.abort(cause).catch(() => undefined); throw new Error(`The video could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`); }
    return { kind: 'saved', where: handle.name };
  }
  // A plain link: the browser streams it to its downloads folder under the name the server gives it.
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  return { kind: 'downloads', name: fileName };
}
