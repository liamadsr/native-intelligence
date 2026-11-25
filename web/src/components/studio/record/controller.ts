// The Studio's takes, for the whole page load: the recorder (the Mac app's or the browser's), the take recording now,
// its pieces going up while it records, and its saving and filing after Stop. It used to live in the Studio card's
// own state (ui/useManualRecording.ts), so leaving the Studio ended the take; now it lives here, one per page load, and
// the person uses the whole app while a take records (Stop is the floating control's, or the browser's own bar). The
// Studio card reads it while it is open (useManualRecording binds to it) and finds a running take as it was.
//
// When no Studio is on screen to show what happens, the notices go to the app's shell (lib/studio/recording-bus.ts):
// "Recording saved · Open in Studio", or what needs attention. Never while a take records (a display take would have
// the notice in its picture): they wait until it stops.
//
// A take belongs to the workspace it started in (workspace-pin.ts). Signing out forgets everything here (reset).
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { registerRecordingGuard, postRecordingNotice } from '@/lib/studio/recording-bus'
import { answerHellos, dropHandoff, sendContent, writeHandoff, type PrompterHandoff } from '@/lib/studio/prompter/channel'
import { openRecorder, listBrowserDevices, unlockDeviceLabels, uploadTake, submitTake, recordingRequest, plainError, listSavedTakes, discardSavedTake, recoverSavedTake, type BrowserRecorder, type DesktopRecorder, type DeviceOption, type EndReason, type FinishedTake, type LiveTrackStatus, type Recorder, type RecorderPermissionName, type RecorderPermissions, type RecorderTargets, type SavedTake, type ScreenChoice, type SharedSurface, type TakePlacement, type UploadProgress } from '.'
import { nativeDraftStore, provisionalRecord, type Draft, type DraftBridge, type DraftStore, type FilingState } from './provisional'
import { Filer, localTracks, settleRecording, type FilingApi, type Settled } from './filing'
import { inUseReason, keptFor, listedTakes, localTakeActions, localTakeRows, takeOverFromSession, takesInFlight, type LocalTakeRow } from './local-takes'
import { normalizeStop, takesBeingSent } from './desktop'
import type { TakeLiveInfo, TakeWord } from './types'
import { checkWorkspace, pinWorkspace, unpinWorkspace, WorkspaceMovedError } from './workspace-pin'
import { request } from '../ui/client'

/** One take in this page load, from Start until it is a video (or failed). Shaped like the session the editor's follow-ups read. */
export type RecordingSession = { id: string; status: 'preparing' | 'countdown' | 'recording' | 'finalizing' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; createdAt: string;
  camera: boolean; microphone: boolean; countdownRemaining?: number; elapsedMs: number; level?: number | null; note?: string; error?: string; step?: string;
  /** While it is prepared on the Studio (after the upload): how far along, 0 to 1. */
  progress?: number;
  punch?: { projectId: string; fromFrame: number; toFrame: number; beatIds?: string[] }; projectId?: string; screenAssetId?: string; voiceAssetId?: string; partialAssetId?: string;
  /** The take is kept on this device after a failed upload: Try again sends it again. */
  retry?: boolean;
  /** The Mac app: the take opened in the editor at Stop from the files on the computer (provisional.ts), filed meanwhile. */
  draft?: Draft };
/** What Start records. */
export type RecordingStart = { screen: ScreenChoice; cameraId: string | null | false; microphoneId: string | null | false; systemAudio: boolean; countdownSeconds?: number; placement: TakePlacement; title?: string };
export type RecorderState = { state: 'checking' } | { state: 'unavailable'; reason: string } | { state: 'desktop' } | { state: 'browser'; desktopShell: boolean };
/** A teleprompter mark, ms after the screen started: the line it moved to, or a retake of it. */
export type PrompterMark = { ms: number; beat?: number; retake?: number };

export const manualSessionActive = (session: RecordingSession | null | undefined) => !!session && ['preparing', 'countdown', 'recording', 'finalizing'].includes(session.status);
const recordingNow = (session: RecordingSession) => session.status === 'countdown' || session.status === 'recording';
const message = (error: unknown) => error instanceof WorkspaceMovedError ? error.message : plainError(error);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Everything the Studio card reads (one snapshot per change). */
export type RecordingSnapshot = {
  recorderState: RecorderState; takeLive: TakeLiveInfo | null; targets: RecorderTargets | null; permissions: RecorderPermissions | null;
  browserDevices: { cameras: DeviceOption[]; microphones: DeviceOption[] } | null; share: SharedSurface | null; sessions: RecordingSession[]; selectedId: string | null;
  loadingTargets: boolean; working: boolean; error: string | null; uploads: UploadProgress[]; liveTracks: LiveTrackStatus[]; savedTakes: SavedTake[];
  filing: Record<string, FilingState>; filed: string[]; drafts: DraftStore | null; heard: Record<string, TakeWord[]>; openElsewhere: string[];
  localTakes: LocalTakeRow[]; localBusy: string[];
};
const INITIAL: RecordingSnapshot = { recorderState: { state: 'checking' }, takeLive: null, targets: null, permissions: null, browserDevices: null, share: null, sessions: [], selectedId: null,
  loadingTargets: false, working: false, error: null, uploads: [], liveTracks: [], savedTakes: [], filing: {}, filed: [], drafts: null, heard: {}, openElsewhere: [], localTakes: [], localBusy: [] };

