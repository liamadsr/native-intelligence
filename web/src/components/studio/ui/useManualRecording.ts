import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { openRecorder, listBrowserDevices, unlockDeviceLabels, uploadTake, submitTake, recordingRequest, plainError, listSavedTakes, discardSavedTake, recoverSavedTake, type BrowserRecorder, type DesktopRecorder, type DeviceOption, type EndReason, type FinishedTake, type LiveTrackStatus, type Recorder, type RecorderPermissionName, type RecorderPermissions, type RecorderTargets, type SavedTake, type ScreenChoice, type SharedSurface, type TakePlacement, type UploadProgress, type RecordingAnswer } from '../record';
import { nativeDraftStore, provisionalRecord, type Draft, type DraftBridge, type DraftStore, type FilingState } from '../record/provisional';
import { Filer, localTracks, settleRecording, type FilingApi, type Settled } from '../record/filing';
import { inUseReason, keptFor, listedTakes, localTakeActions, localTakeRows, takeOverFromSession, takesInFlight, type LocalTakeRow } from '../record/local-takes';
import { normalizeStop, takesBeingSent } from '../record/desktop';
import type { TakeWord } from '../record/types';
import { request } from './client';

/** One take in this tab, from Start until it is a video (or failed). Shaped like the session the editor's follow-ups read. */
export type RecordingSession = { id: string; status: 'preparing' | 'countdown' | 'recording' | 'finalizing' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; createdAt: string;
  camera: boolean; microphone: boolean; countdownRemaining?: number; elapsedMs: number; level?: number | null; note?: string; error?: string; step?: string;
  /** While it is prepared on the Studio (after the upload): how far along, 0 to 1. */
  progress?: number;
  punch?: { projectId: string; fromFrame: number; toFrame: number; beatIds?: string[] }; projectId?: string; screenAssetId?: string; voiceAssetId?: string; partialAssetId?: string;
  /** The take is kept on this device after a failed upload: Try again sends it again. */
  retry?: boolean;
  /** The Mac app: the take opened in the editor at Stop from the files on the computer (record/provisional.ts), filed meanwhile. */
  draft?: Draft };
/** What Start records. */
export type RecordingStart = { screen: ScreenChoice; cameraId: string | null | false; microphoneId: string | null | false; systemAudio: boolean; countdownSeconds?: number; placement: TakePlacement; title?: string };
export type RecorderState = { state: 'checking' } | { state: 'unavailable'; reason: string } | { state: 'desktop' } | { state: 'browser'; desktopShell: boolean };
/** A teleprompter mark, ms after the screen started: the line it moved to, or a retake of it. */
export type PrompterMark = { ms: number; beat?: number; retake?: number };

export const manualSessionActive = (session: RecordingSession | null | undefined) => !!session && ['preparing', 'countdown', 'recording', 'finalizing'].includes(session.status);
const message = (error: unknown) => plainError(error);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const api: FilingApi = { get: <T,>(url: string) => request<T>(url), post: <T,>(url: string, body?: unknown) => request<T>(url, body ?? {}) };

