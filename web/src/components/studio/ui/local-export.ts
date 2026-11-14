/**
 * An export on the person's own computer, the page's side.
 *
 * In the desktop app (macOS and Windows), when its engine is the Studio's own render version, an export runs on the
 * computer (lib/studio/server/job-contract.ts, "the person's own computer") and is saved where the person chose;
 * otherwise, and in a browser, it runs on our server as before. There is no setting for it: this computer when it can.
 *
 *   readLocalCapability   what this computer can do: nothing (a browser), not (with the reason, in one sentence),
 *                         not yet (a first-time download, of a size), or yes. The desktop app's status command answers;
 *                         a build without it ("command … not found") is an app older than the Studio's computer export.
 *   startOnComputer       queue the export for this computer (POST export {where: 'computer'}) and hand its token to the
 *                         app; a video only the server can make (another render version, code scenes) or an app that
 *                         cannot start it goes to the server instead, with the sentence saying why.
 *   localView             what the dialog shows of an export on this computer, from the job as the server reads it and
 *                         the app's own events: rendering, waiting for this computer (asleep, quit: continue here or
 *                         finish on the server), saved and uploading, done (also in the Studio, or kept here only),
 *                         failed, stopped.
 *
 * Paths on the computer never reach the page: the app answers a destination's id and its file name only.
 */
import type { EditorJob } from '@/lib/studio/engine/api';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { STUDIO_RENDER_VERSION } from '@/lib/studio/engine/render-version';
import { studioRefusal, type StudioExportDestination, type StudioLocalExportEvent, type StudioLocalStatus } from '@/lib/tauri-bridge';

/** What this computer can do for an export. */
export type LocalCapability =
  | { kind: 'browser' }
  | { kind: 'unavailable'; reason: string; saveParts: boolean }
  | { kind: 'prepare'; bytes: number; downloading: boolean }
  | { kind: 'ready'; platform: 'macos' | 'windows' | 'other'; encoder?: string };

export const LOCAL_WORDS = {
  oldApp: 'This computer’s Native Intelligence app is older than the Studio, so this video exports on our server. Update the app to export on this computer.',
  otherVersion: 'This computer’s app is a different version from the Studio, so this video exports on our server.',
  codeScenes: 'This video uses code scenes, which only our server makes, so it exports there.',
  unsupported: 'This computer can’t make videos, so this video exports on our server.',
  failedStart: 'This computer could not start the export, so it runs on our server instead.',
  stalled: 'This computer stopped working on the export: it may have slept, or the app was quit.',
  elsewhere: 'It runs in the Native Intelligence app on the computer that started it, and is saved there.',
  onServerNow: 'It runs on our server instead.',
  unknownPlace: 'The app no longer knows where this file is.',
  needsPlace: 'The export waits on this computer until you choose where to save it. Continue it from here.',
  uploadFailed: 'It could not be uploaded for sharing.',
  saveFailed: 'The video was made, but it could not be saved where you chose.',
} as const;

/** Whether an error is a desktop command this build does not have (or may not call). */
export function isMissingCommand(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return /not found|unknown command|not allowed|unavailable/i.test(text);
}

const platformOf = (raw: string | undefined): 'macos' | 'windows' | 'other' => /mac|darwin/i.test(raw ?? '') ? 'macos' : /win/i.test(raw ?? '') ? 'windows' : 'other';

/** What a status answer (or its absence) means, before the video is looked at. */
export function capabilityOf(status: StudioLocalStatus | 'missing' | 'browser'): LocalCapability {
  if (status === 'browser') return { kind: 'browser' };
  if (status === 'missing') return { kind: 'unavailable', reason: LOCAL_WORDS.oldApp, saveParts: false };
  if (!status.available) return { kind: 'unavailable', reason: status.reason?.trim() || LOCAL_WORDS.unsupported, saveParts: true };
  if (status.renderVersion !== STUDIO_RENDER_VERSION) return { kind: 'unavailable', reason: LOCAL_WORDS.otherVersion, saveParts: true };
  const states = Object.values(status.components ?? {});
  if (states.some(state => state !== 'ready')) return { kind: 'prepare', bytes: Math.max(0, status.downloadBytes || 0), downloading: states.some(state => state === 'downloading') };
  return { kind: 'ready', platform: platformOf(status.platform), ...(status.encoder ? { encoder: status.encoder } : {}) };
}