type Say = (text: string, error?: boolean) => void;
type Hooks = { opener?: typeof openRecorder; win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null };

export class RecordingController {
  private snap: RecordingSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  /** A new run after reset: work started by an earlier one changes nothing. */
  private run = 0;
  private opening: Promise<void> | null = null;
  private recorder: Recorder | null = null;
  private filer: Filer | null = null;
  private operation = false;
  private current: string | null = null;
  pending: { id: string; take: FinishedTake; placement: TakePlacement; title?: string } | null = null;
  private inFlight = takesInFlight();
  private take: { placement: TakePlacement; title?: string } | null = null;
  private cleanups: (() => void)[] = [];
  private marks: PrompterMark[] = [];
  private screenStart: number | null = null;
  private countdownCancel: (() => void) | null = null;
  private ended: (reason: EndReason) => void = () => {};
  /** The Studio card, while one is on screen: says what happens (else the shell's notices do). */
  private says = new Set<Say>();
  private held: { text: string; error: boolean }[] = [];
  /** Takes whose end was already said (by the Studio or the shell): never said twice. */
  readonly claimed = new Set<string>();
  /** The editor's Try again on a filed take whose edit is not on the video yet (App.tsx retryAdopt). */
  readonly adoptWith: { current: ((projectId: string) => Promise<void>) | null } = { current: null };
  /** The video ids of takes the editor has open (App.tsx): never listed, never discarded under it. */
  readonly inUseWith: { current: () => ReadonlySet<string> } = { current: () => new Set() };
  private localActions: ReturnType<typeof localTakeActions>;
  private beforeUnloadOn = false;
  /** The take's script and checklist, handed to the floating control (and answered for while the take records). */
  private handoff: PrompterHandoff | null = null;
  private handoffOff: (() => void) | null = null;
  private readonly api: FilingApi = { get: <T,>(url: string) => { checkWorkspace(); return request<T>(url); }, post: <T,>(url: string, body?: unknown) => { checkWorkspace(); return request<T>(url, body ?? {}); } };

  constructor(private readonly hooks: Hooks = {}) {
    this.localActions = this.makeLocalActions();
    registerRecordingGuard({ busy: () => this.busy(), stopAndSettle: (ms) => this.stopAndSettle(ms), reset: () => this.reset() });
  }