/** The Record dialog's recorder: which backend, what it can record, and the take in progress. The take lives in this tab. */
export function useManualRecording(notify: (text: string, error?: boolean) => void) {
  const [recorderState, setRecorderState] = useState<RecorderState>({ state: 'checking' });
  const recorder = useRef<Recorder | null>(null);
  const [targets, setTargets] = useState<RecorderTargets | null>(null);
  const [permissions, setPermissions] = useState<RecorderPermissions | null>(null);
  const [browserDevices, setBrowserDevices] = useState<{ cameras: DeviceOption[]; microphones: DeviceOption[] } | null>(null);
  const [share, setShare] = useState<SharedSurface | null>(null);
  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  /** While a browser take records: each track's upload (what is on the Studio, what a crash would lose). */
  const [liveTracks, setLiveTracks] = useState<LiveTrackStatus[]>([]);
  /** Takes whose window closed before they were finished, kept on the Studio: offered back. */
  const [savedTakes, setSavedTakes] = useState<SavedTake[]>([]);
  /** The Mac app's takes opened before they were filed, by video id: how far the filing is (gone once filed). */
  const [filing, setFiling] = useState<Record<string, FilingState>>({});
  /** Videos whose take the Studio has filed, for the editor to carry on from the Studio's copies (App.tsx adopt). */
  const [filed, setFiled] = useState<string[]>([]);
  /** The Mac app: where drafts are kept (beside their takes), and each take's filing (record/filing.ts). */
  const [drafts, setDrafts] = useState<DraftStore | null>(null);
  const filer = useRef<Filer | null>(null);
  /** Words that arrived after a draft opened, by video id, for the editor to take in (App.tsx). */
  const [heard, setHeard] = useState<Record<string, TakeWord[]>>({});
  const mounted = useRef(true), operation = useRef(false), current = useRef<string | null>(null), pending = useRef<{ id: string; take: FinishedTake; placement: TakePlacement; title?: string } | null>(null);
  /** The takes a "Preparing your recording" finish is uploading or having made now (never listed under Record meanwhile). */
  const inFlight = useRef(takesInFlight());
  const take = useRef<{ placement: TakePlacement; title?: string } | null>(null);
  const stopWords = useRef<(() => void) | null>(null), leaveRef = useRef<(() => void) | null>(null), notifyRef = useRef(notify);
  notifyRef.current = notify;
  const marks = useRef<PrompterMark[]>([]), screenStart = useRef<number | null>(null), countdownCancel = useRef<(() => void) | null>(null), endedRef = useRef<(reason: EndReason) => void>(() => {});
  const active = sessions.find(manualSessionActive) ?? null;
  const selected = sessions.find(session => session.id === selectedId) ?? null;

  const patch = useCallback((id: string, change: Partial<RecordingSession>) => { if (mounted.current) setSessions(all => all.map(item => item.id === id ? { ...item, ...change } : item)); }, []);
  /** Find the recorder once; the dialog asks for it again with refreshTargets. */
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    void openRecorder().then(opened => {
      if (!alive) { if (opened.kind !== 'unavailable') opened.recorder.dispose(); return; }
      if (opened.kind === 'unavailable') { setRecorderState({ state: 'unavailable', reason: opened.reason }); return; }
      recorder.current = opened.recorder;
      if (opened.kind === 'browser') { setRecorderState({ state: 'browser', desktopShell: opened.desktopShell }); opened.recorder.onShareChange(value => { if (mounted.current) setShare(value); }); }
      else { const desktop = opened.recorder as DesktopRecorder; const store = nativeDraftStore(desktop.app as unknown as DraftBridge);
        filer.current = new Filer({ store, api, native: desktop.app, leases: desktop.leases, sleep, alive: () => mounted.current,
          uploadTake: (take, whole, onFraction) => { if (whole) for (const file of take.files) { delete file.uploadKey; delete file.pieces; file.whole = true; } return uploadTake(desktop, take, files => { const total = files.reduce((n, f) => n + f.bytes, 0) || 1; onFraction(files.reduce((n, f) => n + f.bytes * f.fraction, 0) / total); }); },
          sendUnfinished: () => desktop.sendUnfinished(),
          onState: (projectId, next) => filingStateRef.current(projectId, next), onFiled: (projectId) => markFiledRef.current(projectId),
          onWords: (projectId, words) => { if (mounted.current) setHeard(all => ({ ...all, [projectId]: words })); },
          onKept: (_projectId, note) => notifyRef.current(note, true), onWordsDropped: (_projectId, note) => notifyRef.current(note, true) });
        // The words the Mac heard arrive after Stop: each take's filing takes them in.
        const words = (desktop.app as { onWords?: (cb: (event: { sessionId: string; transcript: unknown }) => void) => Promise<() => void> | (() => void) }).onWords;
        if (typeof words === 'function') void Promise.resolve(words(event => { void filer.current?.wordsEvent(event); })).then(off => { if (!alive) off(); else stopWords.current = off; }).catch(() => undefined);
        // The page goes (a reload, a closed window): its holds go at once, so the next page or another window takes over.
        const leave = () => desktop.leases.releaseAll(); window.addEventListener('pagehide', leave); leaveRef.current = () => window.removeEventListener('pagehide', leave);
        setDrafts(store); setRecorderState({ state: 'desktop' }); }
    }).catch(cause => { if (alive) setRecorderState({ state: 'unavailable', reason: message(cause) }); });
    return () => { alive = false; mounted.current = false; countdownCancel.current?.(); stopWords.current?.(); leaveRef.current?.(); recorder.current?.dispose(); recorder.current = null; filer.current = null; };
  }, []);

  const refreshTargets = useCallback(async () => {
    const rec = recorder.current;
    if (!rec) return;
    setLoadingTargets(true);
    try {
      if (rec.kind === 'desktop') { const desktop = rec as DesktopRecorder; const [found, allowed] = await Promise.all([desktop.targets(), desktop.permissions().catch(() => null)]); if (!mounted.current) return; setTargets(found); setPermissions(allowed); }
      else { const found = await listBrowserDevices(); if (mounted.current) setBrowserDevices(found); }
      if (mounted.current) setError(null);
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { if (mounted.current) setLoadingTargets(false); }
  }, []);
  useEffect(() => { if (recorderState.state === 'desktop' || recorderState.state === 'browser') void refreshTargets(); }, [recorderState.state, refreshTargets]);
  // A camera or microphone plugged in or out while the dialog is open.
  useEffect(() => {
    if (recorderState.state !== 'browser' || !navigator.mediaDevices?.addEventListener) return;
    const changed = () => { void refreshTargets(); };
    navigator.mediaDevices.addEventListener('devicechange', changed);
    return () => navigator.mediaDevices.removeEventListener('devicechange', changed);
  }, [recorderState.state, refreshTargets]);

  /** Desktop: check the five permissions again (after the person changed them in System Settings). */
  const checkPermissions = useCallback(async () => { const rec = recorder.current; if (rec?.kind !== 'desktop') return; try { const value = await (rec as DesktopRecorder).permissions(); if (mounted.current) setPermissions(value); } catch (cause) { if (mounted.current) setError(message(cause)); } }, []);
  /** Desktop: ask macOS for the ones still missing (its prompts, or System Settings). */
  const requestPermissions = useCallback(async (which: RecorderPermissionName[]) => { const rec = recorder.current; if (rec?.kind !== 'desktop') return; setWorking(true); try { const value = await (rec as DesktopRecorder).requestPermissions(which); if (!mounted.current) return; setPermissions(value);
      // Screen Recording is allowed in System Settings and only takes effect once the app restarts.
      if (which.includes('screenRecording') && value.screenRecording !== 'granted') setError('Allow Native Intelligence under Screen Recording in System Settings, then quit and reopen Native Intelligence: macOS applies it after a restart.'); } catch (cause) { if (mounted.current) setError(message(cause)); } finally { if (mounted.current) setWorking(false); } }, []);
  /** Browser: ask once for the camera/microphone so their names show in the lists. */
  const unlockDevices = useCallback(async (video: boolean, audio: boolean) => { const refused = await unlockDeviceLabels(video, audio); if (!mounted.current) return; if (refused) setError(refused); await refreshTargets(); }, [refreshTargets]);
  /** Browser: open the browser's own picker. Must be called straight from a click. */
  const chooseShare = useCallback(async (withSound: boolean) => {
    const rec = recorder.current;
    if (rec?.kind !== 'browser') return null;
    setError(null);
    try { return await (rec as BrowserRecorder).chooseShare(withSound); }
    catch (cause) { if (mounted.current) setError(message(cause)); return null; }
  }, []);
  const clearShare = useCallback(() => { const rec = recorder.current; if (rec?.kind === 'browser') (rec as BrowserRecorder).clearShare(); }, []);

  const filingState = useCallback((projectId: string, next: FilingState | null) => { if (mounted.current) setFiling(all => { const copy = { ...all }; if (next) copy[projectId] = next; else delete copy[projectId]; return copy; }); }, []);
  const filingStateRef = useRef(filingState); filingStateRef.current = filingState;
  const markFiledRef = useRef((projectId: string) => { if (mounted.current) setFiled(all => all.includes(projectId) ? all : [...all, projectId]); });

  /** Try filing a take again (after it failed): this run's take is sent again whole; another is brought back from the Studio. */
  const refile = useCallback(async (projectId: string) => { await filer.current?.refile(projectId); }, []);
  /** The editor has carried on from the Studio's copies of a filed take. */
  const adopted = useCallback((projectId: string) => { if (mounted.current) setFiled(all => all.filter(item => item !== projectId)); }, []);
  /** The editor has left a filed take's video: its files on this computer go once the Studio holds every byte of them. */
  const releaseTake = useCallback(async (projectId: string): Promise<Settled> => filer.current ? filer.current.release(projectId) : { safe: false }, []);
  /** This run's key to the take files' scheme (the editor plays a draft's files with it; never stored). */
  const takeKey = useCallback(async (): Promise<string | null> => { const rec = recorder.current; if (rec?.kind !== 'desktop') return null; const fn = (rec as DesktopRecorder).app.takeToken as (() => Promise<string>) | undefined; try { return typeof fn === 'function' ? await fn() : null; } catch { return null; } }, []);
  /** Words the editor has taken in. */
  const wordsTaken = useCallback((projectId: string) => { if (mounted.current) setHeard(all => { const copy = { ...all }; delete copy[projectId]; return copy; }); }, []);

  /** Upload a stopped take, have it made into a video, and say where it went. */
  const finish = useCallback(async (id: string, take: FinishedTake, placement: TakePlacement, title?: string) => {
    const rec = recorder.current;
    if (!rec) return;
    // The two paths split here. The Mac app's take that becomes a new video opens in the editor at once from the files
    // on the computer and is filed behind it (record/provisional.ts). Everything else waits for the Studio as before
    // ("Preparing your recording"): a browser take (also every take on Windows, which has no native recorder), a
    // punch-in or a take into beats (placed into a video the Studio changes), or a take whose files the computer
    // could not describe.
    if (rec.kind === 'desktop' && placement.kind === 'new') {
      const projectId = crypto.randomUUID(), named = title ?? `Recording · ${new Date().toLocaleString()}`;
      const draft = await (rec as DesktopRecorder).provisional(take, projectId, named).catch(() => null);
      const kept = draft && drafts && filer.current ? await drafts.put(provisionalRecord(draft, { sessionId: take.sessionId, takeId: take.liveTakeId ?? null, title: named, files: take.files, take })).then(() => true, () => false) : false;
      // Not kept beside the take (the disk refused it): the take waits for the Studio as before, nothing is lost.
      if (draft && kept && filer.current) {
        const filing = filer.current;
        // The take's id on the Studio, once it answered its start: what brings it back if the app quits before it is filed.
        if (!take.liveTakeId) void (rec as DesktopRecorder).liveTakeIdOf(take.sessionId).then(takeId => { if (takeId) void filing.records.update(projectId, r => ({ ...r, takeId })).catch(() => undefined); });
        patch(id, { status: 'completed', step: undefined, projectId, draft, ...(take.note ? { note: take.note } : {}) });
        if (mounted.current) setLiveTracks([]);
        void filing.start(take, projectId, named);
        return;
      }
    }
    pending.current = { id, take, placement, ...(title ? { title } : {}) };
    patch(id, { status: 'finalizing', step: 'Uploading', retry: false, error: undefined });
    await inFlight.current.during(take.sessionId, async () => { try {
      const keys = await uploadTake(rec, take, files => { if (mounted.current) setUploads(files); });
      if (mounted.current) setLiveTracks([]);
      patch(id, { step: 'Preparing your recording', ...(take.note ? { note: take.note } : {}) });
      const answer = await submitTake(recordingRequest(take, keys, placement, title), view => patch(id, { step: view.step, progress: view.progress, ...(view.note ? { note: view.note } : {}) }), () => mounted.current);
      if (answer.recording.status !== 'done') return;
      pending.current = null;
      // The Mac's files go only once the Studio holds every track as recorded (a track it lost is sent again first).
      let kept: Settled | null = null;
      if (rec.kind === 'desktop') { const desktop = rec as DesktopRecorder; kept = await settleRecording({ api, native: desktop.app, sleep }, answer.recording.id, take.sessionId); if (kept.safe) await rec.discard(take).catch(() => {}); else await desktop.forget(take).catch(() => {}); }
      else await rec.discard(take).catch(() => {});
      const view = kept?.view ?? answer.recording;
      const note = [view.note, kept && !kept.safe ? kept.note : undefined].filter(Boolean).join(' ');
      patch(id, { status: 'completed', step: undefined, ...(view.projectId ? { projectId: view.projectId } : {}), ...(view.screenAssetId ? { screenAssetId: view.screenAssetId } : {}), ...(view.voiceAssetId ? { voiceAssetId: view.voiceAssetId } : {}), ...(note ? { note } : {}),
        ...(view.placed === 'new' && placement.kind !== 'new' ? { punch: undefined } : {}) });
      if (mounted.current) setUploads([]);
    } catch (cause) {
      patch(id, { status: 'failed', step: undefined, retry: true, error: `The take is kept on this device, but it could not be saved: ${message(cause)}` });
    } });
  }, [patch, drafts]);
  const finishRef = useRef(finish); finishRef.current = finish;

  /** The take stopped: collect its files and finish it. */
  const stopTake = useCallback(async (id: string, reason?: EndReason) => {
    const rec = recorder.current, info = take.current;
    if (!rec || !info || current.current !== id) return;
    current.current = null;
    // Recording into beats: the teleprompter's marks so far say where each beat's part of the take is.
    const placement: TakePlacement = info.placement.kind === 'beats' ? { ...info.placement, marks: [...marks.current] } : info.placement, title = info.title;
    patch(id, { status: 'finalizing', step: 'Saving the recording', level: null, ...(reason?.kind === 'error' ? { note: reason.message } : {}) });
    let finished: FinishedTake;
    try { finished = await rec.stop(); }
    catch (cause) { patch(id, { status: 'failed', step: undefined, error: message(cause) }); return; }
    await finish(id, finished, placement, title);
  }, [finish, patch]);

  const start = useCallback(async (options: RecordingStart): Promise<RecordingSession | null> => {
    const rec = recorder.current;
    if (!rec || operation.current || current.current) return null;
    operation.current = true; setWorking(true); setError(null);
    const id = crypto.randomUUID(), punch = options.placement.kind === 'punch' ? { projectId: options.placement.projectId, fromFrame: options.placement.fromFrame, toFrame: options.placement.toFrame } : options.placement.kind === 'beats' ? { projectId: options.placement.projectId, fromFrame: 0, toFrame: 0, beatIds: options.placement.beatIds } : undefined;
    const session: RecordingSession = { id, status: 'preparing', createdAt: new Date().toISOString(), camera: options.cameraId !== false, microphone: options.microphoneId !== false, elapsedMs: 0, ...(punch ? { punch } : {}) };
    setSessions(all => [session, ...all].slice(0, 20)); setSelectedId(id); current.current = id; marks.current = []; screenStart.current = null; setLiveTracks([]);
    try {
      await rec.prepare({ screen: options.screen, camera: options.cameraId === false ? null : { deviceId: options.cameraId }, microphone: options.microphoneId === false ? null : { deviceId: options.microphoneId }, systemAudio: options.systemAudio, hideCursor: true });
      if (mounted.current) setWorking(false);
      // The countdown: Cancel during it stops before anything is recorded.
      let cancelled = false; countdownCancel.current = () => { cancelled = true; };
      for (let left = Math.max(0, Math.min(10, options.countdownSeconds ?? 3)); left > 0 && !cancelled; left--) { patch(id, { status: 'countdown', countdownRemaining: left }); await sleep(1000); }
      countdownCancel.current = null;
      if (cancelled || current.current !== id) { await rec.cancel().catch(() => {}); patch(id, { status: 'cancelled' }); current.current = null; return null; }
      // Named in the person's own time zone (the server only knows UTC).
      take.current = { placement: options.placement, title: options.title ?? `Recording · ${new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}` };
      endedRef.current = reason => {
        if (current.current !== id) return;
        if (reason.kind === 'cancelled') { current.current = null; void rec.cancel().catch(() => {}); patch(id, { status: 'cancelled', level: null }); notify('Recording cancelled.'); return; }
        if (reason.kind !== 'error') notify(reason.kind === 'share-ended' ? 'Sharing ended, so the recording stopped.' : 'Recording stopped.');
        void stopTake(id, reason);
      };
      await rec.start({ onStatus: status => { if (current.current !== id) return; patch(id, { elapsedMs: status.elapsedMs, level: status.level }); if (status.tracks && mounted.current) setLiveTracks(status.tracks); }, onEnded: reason => endedRef.current(reason) });
      screenStart.current = performance.now();
      patch(id, { status: 'recording', countdownRemaining: undefined, elapsedMs: 0 });
      return { ...session, status: 'recording' };
    } catch (cause) {
      countdownCancel.current = null;
      if (current.current === id) current.current = null;
      await rec.cancel().catch(() => {});
      const text = message(cause);
      if (mounted.current) { setError(text); setSessions(all => all.filter(item => item.id !== id)); }
      return null;
    } finally { operation.current = false; if (mounted.current) setWorking(false); }
  }, [notify, patch, stopTake]);

  const stop = useCallback(async (id: string) => {
    const session = sessions.find(item => item.id === id);
    if (!session || current.current !== id) return;
    if (session.status === 'countdown' || session.status === 'preparing') { countdownCancel.current?.(); return; }
    await stopTake(id);
  }, [sessions, stopTake]);
  const cancel = useCallback(async (id: string) => {
    const rec = recorder.current;
    if (current.current !== id) {
      // A failed take kept for Try again: throw it away.
      // Only the take this session kept (another session's banner never discards it).
      const kept = keptFor(pending.current, id);
      if (kept && rec) { pending.current = null; await rec.discard(kept.take).catch(() => {}); patch(id, { status: 'cancelled', retry: false }); }
      return;
    }
    countdownCancel.current?.();
    current.current = null;
    try { await rec?.cancel(); } catch { /* already stopped */ }
    patch(id, { status: 'cancelled', level: null });
  }, [patch]);
  /** Send a kept take again after its upload or processing failed. */
  const retry = useCallback(async (id: string) => { const kept = keptFor(pending.current, id); if (!kept) return; await finish(id, kept.take, kept.placement, kept.title); }, [finish]);
  /** Teleprompter: the line moved on (or is being retaken), noted on the screen file's clock. */
  const mark = useCallback((value: { beat?: number; retake?: number }) => { const at = screenStart.current; if (at === null) return; marks.current = [...marks.current, { ms: Math.max(0, Math.round(performance.now() - at)), ...value }]; }, []);
  const refreshSessions = useCallback(async () => { await refreshTargets(); void refreshLocalTakesRef.current(); }, [refreshTargets]);
  const refreshLocalTakesRef = useRef<() => Promise<void>>(async () => undefined);
  // A take recording or uploading lives in this tab: leaving the page would lose it, so the browser asks first.
  const busy = !!active;
  useEffect(() => {
    if (!busy) return;
    const before = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [busy]);
  /** The takes kept on the Studio after their window closed mid-take; never one this tab is still recording or sending (the Studio would refuse it, as still recording, but the dialog must not offer it). */
  const refreshSavedTakes = useCallback(async () => { try { const takes = await listSavedTakes(); const records = drafts ? await drafts.list().catch(() => []) : []; const mine = new Set([...((recorder.current as { liveTakeIds?: () => string[] } | null)?.liveTakeIds?.() ?? []), ...records.flatMap(record => record.takeId ? [record.takeId] : [])]); if (mounted.current) setSavedTakes(takes.filter(take => !mine.has(take.id))); } catch { /* an older server: nothing to offer */ } }, [drafts]);
  useEffect(() => { void refreshSavedTakes(); }, [refreshSavedTakes]);
  /**
   * The Mac app: drafts found again (a reload, a restart) are taken back by this page when no other window holds them,
   * then what a quit or a crash kept from going up is sent (their last pieces first, also those of the drafts this page
   * now holds), and each draft's filing goes on; then the takes are offered back.
   */
  const [openElsewhere, setOpenElsewhere] = useState<string[]>([]);
  useEffect(() => {
    if (recorderState.state !== 'desktop' || !drafts || !filer.current) return;
    const filing = filer.current, desktop = recorder.current as DesktopRecorder;
    void (async () => {
      const records = await drafts.list().catch(() => []);
      const elsewhere: string[] = [];
      for (const record of records) if (!(await desktop.leases.hold(record.sessionId))) elsewhere.push(record.projectId);
      if (mounted.current) setOpenElsewhere(elsewhere);
      const sent = await desktop.sendUnfinished().catch(() => 0);
      if (sent && mounted.current) void refreshSavedTakes();
      for (const record of records) if (!elsewhere.includes(record.projectId)) await filing.resume(record);
      void refreshLocalTakes();
    })();
  }, [recorderState.state, drafts, refreshSavedTakes]);// eslint-disable-line react-hooks/exhaustive-deps

  /** Takes kept on this computer that are not settled (record/local-takes.ts): listed in the Record dialog. */
  const [localTakes, setLocalTakes] = useState<LocalTakeRow[]>([]);
  /** The listed takes being acted on now (their buttons wait). */
  const [localBusy, setLocalBusy] = useState<string[]>([]);
  /** The editor's Try again on a filed take whose edit is not on the video yet (App.tsx retryAdopt). */
  const adoptWith = useRef<((projectId: string) => Promise<void>) | null>(null);
  /** The video ids of takes the editor has open (App.tsx): never listed, never discarded under it. */
  const inUseWith = useRef<() => ReadonlySet<string>>(() => new Set());
  const savedTakesRef = useRef(savedTakes); savedTakesRef.current = savedTakes;
  /** What this page is filing now, or has open in the editor (the editor says how it goes). */
  const busyHere = () => new Set([...Object.entries(filingRef.current).filter(([, state]) => !state.failed).map(([id]) => id), ...inUseWith.current()]);
  const refreshLocalTakes = useCallback(async () => {
    const rec = recorder.current;
    if (rec?.kind !== 'desktop' || !drafts) return;
    const desktop = rec as DesktopRecorder, list = desktop.app.unfinishedTakes;
    if (typeof list !== 'function') return;
    try {
      // Not caught: without the records, a take's draft would read as lost.
      const [raw, records] = await Promise.all([list(desktop.leases.holder), drafts.list()]);
      // What this page is recording or sending on now is not listed (the live bar and the next launch say how it goes),
      // nor a take shown already as kept on the Studio (its banner brings it back with the files here).
      const recording = new Set([...(desktop.liveSessions?.() ?? []), ...takesBeingSent()]);
      const onStudio = new Set(savedTakesRef.current.map(take => take.id));
      // Takes this recorder still has, and the one a running "Preparing your recording" upload is sending: never listed
      // (Discard would delete them under the upload; Try again would make a second video).
      const owned = inFlight.current.ids();
      const rows = localTakeRows(listedTakes(raw).filter(take => !recording.has(take.sessionId)), records, busyHere(), sessionId => desktop.leases.holds(sessionId), owned);
      if (mounted.current) setLocalTakes(rows.filter(row => !(row.action.kind === 'recover' && onStudio.has(row.action.takeId))));
    } catch { /* an app without the list: nothing to show */ }
  }, [drafts]);
  const filingRef = useRef(filing); filingRef.current = filing;
  refreshLocalTakesRef.current = refreshLocalTakes;
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  /** Try again and Discard on the listed takes: one at a time per take (record/local-takes.ts localTakeActions). */
  const localActions = useRef<ReturnType<typeof localTakeActions> | null>(null);
  localActions.current ??= localTakeActions({
    refile: async projectId => { await filer.current?.refile(projectId); },
    adopt: async projectId => { if (adoptWith.current) await adoptWith.current(projectId); else markFiledRef.current(projectId); },
    release: async (projectId, anyway) => filer.current ? filer.current.release(projectId, { anyway }) : { safe: false },
    recover: async takeId => {
      const desktop = recorder.current as DesktopRecorder;
      // Its last pieces first (and a take the Studio has every byte of goes by itself): only what is left is brought back.
      await desktop.sendUnfinished().catch(() => 0);
      const still = listedTakes(await desktop.app.unfinishedTakes?.(desktop.leases.holder).catch(() => null)).some(take => take.takeId === takeId);
      if (!still) { notifyRef.current('This recording was settled with the Studio already, so nothing was left to bring back.'); return; }
      await recoverSavedRef.current(takeId);
    },
    fileWhole: async row => {
      const desktop = recorder.current as DesktopRecorder;
      const raw = (await desktop.app.unfinishedTakes?.(desktop.leases.holder)) as unknown;
      const stop = listedTakes(raw).find(take => take.sessionId === row.sessionId)?.stop;
      if (!stop) throw new Error('Its files could not be described.');
      // A new video from the files on this computer (a punch-in or beats take too: where it was meant to go is not kept).
      const id = crypto.randomUUID(), take = normalizeStop(row.sessionId, stop, row.at ? new Date(row.at) : new Date());
      setSessions(all => [{ id, status: 'finalizing', createdAt: row.at ?? new Date().toISOString(), camera: take.files.some(f => f.role === 'camera'), microphone: take.files.some(f => f.role === 'microphone'), elapsedMs: Math.round(take.durationSeconds * 1000), step: 'Uploading' } as RecordingSession, ...all].slice(0, 20));
      await finishRef.current(id, take, { kind: 'new' });
    },
    records: async () => (draftsRef.current ? draftsRef.current.list() : []),
    discard: async sessionId => { await (recorder.current as DesktopRecorder).app.discard(sessionId); },
    inUse: async sessionId => {
      const desktop = recorder.current as DesktopRecorder;
      return inUseReason(sessionId, { sending: new Set([...takesBeingSent(), ...(desktop.liveSessions?.() ?? [])]), records: await (draftsRef.current?.list() ?? Promise.resolve([])), open: busyHere() });
    },
    holdTake: sessionId => (recorder.current as DesktopRecorder).leases.hold(sessionId),
    letGoTake: sessionId => (recorder.current as DesktopRecorder).leases.release(sessionId),
    holdsTake: sessionId => (recorder.current as DesktopRecorder).leases.holds(sessionId),
    takeOver: sessionId => { const id = takeOverFromSession(pending, sessionId); if (id) patch(id, { retry: false }); },
    notify: (text, error) => notifyRef.current(text, error),
    refresh: () => void refreshLocalTakesRef.current(),
    onBusy: ids => { if (mounted.current) setLocalBusy(ids); },
  });
  /** Try again on a take kept on this computer: filed (or let go of, once the Studio holds every byte), from what it is. */
  const retryLocal = useCallback(async (row: LocalTakeRow, alt = false) => { if (recorder.current?.kind === 'desktop') await localActions.current!.retry(row, alt); }, []);
  /** Discard a take kept on this computer, for good (the person asked twice). */
  const discardLocal = useCallback(async (sessionId: string) => { if (recorder.current?.kind === 'desktop') await localActions.current!.discard(sessionId); }, []);
  /** Make a saved take a new video from what reached the Studio, followed like a finished take. */
  const recoverSaved = useCallback(async (takeId: string) => {
    const saved = savedTakes.find(item => item.id === takeId);
    const id = crypto.randomUUID();
    const session: RecordingSession = { id, status: 'finalizing', createdAt: saved?.createdAt ?? new Date().toISOString(), camera: !!saved?.tracks.some(track => track.role === 'camera'), microphone: !!saved?.tracks.some(track => track.role === 'microphone'), elapsedMs: Math.round((saved?.seconds ?? 0) * 1000), step: 'Bringing back your recording' };
    setSessions(all => [session, ...all].slice(0, 20)); setSelectedId(id); setSavedTakes(all => all.filter(item => item.id !== takeId));
    try {
      // The Mac's hash of each file it still has: a track the Studio holds less of is then lost, and sent again whole.
      let sha256: Record<string, string> | undefined;
      const rec = recorder.current;
      if (rec?.kind === 'desktop') {
        const desktop = rec as DesktopRecorder;
        await desktop.sendUnfinished().catch(() => 0);
        const local = listedTakes(await desktop.app.unfinishedTakes?.(desktop.leases.holder).catch(() => null)).find(take => take.takeId === takeId);
        const tracks = local ? await localTracks(desktop.app, local.sessionId) : null;
        if (tracks?.length) sha256 = Object.fromEntries(tracks.map(t => [t.role === 'system-audio' ? 'systemAudio' : t.role, t.sha256]));
      }
      const answer = await recoverSavedTake(takeId, view => patch(id, { step: view.step, progress: view.progress, ...(view.note ? { note: view.note } : {}) }), () => mounted.current, undefined, sha256);
      if (answer.recording.status !== 'done') return;
      const view = answer.recording;
      patch(id, { status: 'completed', step: undefined, ...(view.projectId ? { projectId: view.projectId } : {}), ...(view.screenAssetId ? { screenAssetId: view.screenAssetId } : {}), ...(view.voiceAssetId ? { voiceAssetId: view.voiceAssetId } : {}), ...(view.note ? { note: view.note } : {}) });
    } catch (cause) { patch(id, { status: 'failed', step: undefined, error: message(cause) }); void refreshSavedTakes(); }
  }, [patch, refreshSavedTakes, savedTakes]);
  const recoverSavedRef = useRef(recoverSaved); recoverSavedRef.current = recoverSaved;
  /** Throw a saved take away for good. */
  const discardSaved = useCallback(async (takeId: string) => { try { await discardSavedTake(takeId); if (mounted.current) setSavedTakes(all => all.filter(item => item.id !== takeId)); } catch (cause) { if (mounted.current) setError(message(cause)); } }, []);
  /** A partial take kept apart from a video does not exist with this recorder (a stopped take is always the whole take). */
  const openPartial = useCallback(async (id: string): Promise<EditorProject | null> => { void id; return null; }, []);

  return { recorderState, targets, permissions, browserDevices, share, sessions, selected, active, selectedId, setSelectedId, loadingTargets, working, error, uploads, liveTracks, savedTakes, filing, filed,
    drafts, heard, openElsewhere, records: () => filer.current?.records ?? null, localTakes, localBusy, refreshLocalTakes, retryLocal, discardLocal, adoptWith, inUseWith,
    wordsSettled: (projectId: string, limitMs: number) => filer.current ? filer.current.wordsSettled(projectId, limitMs) : Promise.resolve(true),
    refreshTargets, refreshSessions, checkPermissions, requestPermissions, unlockDevices, chooseShare, clearShare, start, stop, cancel, retry, mark, openPartial, refreshSavedTakes, recoverSaved, discardSaved, refile, adopted, releaseTake, wordsTaken, takeKey };
}
export type ManualRecording = ReturnType<typeof useManualRecording>;