/** Whether an edit plays code scenes, which only the server makes (the server's own check: lib/studio/server/media.ts playsCodeScenes). */
export function playsCodeScenes(project: EditorProject): boolean {
  return ((project as { layers?: unknown[] }).layers ?? []).some(layer => {
    const scene = (layer as { style?: { scene?: { id?: unknown } } }).style?.scene;
    return !!scene && typeof scene.id === 'string';
  });
}

/** The capability for this video: one with code scenes exports on the server whatever the computer can do. */
export function capabilityFor(capability: LocalCapability, project: EditorProject): LocalCapability {
  if ((capability.kind === 'ready' || capability.kind === 'prepare') && playsCodeScenes(project)) return { kind: 'unavailable', reason: LOCAL_WORDS.codeScenes, saveParts: true };
  return capability;
}

/** Can a server export be saved through the app's own save (any size): its status command answered. */
export const savesParts = (capability: LocalCapability) => capability.kind === 'ready' || capability.kind === 'prepare' || (capability.kind === 'unavailable' && capability.saveParts);

export type LocalBridge = {
  status: () => Promise<StudioLocalStatus>;
  start: (args: { jobId: string; token: string; destinationId: string; upload: boolean }) => Promise<void>;
  cancel: (jobId: string) => Promise<void>;
  pickDestination: (suggestedName: string) => Promise<StudioExportDestination | null>;
};

/** Ask the app what it can do. Never throws: a browser, a build without the command, or one that fails, says so. */
export async function readLocalCapability(bridge: Pick<LocalBridge, 'status'> | null): Promise<LocalCapability> {
  if (!bridge) return capabilityOf('browser');
  try { return capabilityOf(await bridge.status()); }
  catch (error) { return isMissingCommand(error) ? capabilityOf('missing') : { kind: 'unavailable', reason: LOCAL_WORDS.unsupported, saveParts: false }; }
}

/** Where each export on this computer is saved, by job (its destination's id and file name), kept on this device. */
const DESTINATIONS_KEY = 'ni:studio:local-export-destinations';
export function rememberDestination(jobId: string, destination: StudioExportDestination): void {
  try { const all = JSON.parse(localStorage.getItem(DESTINATIONS_KEY) ?? '{}') as Record<string, StudioExportDestination>; all[jobId] = destination;
    localStorage.setItem(DESTINATIONS_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-50)))); } catch { /* a name not shown later */ }
}
export function destinationOf(jobId: string): StudioExportDestination | null {
  try { const found = (JSON.parse(localStorage.getItem(DESTINATIONS_KEY) ?? '{}') as Record<string, StudioExportDestination>)[jobId]; return found && typeof found.destinationId === 'string' && typeof found.name === 'string' ? found : null; } catch { return null; }
}

/**
 * Exports whose video was saved again after `save-failed` (studio_local_export_save_again), this page: the app's events
 * still end with `save-failed`, so the dialog reads them as saved with this name (asSavedAgain).
 */
const savedAgain = new Map<string, string>();
/** Does this app have studio_local_export_save_again? Asked with no job (the app refuses it as a bad request, touching nothing). */
export async function canSaveAgain(bridge: { saveAgain: (args: { jobId: string; destinationId: string }) => Promise<unknown> }): Promise<boolean> {
  try { await bridge.saveAgain({ jobId: '', destinationId: '' }); return true; } catch (error) { return !isMissingCommand(error); }
}
export function markSavedAgain(jobId: string, name: string): void { savedAgain.set(jobId, name); }
/** The app's events for `jobId`, as saved when it was saved again here. */
export function asSavedAgain(jobId: string, runner: RunnerState): RunnerState {
  const name = savedAgain.get(jobId);
  return name !== undefined && runner.saveFailed !== null ? { ...runner, done: true, saveFailed: null, savedName: name } : runner;
}