  // ---- the snapshot ----------------------------------------------------------------------------------------------

  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };
  getSnapshot = () => this.snap;
  private set(change: Partial<RecordingSnapshot> | ((s: RecordingSnapshot) => Partial<RecordingSnapshot>)) {
    const patch = typeof change === 'function' ? change(this.snap) : change;
    this.snap = { ...this.snap, ...patch };
    this.afterChange();
    for (const cb of [...this.listeners]) cb();
  }
  private patch = (id: string, change: Partial<RecordingSession>) => { this.set(s => ({ sessions: s.sessions.map(item => item.id === id ? { ...item, ...change } : item) })); };
  get active() { return this.snap.sessions.find(manualSessionActive) ?? null; }
  /** A take recording, or its files still going to the Studio. */
  busy() { return !!this.active; }

  /** After every change: the page's leave guard, notices waiting for the take to stop, takes ended with nobody watching. */
  private afterChange() {
    const busy = this.busy(), win = this.window();
    if (win && busy !== this.beforeUnloadOn) {
      this.beforeUnloadOn = busy;
      if (busy) win.addEventListener('beforeunload', this.beforeUnload); else win.removeEventListener('beforeunload', this.beforeUnload);
    }
    if (!this.snap.sessions.some(recordingNow) && this.held.length) { const held = this.held; this.held = []; for (const n of held) this.notify(n.text, n.error); }
    if (!this.says.size) this.announceEnded();
    if (!busy && !this.pending) unpinWorkspace();
  }
  private beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
  private window() { return this.hooks.win === undefined ? (typeof window === 'undefined' ? null : window) : this.hooks.win; }

  // ---- what is said ----------------------------------------------------------------------------------------------

  /** The Studio card is on screen: it says what happens. Returns the function that lets go. */
  attach = (say: Say) => { this.says.add(say); void this.open(); return () => { this.says.delete(say); }; };
  /** A sentence about a take: to the Studio when it is on screen, else to the shell, never while a take records. */
  notify = (text: string, error = false) => {
    if (this.says.size) { for (const say of this.says) say(text, error); return; }
    if (this.snap.sessions.some(recordingNow)) { this.held.push({ text, error }); return; }
    postRecordingNotice({ id: `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`, text, tone: error ? 'error' : 'ok' });
  };
  /** Takes that ended with no Studio on screen: "Recording saved · Open in Studio", or what needs attention. */
  private announceEnded() {
    if (this.snap.sessions.some(recordingNow)) return;
    for (const session of this.snap.sessions) {
      if (this.claimed.has(session.id)) continue;
      // A Mac take opened as a draft is said once it is filed (onFiled), when there is a video to open.
      if (session.status === 'completed' && session.projectId && !session.draft) { this.claimed.add(session.id); postRecordingNotice({ id: session.id, text: session.punch ? 'Your take is saved.' : 'Recording saved', tone: 'ok', videoId: session.projectId }); }
      else if (session.status === 'failed') { this.claimed.add(session.id); postRecordingNotice({ id: session.id, text: session.error ?? 'Recording needs attention. Open the Studio to see it.', tone: 'error' }); }
    }
  }

  // ---- the prompter's handoff -------------------------------------------------------------------------------------

  /** The script and checklist of the take recording now, for the floating control. */
  handOff = (handoff: PrompterHandoff) => {
    if (!this.snap.takeLive || this.snap.takeLive.sessionId !== handoff.sessionId) return;
    this.handoff = handoff;
    writeHandoff(handoff);
    void sendContent(handoff);
    this.handoffOff ??= answerHellos(handoff.sessionId, () => this.handoff);
  };
  /** The take ended: its copy for the control goes. */
  private endHandoff() {
    this.handoffOff?.(); this.handoffOff = null;
    if (this.handoff) dropHandoff(this.handoff.sessionId);
    this.handoff = null;
  }

  // ---- the recorder ----------------------------------------------------------------------------------------------

  /** Find the recorder once per run (the Studio card, or the shell on a Mac with takes left to send). */
  open(): Promise<void> {
    if (this.opening) return this.opening;
    const run = this.run;
    const live = () => run === this.run;
    this.opening = (async () => {
      try {
        const opened = await (this.hooks.opener ?? openRecorder)();
        if (!live()) { if (opened.kind !== 'unavailable') opened.recorder.dispose(); return; }
        if (opened.kind === 'unavailable') { this.set({ recorderState: { state: 'unavailable', reason: opened.reason } }); return; }
        this.recorder = opened.recorder;
        if (opened.kind === 'browser') {
          this.set({ recorderState: { state: 'browser', desktopShell: opened.desktopShell } });
          opened.recorder.onShareChange(value => { if (live()) this.set({ share: value }); });
          if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
            const changed = () => { void this.refreshTargets(); };
            navigator.mediaDevices.addEventListener('devicechange', changed);
            this.cleanups.push(() => navigator.mediaDevices.removeEventListener('devicechange', changed));
          }
        } else {
          const desktop = opened.recorder as DesktopRecorder; const store = nativeDraftStore(desktop.app as unknown as DraftBridge);
          this.filer = new Filer({ store, api: this.api, native: desktop.app, leases: desktop.leases, sleep, alive: live,
            uploadTake: (take, whole, onFraction) => { if (whole) for (const file of take.files) { delete file.uploadKey; delete file.pieces; file.whole = true; } return uploadTake(desktop, take, files => { const total = files.reduce((n, f) => n + f.bytes, 0) || 1; onFraction(files.reduce((n, f) => n + f.bytes * f.fraction, 0) / total); }); },
            sendUnfinished: () => desktop.sendUnfinished(),
            onState: (projectId, next) => { if (live()) this.set(s => { const copy = { ...s.filing }; if (next) copy[projectId] = next; else delete copy[projectId]; return { filing: copy }; }); },
            onFiled: (projectId) => { if (!live()) return; this.markFiled(projectId); if (!this.says.size) postRecordingNotice({ id: `filed:${projectId}`, text: 'Recording saved', tone: 'ok', videoId: projectId }); },
            onWords: (projectId, words) => { if (live()) this.set(s => ({ heard: { ...s.heard, [projectId]: words } })); },
            onKept: (_projectId, note) => this.notify(note, true), onWordsDropped: (_projectId, note) => this.notify(note, true) });
          // The words the Mac heard arrive after Stop: each take's filing takes them in.
          const words = (desktop.app as { onWords?: (cb: (event: { sessionId: string; transcript: unknown }) => void) => Promise<() => void> | (() => void) }).onWords;
          if (typeof words === 'function') void Promise.resolve(words(event => { void this.filer?.wordsEvent(event); })).then(off => { if (!live()) off(); else this.cleanups.push(off); }).catch(() => undefined);
          // The page goes (a reload, a closed window): its holds go at once, so the next page or another window takes over.
          const win = this.window();
          if (win) { const leave = () => desktop.leases.releaseAll(); win.addEventListener('pagehide', leave); this.cleanups.push(() => win.removeEventListener('pagehide', leave)); }
          this.set({ drafts: store, recorderState: { state: 'desktop' } });
        }
        void this.refreshTargets();
        await this.refreshSavedTakes();
        if (opened.kind === 'desktop') await this.resumeDrafts(live);
      } catch (cause) { if (live()) this.set({ recorderState: { state: 'unavailable', reason: message(cause) } }); }
    })();
    return this.opening;
  }

  /**
   * The Mac app: drafts found again (a reload, a restart) are taken back by this page when no other window holds them,
   * then what a quit or a crash kept from going up is sent (their last pieces first, also those of the drafts this page
   * now holds), and each draft's filing goes on; then the takes are offered back.
   */
  private async resumeDrafts(live: () => boolean) {
    const drafts = this.snap.drafts, filing = this.filer, desktop = this.recorder as DesktopRecorder;
    if (!drafts || !filing) return;
    const records = await drafts.list().catch(() => []);
    const elsewhere: string[] = [];
    for (const record of records) if (!(await desktop.leases.hold(record.sessionId))) elsewhere.push(record.projectId);
    if (!live()) return;
    this.set({ openElsewhere: elsewhere });
    const sent = await desktop.sendUnfinished().catch(() => 0);
    if (sent && live()) void this.refreshSavedTakes();
    for (const record of records) if (!elsewhere.includes(record.projectId) && live()) await filing.resume(record);
    if (live()) void this.refreshLocalTakes();
  }

  refreshTargets = async () => {
    const rec = this.recorder;
    if (!rec) return;
    this.set({ loadingTargets: true });
    try {
      if (rec.kind === 'desktop') { const desktop = rec as DesktopRecorder; const [found, allowed] = await Promise.all([desktop.targets(), desktop.permissions().catch(() => null)]); if (this.recorder !== rec) return; this.set({ targets: found, permissions: allowed }); }
      else { const found = await listBrowserDevices(); if (this.recorder === rec) this.set({ browserDevices: found }); }
      if (this.recorder === rec) this.set({ error: null });
    } catch (cause) { if (this.recorder === rec) this.set({ error: message(cause) }); }
    finally { if (this.recorder === rec) this.set({ loadingTargets: false }); }
  };
  /** Desktop: check the five permissions again (after the person changed them in System Settings). */
  checkPermissions = async () => { const rec = this.recorder; if (rec?.kind !== 'desktop') return; try { this.set({ permissions: await (rec as DesktopRecorder).permissions() }); } catch (cause) { this.set({ error: message(cause) }); } };
  /** Desktop: ask macOS for the ones still missing (its prompts, or System Settings). */
  requestPermissions = async (which: RecorderPermissionName[]) => { const rec = this.recorder; if (rec?.kind !== 'desktop') return; this.set({ working: true }); try { const value = await (rec as DesktopRecorder).requestPermissions(which); this.set({ permissions: value });
      // Screen Recording is allowed in System Settings and only takes effect once the app restarts.
      if (which.includes('screenRecording') && value.screenRecording !== 'granted') this.set({ error: 'Allow Native Intelligence under Screen Recording in System Settings, then quit and reopen Native Intelligence: macOS applies it after a restart.' }); } catch (cause) { this.set({ error: message(cause) }); } finally { this.set({ working: false }); } };
  /** Browser: ask once for the camera/microphone so their names show in the lists. */
  unlockDevices = async (video: boolean, audio: boolean) => { const refused = await unlockDeviceLabels(video, audio); if (refused) this.set({ error: refused }); await this.refreshTargets(); };
  /** Browser: open the browser's own picker. Must be called straight from a click. */
  chooseShare = async (withSound: boolean) => { const rec = this.recorder; if (rec?.kind !== 'browser') return null; this.set({ error: null }); try { return await (rec as BrowserRecorder).chooseShare(withSound); } catch (cause) { this.set({ error: message(cause) }); return null; } };
  clearShare = () => { const rec = this.recorder; if (rec?.kind === 'browser') (rec as BrowserRecorder).clearShare(); };
  setSelectedId = (id: string | null) => this.set({ selectedId: id });

  private markFiled(projectId: string) { this.set(s => ({ filed: s.filed.includes(projectId) ? s.filed : [...s.filed, projectId] })); }
  /** Try filing a take again (after it failed): this run's take is sent again whole; another is brought back from the Studio. */
  refile = async (projectId: string) => { await this.filer?.refile(projectId); };
  /** The editor has carried on from the Studio's copies of a filed take. */
  adopted = (projectId: string) => this.set(s => ({ filed: s.filed.filter(item => item !== projectId) }));
  /** The editor has left a filed take's video: its files on this computer go once the Studio holds every byte of them. */
  releaseTake = async (projectId: string): Promise<Settled> => this.filer ? this.filer.release(projectId) : { safe: false };
  /** This run's key to the take files' scheme (the editor plays a draft's files with it; never stored). */
  takeKey = async (): Promise<string | null> => { const rec = this.recorder; if (rec?.kind !== 'desktop') return null; const fn = (rec as DesktopRecorder).app.takeToken as (() => Promise<string>) | undefined; try { return typeof fn === 'function' ? await fn() : null; } catch { return null; } };
  /** Words the editor has taken in. */
  wordsTaken = (projectId: string) => this.set(s => { const copy = { ...s.heard }; delete copy[projectId]; return { heard: copy }; });
  records = () => this.filer?.records ?? null;
  wordsSettled = (projectId: string, limitMs: number) => this.filer ? this.filer.wordsSettled(projectId, limitMs) : Promise.resolve(true);

  // ---- a take ----------------------------------------------------------------------------------------------------

  /** Upload a stopped take, have it made into a video, and say where it went. */
  private finish = async (id: string, take: FinishedTake, placement: TakePlacement, title?: string) => {
    const rec = this.recorder, run = this.run;
    if (!rec) return;
    const live = () => run === this.run;
    // The two paths split here. The Mac app's take that becomes a new video opens in the editor at once from the files
    // on the computer and is filed behind it (provisional.ts). Everything else waits for the Studio as before
    // ("Preparing your recording"): a browser take (also every take on Windows, which has no native recorder), a
    // punch-in or a take into beats (placed into a video the Studio changes), or a take whose files the computer
    // could not describe.
    const drafts = this.snap.drafts;
    if (rec.kind === 'desktop' && placement.kind === 'new') {
      const projectId = crypto.randomUUID(), named = title ?? `Recording · ${new Date().toLocaleString()}`;
      const draft = await (rec as DesktopRecorder).provisional(take, projectId, named).catch(() => null);
      const kept = draft && drafts && this.filer ? await drafts.put(provisionalRecord(draft, { sessionId: take.sessionId, takeId: take.liveTakeId ?? null, title: named, files: take.files, take })).then(() => true, () => false) : false;
      // Not kept beside the take (the disk refused it): the take waits for the Studio as before, nothing is lost.
      if (draft && kept && this.filer) {
        const filing = this.filer;
        // The take's id on the Studio, once it answered its start: what brings it back if the app quits before it is filed.
        if (!take.liveTakeId) void (rec as DesktopRecorder).liveTakeIdOf(take.sessionId).then(takeId => { if (takeId) void filing.records.update(projectId, r => ({ ...r, takeId })).catch(() => undefined); });
        this.patch(id, { status: 'completed', step: undefined, projectId, draft, ...(take.note ? { note: take.note } : {}) });
        this.set({ liveTracks: [] });
        try { checkWorkspace(); void filing.start(take, projectId, named); }
        catch (cause) { this.notify(message(cause), true); }
        return;
      }
    }
    this.pending = { id, take, placement, ...(title ? { title } : {}) };
    this.patch(id, { status: 'finalizing', step: 'Uploading', retry: false, error: undefined });
    await this.inFlight.during(take.sessionId, async () => { void this.refreshLocalTakes(); try {
      const keys = await uploadTake(rec, take, files => { if (live()) this.set({ uploads: files }); });
      this.set({ liveTracks: [] });
      this.patch(id, { step: 'Preparing your recording', ...(take.note ? { note: take.note } : {}) });
      const answer = await submitTake(recordingRequest(take, keys, placement, title), view => this.patch(id, { step: view.step, progress: view.progress, ...(view.note ? { note: view.note } : {}) }), live);
      if (answer.recording.status !== 'done') return;
      this.pending = null;
      // The Mac's files go only once the Studio holds every track as recorded (a track it lost is sent again first).
      let kept: Settled | null = null;
      if (rec.kind === 'desktop') { const desktop = rec as DesktopRecorder; kept = await settleRecording({ api: this.api, native: desktop.app, sleep }, answer.recording.id, take.sessionId); if (kept.safe) await rec.discard(take).catch(() => {}); else await desktop.forget(take).catch(() => {}); }
      else await rec.discard(take).catch(() => {});
      const view = kept?.view ?? answer.recording;
      const note = [view.note, kept && !kept.safe ? kept.note : undefined].filter(Boolean).join(' ');
      this.patch(id, { status: 'completed', step: undefined, ...(view.projectId ? { projectId: view.projectId } : {}), ...(view.screenAssetId ? { screenAssetId: view.screenAssetId } : {}), ...(view.voiceAssetId ? { voiceAssetId: view.voiceAssetId } : {}), ...(note ? { note } : {}),
        ...(view.placed === 'new' && placement.kind !== 'new' ? { punch: undefined } : {}) });
      this.set({ uploads: [] });
    } catch (cause) {
      const moved = cause instanceof WorkspaceMovedError;
      this.patch(id, { status: 'failed', step: undefined, retry: true, error: moved ? message(cause) : `The take is kept on this device, but it could not be saved: ${message(cause)}` });
    } });
  };

  /** The take stopped: collect its files and finish it. */
  private stopTake = async (id: string, reason?: EndReason) => {
    const rec = this.recorder, info = this.take;
    if (!rec || !info || this.current !== id) return;
    this.current = null;
    // Recording into beats: the teleprompter's marks so far say where each beat's part of the take is.
    const placement: TakePlacement = info.placement.kind === 'beats' ? { ...info.placement, marks: [...this.marks] } : info.placement, title = info.title;
    this.patch(id, { status: 'finalizing', step: 'Saving the recording', level: null, ...(reason?.kind === 'error' ? { note: reason.message } : {}) });
    this.endHandoff();
    this.set({ takeLive: null });
    let finished: FinishedTake;
    try { finished = await rec.stop(); }
    catch (cause) { this.patch(id, { status: 'failed', step: undefined, error: message(cause) }); return; }
    await this.finish(id, finished, placement, title);
  };

  start = async (options: RecordingStart): Promise<RecordingSession | null> => {
    await this.open();
    const rec = this.recorder;
    // One take at a time.
    if (!rec || this.operation || this.current || this.active) return null;
    this.operation = true; this.set({ working: true, error: null });
    const id = crypto.randomUUID(), punch = options.placement.kind === 'punch' ? { projectId: options.placement.projectId, fromFrame: options.placement.fromFrame, toFrame: options.placement.toFrame } : options.placement.kind === 'beats' ? { projectId: options.placement.projectId, fromFrame: 0, toFrame: 0, beatIds: options.placement.beatIds } : undefined;
    const session: RecordingSession = { id, status: 'preparing', createdAt: new Date().toISOString(), camera: options.cameraId !== false, microphone: options.microphoneId !== false, elapsedMs: 0, ...(punch ? { punch } : {}) };
    pinWorkspace();
    this.current = id; this.marks = []; this.screenStart = null;
    this.set(s => ({ sessions: [session, ...s.sessions].slice(0, 20), selectedId: id, liveTracks: [] }));
    try {
      await rec.prepare({ screen: options.screen, camera: options.cameraId === false ? null : { deviceId: options.cameraId }, microphone: options.microphoneId === false ? null : { deviceId: options.microphoneId }, systemAudio: options.systemAudio, hideCursor: true });
      this.set({ working: false });
      // The countdown: Cancel during it stops before anything is recorded.
      let cancelled = false; this.countdownCancel = () => { cancelled = true; };
      for (let left = Math.max(0, Math.min(10, options.countdownSeconds ?? 3)); left > 0 && !cancelled; left--) { this.patch(id, { status: 'countdown', countdownRemaining: left }); await sleep(1000); }
      this.countdownCancel = null;
      if (cancelled || this.current !== id) { await rec.cancel().catch(() => {}); this.patch(id, { status: 'cancelled' }); this.current = null; return null; }
      // Named in the person's own time zone (the server only knows UTC).
      this.take = { placement: options.placement, title: options.title ?? `Recording · ${new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}` };
      this.ended = reason => {
        if (this.current !== id) return;
        if (reason.kind === 'cancelled') { this.current = null; void rec.cancel().catch(() => {}); this.patch(id, { status: 'cancelled', level: null }); this.endHandoff(); this.set({ takeLive: null }); this.claimed.add(id); this.notify('Recording cancelled.'); return; }
        if (reason.kind !== 'error') this.notify(reason.kind === 'share-ended' ? 'Sharing ended, so the recording stopped.' : 'Recording stopped.');
        void this.stopTake(id, reason);
      };
      await rec.start({ onStatus: status => { if (this.current !== id) return; this.patch(id, { elapsedMs: status.elapsedMs, level: status.level }); if (status.tracks) this.set({ liveTracks: status.tracks }); }, onEnded: reason => this.ended(reason) });
      this.screenStart = performance.now();
      this.set({ takeLive: rec.liveInfo?.() ?? null });
      this.patch(id, { status: 'recording', countdownRemaining: undefined, elapsedMs: 0 });
      return { ...session, status: 'recording' };
    } catch (cause) {
      this.countdownCancel = null;
      if (this.current === id) this.current = null;
      await rec.cancel().catch(() => {});
      this.set(s => ({ error: message(cause), sessions: s.sessions.filter(item => item.id !== id) }));
      return null;
    } finally { this.operation = false; this.set({ working: false }); }
  };

  stop = async (id: string) => {
    const session = this.snap.sessions.find(item => item.id === id);
    if (!session || this.current !== id) return;
    if (session.status === 'countdown' || session.status === 'preparing') { this.countdownCancel?.(); return; }
    await this.stopTake(id);
  };
  cancel = async (id: string) => {
    const rec = this.recorder;
    if (this.current !== id) {
      // A failed take kept for Try again: throw it away. Only the take this page kept.
      const kept = keptFor(this.pending, id);
      if (kept && rec) { this.pending = null; await rec.discard(kept.take).catch(() => {}); this.claimed.add(id); this.patch(id, { status: 'cancelled', retry: false }); }
      return;
    }
    this.countdownCancel?.();
    this.current = null;
    try { await rec?.cancel(); } catch { /* already stopped */ }
    this.claimed.add(id);
    this.patch(id, { status: 'cancelled', level: null });
    this.endHandoff();
    this.set({ takeLive: null });
  };
  /** Send a kept take again after its upload or processing failed. */
  retry = async (id: string) => { const kept = keptFor(this.pending, id); if (!kept) return; this.claimed.delete(id); await this.finish(id, kept.take, kept.placement, kept.title); };
  /** Teleprompter: the line moved on (or is being retaken), noted on the screen file's clock. */
  mark = (value: { beat?: number; retake?: number }) => { const at = this.screenStart; if (at === null) return; this.marks = [...this.marks, { ms: Math.max(0, Math.round(performance.now() - at)), ...value }]; };
  refreshSessions = async () => { await this.refreshTargets(); void this.refreshLocalTakes(); };

  /** Stop the take recording now (if any) and wait until nothing is being saved, at most `timeoutMs`. */
  async stopAndSettle(timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    const active = this.active;
    if (active && this.current === active.id) {
      if (active.status === 'recording') void this.stop(active.id); else await this.cancel(active.id);
    }
    while (this.busy() && Date.now() < until) await sleep(200);
  }

  /** Forget everything: the recorder, every take, notices, what was said (another account may sign in next). */
  reset() {
    this.run++;
    this.countdownCancel?.();
    for (const off of this.cleanups.splice(0)) { try { off(); } catch { /* gone */ } }
    try { this.recorder?.dispose(); } catch { /* gone */ }
    this.recorder = null; this.filer = null; this.opening = null; this.operation = false; this.current = null; this.pending = null; this.take = null;
    this.marks = []; this.screenStart = null; this.held = []; this.claimed.clear();
    this.endHandoff();
    // Every copy left for the floating control, this take's or an older one's.
    dropHandoff(null);
    this.inFlight = takesInFlight();
    unpinWorkspace();
    this.set(INITIAL);
  }

  // ---- takes kept elsewhere ---------------------------------------------------------------------------------------

  /** The takes kept on the Studio after their window closed mid-take; never one this page is still recording or sending. */
  refreshSavedTakes = async () => { try { const takes = await listSavedTakes(); const drafts = this.snap.drafts; const records = drafts ? await drafts.list().catch(() => []) : []; const mine = new Set([...((this.recorder as { liveTakeIds?: () => string[] } | null)?.liveTakeIds?.() ?? []), ...records.flatMap(record => record.takeId ? [record.takeId] : [])]); this.set({ savedTakes: takes.filter(take => !mine.has(take.id)) }); } catch { /* an older server, or the Studio off: nothing to offer */ } };

  /** What this page is filing now, or has open in the editor (the editor says how it goes). */
  private busyHere() { return new Set([...Object.entries(this.snap.filing).filter(([, state]) => !state.failed).map(([id]) => id), ...this.inUseWith.current()]); }
  /** Takes kept on this computer that are not settled (local-takes.ts): listed in the Record dialog. */
  refreshLocalTakes = async () => {
    const rec = this.recorder, drafts = this.snap.drafts;
    if (rec?.kind !== 'desktop' || !drafts) return;
    const desktop = rec as DesktopRecorder, list = desktop.app.unfinishedTakes;
    if (typeof list !== 'function') return;
    try {
      // Not caught: without the records, a take's draft would read as lost.
      const [raw, records] = await Promise.all([list(desktop.leases.holder), drafts.list()]);
      // What this page is recording or sending on now is not listed, nor a take shown already as kept on the Studio.
      const recording = new Set([...(desktop.liveSessions?.() ?? []), ...takesBeingSent()]);
      const onStudio = new Set(this.snap.savedTakes.map(take => take.id));
      const owned = this.inFlight.ids();
      const rows = localTakeRows(listedTakes(raw).filter(take => !recording.has(take.sessionId)), records, this.busyHere(), sessionId => desktop.leases.holds(sessionId), owned);
      if (this.recorder === rec) this.set({ localTakes: rows.filter(row => !(row.action.kind === 'recover' && onStudio.has(row.action.takeId))) });
    } catch { /* an app without the list: nothing to show */ }
  };

  private makeLocalActions() {
    const desktop = () => this.recorder as DesktopRecorder;
    return localTakeActions({
      refile: async projectId => { await this.filer?.refile(projectId); },
      adopt: async projectId => { if (this.adoptWith.current) await this.adoptWith.current(projectId); else this.markFiled(projectId); },
      release: async (projectId, anyway) => this.filer ? this.filer.release(projectId, { anyway }) : { safe: false },
      recover: async takeId => {
        // Its last pieces first (and a take the Studio has every byte of goes by itself): only what is left is brought back.
        await desktop().sendUnfinished().catch(() => 0);
        const still = listedTakes(await desktop().app.unfinishedTakes?.(desktop().leases.holder).catch(() => null)).some(take => take.takeId === takeId);
        if (!still) { this.notify('This recording was settled with the Studio already, so nothing was left to bring back.'); return; }
        await this.recoverSaved(takeId);
      },
      fileWhole: async row => {
        const raw = (await desktop().app.unfinishedTakes?.(desktop().leases.holder)) as unknown;
        const stop = listedTakes(raw).find(take => take.sessionId === row.sessionId)?.stop;
        if (!stop) throw new Error('Its files could not be described.');
        // A new video from the files on this computer (a punch-in or beats take too: where it was meant to go is not kept).
        const id = crypto.randomUUID(), take = normalizeStop(row.sessionId, stop, row.at ? new Date(row.at) : new Date());
        this.set(s => ({ sessions: [{ id, status: 'finalizing', createdAt: row.at ?? new Date().toISOString(), camera: take.files.some(f => f.role === 'camera'), microphone: take.files.some(f => f.role === 'microphone'), elapsedMs: Math.round(take.durationSeconds * 1000), step: 'Uploading' } as RecordingSession, ...s.sessions].slice(0, 20) }));
        await this.finish(id, take, { kind: 'new' });
      },
      records: async () => (this.snap.drafts ? this.snap.drafts.list() : []),
      discard: async sessionId => { await desktop().app.discard(sessionId); },
      inUse: async sessionId => inUseReason(sessionId, { sending: new Set([...takesBeingSent(), ...(desktop().liveSessions?.() ?? []), ...this.inFlight.ids()]), records: await (this.snap.drafts?.list() ?? Promise.resolve([])), open: this.busyHere() }),
      holdTake: sessionId => desktop().leases.hold(sessionId),
      letGoTake: sessionId => desktop().leases.release(sessionId),
      holdsTake: sessionId => desktop().leases.holds(sessionId),
      inFlight: sessionId => this.inFlight.ids().has(sessionId),
      takeOver: sessionId => { const holder = { current: this.pending }; const id = takeOverFromSession(holder, sessionId); this.pending = holder.current; if (id) this.patch(id, { retry: false }); },
      notify: (text, error) => this.notify(text, error),
      refresh: () => void this.refreshLocalTakes(),
      onBusy: ids => this.set({ localBusy: ids }),
    });
  }
  /** Try again on a take kept on this computer: filed (or let go of, once the Studio holds every byte), from what it is. */
  retryLocal = async (row: LocalTakeRow, alt = false) => { if (this.recorder?.kind === 'desktop') await this.localActions.retry(row, alt); };
  /** Discard a take kept on this computer, for good (the person asked twice). */
  discardLocal = async (sessionId: string) => { if (this.recorder?.kind === 'desktop') await this.localActions.discard(sessionId); };
  /** Make a saved take a new video from what reached the Studio, followed like a finished take. */
  recoverSaved = async (takeId: string) => {
    const saved = this.snap.savedTakes.find(item => item.id === takeId);
    const id = crypto.randomUUID(), run = this.run;
    const session: RecordingSession = { id, status: 'finalizing', createdAt: saved?.createdAt ?? new Date().toISOString(), camera: !!saved?.tracks.some(track => track.role === 'camera'), microphone: !!saved?.tracks.some(track => track.role === 'microphone'), elapsedMs: Math.round((saved?.seconds ?? 0) * 1000), step: 'Bringing back your recording' };
    this.set(s => ({ sessions: [session, ...s.sessions].slice(0, 20), selectedId: id, savedTakes: s.savedTakes.filter(item => item.id !== takeId) }));
    try {
      // The Mac's hash of each file it still has: a track the Studio holds less of is then lost, and sent again whole.
      let sha256: Record<string, string> | undefined;
      const rec = this.recorder;
      if (rec?.kind === 'desktop') {
        const desktop = rec as DesktopRecorder;
        await desktop.sendUnfinished().catch(() => 0);
        const local = listedTakes(await desktop.app.unfinishedTakes?.(desktop.leases.holder).catch(() => null)).find(take => take.takeId === takeId);
        const tracks = local ? await localTracks(desktop.app, local.sessionId) : null;
        if (tracks?.length) sha256 = Object.fromEntries(tracks.map(t => [t.role === 'system-audio' ? 'systemAudio' : t.role, t.sha256]));
      }
      const answer = await recoverSavedTake(takeId, view => this.patch(id, { step: view.step, progress: view.progress, ...(view.note ? { note: view.note } : {}) }), () => run === this.run, undefined, sha256);
      if (answer.recording.status !== 'done') return;
      const view = answer.recording;
      this.patch(id, { status: 'completed', step: undefined, ...(view.projectId ? { projectId: view.projectId } : {}), ...(view.screenAssetId ? { screenAssetId: view.screenAssetId } : {}), ...(view.voiceAssetId ? { voiceAssetId: view.voiceAssetId } : {}), ...(view.note ? { note: view.note } : {}) });
    } catch (cause) { this.patch(id, { status: 'failed', step: undefined, error: message(cause) }); void this.refreshSavedTakes(); }
  };
  /** Throw a saved take away for good. */
  discardSaved = async (takeId: string) => { try { await discardSavedTake(takeId); this.set(s => ({ savedTakes: s.savedTakes.filter(item => item.id !== takeId) })); } catch (cause) { this.set({ error: message(cause) }); } };
  /** A partial take kept apart from a video does not exist with this recorder (a stopped take is always the whole take). */
  openPartial = async (id: string): Promise<EditorProject | null> => { void id; return null; };
}

let shared: RecordingController | null = null;
/** This page load's controller. */
export function recordingController(): RecordingController { return shared ??= new RecordingController(); }
/** Tests: a controller of their own, made the page's. */
export function replaceRecordingController(next: RecordingController | null): void { shared = next; }
