/**
 * Arriving in the browser to download a finished export.
 *
 * The desktop app hands an export too large for its Save panel (./save-export.ts DESKTOP_SAVE_LIMIT) to the person's
 * own browser: it opens the app there at `/login?redirect=<deep link>`, where the deep link is
 * `/account?page=studio&video=<video>&export=<job>&workspace=<workspace>` (exportArrivalLink: `export=` is inside the
 * `redirect` value, as part of the deep link). A signed-in browser goes straight on to the deep link
 * (app/login/page.tsx); a signed-out one signs in first and comes back to it (lib/auth/login-redirect.ts,
 * post-auth-redirect.ts).
 *
 * The app's boot (main-chat-context.tsx) opens the Studio on the video in its workspace and takes `export=` off the
 * address, whatever came with it. It keeps it for the Studio (stashExportArrival) only when it came with
 * `page=studio&video=`, for this tab and ARRIVAL_TTL_MS. The Studio (useExportArrival) takes it once, opens the video
 * if another is open, then (arriveAtExport):
 *
 *   - reads the job through the person's own session (a job of another workspace is not found);
 *   - starts one plain download through the signed-in file route (`?download=`: an attachment), and never another for
 *     the same job for ARRIVAL_TTL_MS in this browser, whatever tab (a reload, back and forward, the link opened twice);
 *   - and says what happened, in the Export dialog on that export.
 *
 * Every outcome, a video that cannot be opened included, ends the arrival and marks the job: nothing waits to act later.
 */
import { useEffect, useRef } from 'react';
import type { EditorJob } from '@/lib/studio/engine/api';
import { studioVideoLink } from '@/lib/chat-cards/open-card';

/** The deep link's parameter: the finished export to download. */
export const EXPORT_PARAM = 'export';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long an arrival may wait for the Studio, and how long a job's download is not started again. */
export const ARRIVAL_TTL_MS = 10 * 60 * 1000;
const HANDLED_KEY = 'ni:studio:export-arrivals';
const STASH_KEY = 'ni:studio:export-arrival';

/** Where the desktop app sends the person's browser to download an export there. */
export function exportArrivalLink(origin: string, to: { videoId: string; jobId: string; workspaceId: string | null }): string {
  const link = `${studioVideoLink(to.videoId)}&${EXPORT_PARAM}=${encodeURIComponent(to.jobId)}${to.workspaceId ? `&workspace=${encodeURIComponent(to.workspaceId)}` : ''}`;
  return `${origin}/login?redirect=${encodeURIComponent(link)}`;
}

/** The export an address asks the Studio to download: only beside `page=studio&video=<id>`, ids only. */
export function exportArrivalOf(params: URLSearchParams): { videoId: string; jobId: string } | null {
  const jobId = params.get(EXPORT_PARAM), videoId = params.get('video');
  if (params.get('page') !== 'studio' || !jobId || !videoId || !ID.test(jobId) || !ID.test(videoId)) return null;
  return { videoId, jobId };
}

/** Keep an arrival for the Studio of this tab (the boot, which takes `export=` off the address). */
export function stashExportArrival(arrival: { videoId: string; jobId: string }, now = Date.now()): void {
  try { sessionStorage.setItem(STASH_KEY, JSON.stringify({ ...arrival, at: now })); } catch { /* no storage: no download */ }
}

/**
 * The boot's part (main-chat-context.tsx): take `export=` off an address, keeping it for the Studio only when it came
 * with `page=studio&video=`. True when there was one to take off (the address then needs rewriting).
 */
export function takeExportFromAddress(params: URLSearchParams, now = Date.now()): boolean {
  if (!params.has(EXPORT_PARAM)) return false;
  const arrival = exportArrivalOf(params);
  if (arrival) stashExportArrival(arrival, now);
  params.delete(EXPORT_PARAM);
  return true;
}

/** The arrival the boot kept, once: it is removed as it is read, and an old one is dropped. */
export function takeExportArrival(now = Date.now()): { videoId: string; jobId: string; at: number } | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    sessionStorage.removeItem(STASH_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { videoId?: unknown; jobId?: unknown; at?: unknown };
    if (typeof value.videoId !== 'string' || typeof value.jobId !== 'string' || typeof value.at !== 'number' || !ID.test(value.videoId) || !ID.test(value.jobId)) return null;
    if (now - value.at > ARRIVAL_TTL_MS) return null;
    return { videoId: value.videoId, jobId: value.jobId, at: value.at };
  } catch { return null; }
}

/** Jobs downloaded on arrival lately, in this browser (every tab): job id → when. */
function handled(now: number): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(HANDLED_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && now - entry[1] < ARRIVAL_TTL_MS));
  } catch { return {}; }
}
export function arrivedBefore(jobId: string, now = Date.now()): boolean { return jobId in handled(now); }
export function markArrived(jobId: string, now = Date.now()): void {
  try { localStorage.setItem(HANDLED_KEY, JSON.stringify({ ...handled(now), [jobId]: now })); } catch { /* no storage: the tab's own arrival still ends */ }
}