type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Started = { job: EditorJob; notice?: string };
const codeOf = (error: unknown) => (error as { code?: string } | null)?.code;

/** A place the app no longer takes (used once already, or forgotten with the app's last run): ask where to save again. */
const asksAgain = (error: unknown) => { const code = studioRefusal(error).code; return code === 'used' || code === 'unknown-destination'; };
/** Open the save panel (the name suggested); null when the person closes it. */
export type PickPlace = (suggestedName: string) => Promise<StudioExportDestination | null>;

/**
 * Hand job `jobId` to the app with `token`, saved at `destination`. A place the app no longer takes (`used`,
 * `unknown-destination`) opens the save panel again, suggesting the same name, and starts with the new one. Answers the
 * place it started with, or null when the person closed the panel (the export then waits for this computer).
 */
async function startWith(jobId: string, token: string, destination: StudioExportDestination, deps: { bridge: Pick<LocalBridge, 'start'>; pick: PickPlace }, upload: boolean): Promise<StudioExportDestination | null> {
  try { await deps.bridge.start({ jobId, token, destinationId: destination.destinationId, upload }); return destination; }
  catch (error) {
    if (!asksAgain(error)) throw error;
    const again = await deps.pick(destination.name);
    if (!again) return null;
    await deps.bridge.start({ jobId, token, destinationId: again.destinationId, upload });
    return again;
  }
}

/**
 * Export `project` on this computer, saved at `destination`, uploaded for sharing unless `upload` is false. A video the
 * server refuses for the computer (another render version, code scenes), or an app that cannot start the job, is
 * exported on the server instead; `notice` then says why. A place the app no longer takes asks where to save again
 * (startWith), never the server: a closed panel leaves the export waiting for this computer, saying so. Throws what
 * the server said for anything else (too many).
 */
export async function startOnComputer(project: EditorProject, destination: StudioExportDestination, deps: { request: Request; bridge: Pick<LocalBridge, 'start'>; pick: PickPlace }, upload = true): Promise<Started> {
  let queued: { job: EditorJob; local?: { token: string } };
  try { queued = await deps.request('/api/account/studio/export', { project, where: 'computer', renderVersion: STUDIO_RENDER_VERSION }); }
  catch (error) {
    const code = codeOf(error);
    if (code !== 'RENDER_VERSION' && code !== 'CODE_SCENES') throw error;
    const server = await deps.request<{ job: EditorJob }>('/api/account/studio/export', { project });
    return { job: server.job, notice: error instanceof Error && error.message ? error.message : code === 'CODE_SCENES' ? LOCAL_WORDS.codeScenes : LOCAL_WORDS.otherVersion };
  }
  // Remembered first: an export waiting for a place is still this computer's (Continue asks for one).
  rememberDestination(queued.job.id, destination);
  try {
    if (!queued.local?.token) throw new Error('no token');
    const started = await startWith(queued.job.id, queued.local.token, destination, deps, upload);
    if (!started) return { job: queued.job, notice: LOCAL_WORDS.needsPlace };
    if (started !== destination) rememberDestination(queued.job.id, started);
    return { job: queued.job };
  } catch (error) {
    // The app's own sentence when it said why (busy, updating, its encoder missing), else ours.
    const moved = await finishOnServer(queued.job.id, deps.request), said = studioRefusal(error);
    return { job: moved.job, notice: said.code && said.message ? `${said.message} ${LOCAL_WORDS.onServerNow}` : LOCAL_WORDS.failedStart };
  }
}

/**
 * "Continue on this computer": a new token for the job, handed to the app with where it was to be saved; a place the
 * app no longer knows (it was quit since), or none remembered, opens the save panel first. 'cancelled' when the person
 * closed it (the export keeps waiting). Throws the app's or the server's refusal.
 */
