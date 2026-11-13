/**
 * Arriving in the browser to download a finished export.
 *
 * The desktop app hands an export too large for its Save panel (./save-export.ts DESKTOP_SAVE_LIMIT) to the person's
 * own browser: it opens the app there at `/login?redirect=<the video's deep link>&export=<job>` (exportArrivalLink).
 * A signed-in browser goes straight on to the link (app/login/page.tsx); a signed-out one signs in first and comes
 * back to it (the `redirect` survives a password and an OAuth sign-in: lib/auth/login-redirect.ts,
 * post-auth-redirect.ts). The app's boot opens the Studio on the video (`?page=studio&video=`, in its workspace:
 * `&workspace=`) and leaves `export=` for the Studio, which then (arriveAtExport):
 *
 *   - reads the job through the person's own session (a job of another workspace is not found);
 *   - opens the video the export was made from, if another is open;
 *   - starts one plain download through the signed-in file route (`?download=`: an attachment), never twice from one
 *     arrival (a reload, back and forward: the parameter is removed once handled, and the tab remembers the job);
 *   - and says what happened, in the Export dialog on that export.
 */
import type { EditorJob } from '@/lib/studio/engine/api';
import { studioVideoLink } from '@/lib/chat-cards/open-card';

/** The deep link's parameter: the finished export to download. */
export const EXPORT_PARAM = 'export';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLED_KEY = 'ni:studio:export-arrivals';

/** Where the desktop app sends the person's browser to download an export there. */
export function exportArrivalLink(origin: string, to: { videoId: string; jobId: string; workspaceId: string | null }): string {
  const link = `${studioVideoLink(to.videoId)}&${EXPORT_PARAM}=${encodeURIComponent(to.jobId)}${to.workspaceId ? `&workspace=${encodeURIComponent(to.workspaceId)}` : ''}`;
  return `${origin}/login?redirect=${encodeURIComponent(link)}`;
}

/** The export a page's address asks to download, or null (ids only: the address is anyone's to write). */
export function readExportArrival(search: string): string | null {
  const id = new URLSearchParams(search).get(EXPORT_PARAM);
  return id && ID.test(id) ? id : null;
}

/** Take the parameter off the address, so a reload or a step back and forward does not arrive again. */
export function clearExportArrival(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has(EXPORT_PARAM)) return;
    params.delete(EXPORT_PARAM);
    const rest = params.toString();
    window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
  } catch { /* an address that cannot be rewritten: the tab's memory still holds */ }
}

/** The exports this tab has already started a download for (kept for the tab, as sessionStorage is). */
function handled(): string[] {
  try { const list = JSON.parse(sessionStorage.getItem(HANDLED_KEY) ?? '[]'); return Array.isArray(list) ? list.filter(item => typeof item === 'string') : []; } catch { return []; }
}
export function arrivedBefore(jobId: string): boolean { return handled().includes(jobId); }
export function markArrived(jobId: string): void {
  try { sessionStorage.setItem(HANDLED_KEY, JSON.stringify([...handled().filter(id => id !== jobId), jobId].slice(-20))); } catch { /* preference only */ }
}

export type ArrivalOutcome =
  /** The export was made from another video: open that one, then arrive again. */
  | { kind: 'open-video'; videoId: string }
  /** The download has started. */
  | { kind: 'started'; job: EditorJob }
  /** This tab started it before (a reload): nothing again, the export is shown to save by hand. */
  | { kind: 'again'; job: EditorJob }
  /** Its file is gone (kept 30 days), or it never finished. */
  | { kind: 'gone'; text: string; job?: EditorJob }
  /** No such export where this person is (another workspace, a made-up id). */
  | { kind: 'not-found'; text: string };

export const ARRIVAL_WORDS = {
  started: 'Your download has started. It goes to this browser’s downloads folder.',
  again: 'This export was downloaded in this tab already. Save it again below if you need another copy.',
  notFound: 'This export is not in the workspace open here. Switch to the workspace it was made in, or export the video again.',
  unfinished: 'This export did not finish, so there is nothing to download. Export the video again.',
  gone: 'This export is no longer kept: exports are kept for 30 days. Export the video again.',
} as const;

/**
 * Arrive at export `jobId` with video `projectId` open. `download` starts the plain download (and throws the server's
 * sentence when the file is gone); `getJob` reads the job through the person's session.
 */
export async function arriveAtExport(jobId: string, projectId: string, deps: {
  getJob: (id: string) => Promise<EditorJob>;
  download: (job: EditorJob) => Promise<void>;
  before?: (id: string) => boolean;
  mark?: (id: string) => void;
}): Promise<ArrivalOutcome> {
  let job: EditorJob;
  try { job = await deps.getJob(jobId); } catch { return { kind: 'not-found', text: ARRIVAL_WORDS.notFound }; }
  if (job.kind !== 'export') return { kind: 'not-found', text: ARRIVAL_WORDS.notFound };
  if (job.videoId && job.videoId !== projectId) return { kind: 'open-video', videoId: job.videoId };
  if (job.status !== 'completed') return { kind: 'gone', text: job.status === 'running' ? 'This export is still rendering. It can be downloaded here when it is done.' : ARRIVAL_WORDS.unfinished, job };
  if (!job.downloadUrl) return { kind: 'gone', text: ARRIVAL_WORDS.gone, job };
  if ((deps.before ?? arrivedBefore)(jobId)) return { kind: 'again', job };
  (deps.mark ?? markArrived)(jobId);
  try { await deps.download(job); } catch (cause) { return { kind: 'gone', text: cause instanceof Error && cause.message ? cause.message : ARRIVAL_WORDS.gone, job }; }
  return { kind: 'started', job };
}