export type ArrivalOutcome =
  /** The export was made from another video: open that one, then arrive again. */
  | { kind: 'open-video'; videoId: string }
  /** The download has started. */
  | { kind: 'started'; job: EditorJob }
  /** Downloaded on arrival lately (another tab, a reload): nothing again, the export is shown to save by hand. */
  | { kind: 'again'; job: EditorJob }
  /** Its file is gone (kept 30 days), or it never finished. */
  | { kind: 'gone'; text: string; job?: EditorJob }
  /** No such export where this person is (another workspace, a made-up id), or its video cannot be opened. */
  | { kind: 'not-found'; text: string };

export const ARRIVAL_WORDS = {
  started: 'Your download has started. It goes to this browser’s downloads folder.',
  again: 'This export was downloaded here a moment ago. Save it again below if you need another copy.',
  notFound: 'This export is not in the workspace open here. Switch to the workspace it was made in, or export the video again.',
  noVideo: 'The video this export was made from could not be opened, so nothing was downloaded.',
  unfinished: 'This export did not finish, so there is nothing to download. Export the video again.',
  gone: 'This export is no longer kept: exports are kept for 30 days. Export the video again.',
} as const;

type ArrivalDeps = {
  getJob: (id: string) => Promise<EditorJob>;
  download: (job: EditorJob) => Promise<void>;
  before?: (id: string) => boolean;
  mark?: (id: string) => void;
};

/**
 * Arrive at export `jobId` with video `projectId` open. `download` starts the plain download (and throws the server's
 * sentence when the file is gone); `getJob` reads the job through the person's session.
 */
export async function arriveAtExport(jobId: string, projectId: string, deps: ArrivalDeps): Promise<ArrivalOutcome> {
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

/** What the arrival ended with, for the Export dialog: never 'open-video' (that is followed first). */
export type ArrivalShown = Exclude<ArrivalOutcome, { kind: 'open-video' }>;

/** What the Export dialog says about how an arrival ended. */
export function arrivalNotice(shown: ArrivalShown): { tone: 'ok' | 'warn'; text: string } {
  return shown.kind === 'started' ? { tone: 'ok', text: ARRIVAL_WORDS.started } : shown.kind === 'again' ? { tone: 'ok', text: ARRIVAL_WORDS.again } : { tone: 'warn', text: shown.text };
}

/**
 * The Studio's side of an arrival (App.tsx). Once a video is open (`projectId`), takes the arrival the boot kept, opens
 * its video if another is open (`openVideo`, true when it opened), arrives, and hands the result to `show`. One video
 * hop at most (the link's video, then the export's own if they differ); a video that does not open, or an arrival older
 * than ARRIVAL_TTL_MS, ends it. The job is marked on every outcome.
 */
export function useExportArrival(projectId: string | null, deps: ArrivalDeps & { openVideo: (videoId: string) => Promise<boolean>; show: (outcome: ArrivalShown) => void; now?: () => number }): void {
  const live = useRef(deps);
  live.current = deps;
  const pending = useRef<{ videoId: string; jobId: string; at: number; hops: number; opening: boolean } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    const d = live.current, now = (d.now ?? Date.now)();
    if (!pending.current) {
      const taken = takeExportArrival(now);
      if (!taken) return;
      pending.current = { ...taken, hops: 0, opening: false };
    }
    const p = pending.current;
    const end = (shown: ArrivalShown | null) => { if (pending.current === p) pending.current = null; (d.mark ?? markArrived)(p.jobId); if (shown) d.show(shown); };
    if (now - p.at > ARRIVAL_TTL_MS) { end(null); return; }
    if (p.videoId !== projectId) {
      if (p.opening) return;
      p.opening = true;
      void d.openVideo(p.videoId).then(opened => { if (!opened && pending.current === p) end({ kind: 'not-found', text: ARRIVAL_WORDS.noVideo }); }, () => { if (pending.current === p) end({ kind: 'not-found', text: ARRIVAL_WORDS.noVideo }); });
      return;
    }
    pending.current = null;
    void arriveAtExport(p.jobId, projectId, d).then(outcome => {
      if (outcome.kind === 'open-video') {
        if (p.hops > 0) { end({ kind: 'not-found', text: ARRIVAL_WORDS.notFound }); return; }
        const next = { ...p, videoId: outcome.videoId, hops: p.hops + 1, opening: true };
        pending.current = next;
        void d.openVideo(outcome.videoId).then(opened => { if (!opened && pending.current === next) { pending.current = null; (d.mark ?? markArrived)(p.jobId); d.show({ kind: 'not-found', text: ARRIVAL_WORDS.noVideo }); } });
        return;
      }
      end(outcome);
    });
  }, [projectId]);
}