export async function continueOnComputer(jobId: string, suggestedName: string, deps: { request: Request; bridge: Pick<LocalBridge, 'start'>; pick: PickPlace }, upload = true): Promise<'started' | 'cancelled'> {
  let destination = destinationOf(jobId);
  if (!destination) {
    destination = await deps.pick(suggestedName);
    if (!destination) return 'cancelled';
  }
  const { token } = await deps.request<{ token: string }>(`/api/account/studio/jobs/${encodeURIComponent(jobId)}/local-token`, {});
  const started = await startWith(jobId, token, destination, deps, upload);
  if (!started) return 'cancelled';
  rememberDestination(jobId, started);
  return 'started';
}

/**
 * "Finish on the server": the export moves to our server, queued or still running on a computer (that computer is
 * refused at its next call and stops). Answers the job to follow: the server's new one (`moved`), after which the app
 * here is told to stop the old one at once (a failure, or an app without the command, is left to the server's refusal).
 * When the export ended meanwhile (409 ENDED: it most likely finished), the old job read again, to show how it ended.
 * Throws anything else the server said.
 */
export async function finishOnServer(jobId: string, request: Request, bridge?: Pick<LocalBridge, 'cancel'>): Promise<{ job: EditorJob; moved: boolean }> {
  try {
    const { job } = await request<{ job: EditorJob; replaces: string }>(`/api/account/studio/jobs/${encodeURIComponent(jobId)}/to-server`, {});
    if (bridge) { try { await bridge.cancel(jobId); } catch { /* the server refuses it at its next call */ } }
    return { job, moved: true };
  } catch (error) {
    if (codeOf(error) !== 'ENDED') throw error;
    return { job: (await request<{ job: EditorJob }>(`/api/account/studio/jobs/${encodeURIComponent(jobId)}`)).job, moved: false };
  }
}

/** How long an export on this computer may go without a word from the app before the dialog offers to carry it on. */
export const STALL_MS = 30_000;

/** What the app has said about one export (its events folded). */
export type RunnerState = {
  seq: number; lastAt: number | null; progress: number | null; savedName: string | null; failed: string | null; cancelled: boolean;
  /** The file is saved on this computer. */
  done: boolean;
  /** After `done`: uploaded for sharing, or the upload failed (the app's sentence). */
  uploaded: boolean; uploadFailed: string | null;
  /** The video was made but could not be put where the person chose (the app's sentence): kept by the app, to be saved again. */
  saveFailed: string | null;
};
export const emptyRunner = (): RunnerState => ({ seq: -1, lastAt: null, progress: null, savedName: null, failed: null, cancelled: false, done: false, uploaded: false, uploadFailed: null, saveFailed: null });
/**
 * Fold the app's events into what it has said, in order, each once. `started` begins a run: what the app said of an
 * earlier run of the job is dropped (the seq stays). Once the file is saved (`done`) it stays saved: only progress,
 * logs and the upload's outcome count after it, never a failure or a stop. `save-failed` (made, but not put where the
 * person chose) ends a run the same way.
 */
export function foldEvents(state: RunnerState, events: readonly StudioLocalExportEvent[], at: number): RunnerState {
  let next = state;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq <= next.seq) continue;
    next = { ...next, seq: event.seq, lastAt: at };
    if (event.kind === 'started') { next = { ...emptyRunner(), seq: event.seq, lastAt: at }; continue; }
    // Made: saved where the person chose, or not (save-failed). Either way the run is over but for its upload.
    const made = next.done || next.saveFailed !== null;
    if (event.kind === 'progress' && typeof event.progress === 'number' && !made) next.progress = Math.max(0, Math.min(1, event.progress));
    // `done` also follows `save-failed` when the person saved the kept video again: then it is saved.
    if (event.kind === 'done' && (!made || next.saveFailed !== null)) next = { ...next, done: true, saveFailed: null, progress: 1, savedName: event.savedName ?? next.savedName };
    if (event.kind === 'save-failed' && !made) next = { ...next, saveFailed: event.message?.trim() || LOCAL_WORDS.saveFailed, progress: 1 };
    if (event.kind === 'uploaded' && made) next.uploaded = true;
    if (event.kind === 'upload-failed' && made) next.uploadFailed = event.message?.trim() || LOCAL_WORDS.uploadFailed;
    if (next.done || next.saveFailed !== null) continue;
    if (event.kind === 'failed') next.failed = event.message?.trim() || 'The export failed on this computer.';
    if (event.kind === 'cancelled') next.cancelled = true;
  }
  return next;
}

/** What the dialog shows of an export on this computer. */
export type LocalView =
  | { kind: 'rendering'; progress: number; waiting: boolean }
  | { kind: 'stalled'; progress: number }
  /** Running on another computer: this device did not start it and its app has said nothing of it. */
  | { kind: 'elsewhere'; progress: number }
  | { kind: 'uploading'; savedName: string | null }
  /**
   * Saved here; uploaded for sharing, or not (`note`: why not, the app's or the server's sentence, in small text).
   * `notHere`: made, but not saved on this computer (save-failed) while the upload went through: saved from the Studio.
   */
  | { kind: 'done'; savedName: string | null; uploaded: boolean; note?: string; notHere?: true }
  /** Made, but it could not be put where the person chose (the app's sentence): the app keeps it to be saved again. */
  | { kind: 'save-failed'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

/**
 * The view, from the job (the server's word: it ends the export) and the app's events (since the dialog opened at
 * `openedAt`). The job decides done, failed and stopped; while it runs, the app's events decide rendering, saved and
 * uploading, or stalled (no word from the app for STALL_MS: asleep, quit, never started). An export this device did
 * not start (`startedHere` false: it has no destination for it) and whose app here has said nothing runs on another
 * computer: no stall is read for it, this device cannot know. A word from the app here always wins.
 */
export function localView(job: EditorJob, runner: RunnerState, openedAt: number, now: number, savedName: string | null = null, startedHere = true): LocalView {
  const name = runner.savedName ?? savedName;
  if (runner.saveFailed !== null) {
    // The upload went through: the person saves it from the Studio, the app's sentence beside it.
    if (job.status === 'completed' && job.downloadUrl && job.kept !== 'computer') return { kind: 'done', savedName: null, uploaded: true, note: runner.saveFailed, notHere: true };
    return { kind: 'save-failed', message: runner.saveFailed };
  }
  if (job.status === 'completed') return { kind: 'done', savedName: name, uploaded: job.kept !== 'computer' && !!job.downloadUrl };
  // Saved on this computer: saved, whatever became of the upload (never "did not finish").
  if (runner.done && runner.uploadFailed) return { kind: 'done', savedName: name, uploaded: false, note: runner.uploadFailed };
  if (runner.done && job.status !== 'running') return { kind: 'done', savedName: name, uploaded: false, ...(job.error ? { note: job.error } : {}) };
  if (job.status === 'failed') return { kind: 'failed', message: job.error?.trim() || runner.failed || 'The export failed on this computer.' };
  if (job.status === 'cancelled') return { kind: 'cancelled' };
  if (runner.failed) return { kind: 'failed', message: runner.failed };
  if (runner.cancelled) return { kind: 'cancelled' };
  if (runner.done) return { kind: 'uploading', savedName: name };
  const progress = Math.max(job.progress || 0, runner.progress ?? 0);
  if (!startedHere && runner.lastAt === null) return { kind: 'elsewhere', progress };
  if (now - (runner.lastAt ?? openedAt) > STALL_MS) return { kind: 'stalled', progress };
  return { kind: 'rendering', progress, waiting: runner.lastAt === null && progress === 0 };
}

/** "Show in Finder" or "Show in Explorer". */
export const revealLabel = (platform: 'macos' | 'windows' | 'other') => platform === 'windows' ? 'Show in Explorer' : platform === 'macos' ? 'Show in Finder' : 'Show the file';

/** Bytes as a person reads them: "412 MB", "1.2 GB". */
export function sizeWords(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
