import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { openRecorder, listBrowserDevices, unlockDeviceLabels, uploadTake, submitTake, recordingRequest, plainError, listSavedTakes, discardSavedTake, recoverSavedTake, type BrowserRecorder, type DesktopRecorder, type DeviceOption, type EndReason, type FinishedTake, type LiveTrackStatus, type Recorder, type RecorderPermissionName, type RecorderPermissions, type RecorderTargets, type SavedTake, type ScreenChoice, type SharedSurface, type TakePlacement, type UploadProgress } from '../record';

/** One take in this tab, from Start until it is a video (or failed). Shaped like the session the editor's follow-ups read. */
export type RecordingSession = { id: string; status: 'preparing' | 'countdown' | 'recording' | 'finalizing' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; createdAt: string;
  camera: boolean; microphone: boolean; countdownRemaining?: number; elapsedMs: number; level?: number | null; note?: string; error?: string; step?: string;
  /** While it is prepared on the Studio (after the upload): how far along, 0 to 1. */
  progress?: number;
  punch?: { projectId: string; fromFrame: number; toFrame: number; beatIds?: string[] }; projectId?: string; screenAssetId?: string; voiceAssetId?: string; partialAssetId?: string;
  /** The take is kept on this device after a failed upload: Try again sends it again. */
  retry?: boolean };
/** What Start records. */
export type RecordingStart = { screen: ScreenChoice; cameraId: string | null | false; microphoneId: string | null | false; systemAudio: boolean; countdownSeconds?: number; placement: TakePlacement; title?: string };
export type RecorderState = { state: 'checking' } | { state: 'unavailable'; reason: string } | { state: 'desktop' } | { state: 'browser'; desktopShell: boolean };
/** A teleprompter mark, ms after the screen started: the line it moved to, or a retake of it. */
export type PrompterMark = { ms: number; beat?: number; retake?: number };

export const manualSessionActive = (session: RecordingSession | null | undefined) => !!session && ['preparing', 'countdown', 'recording', 'finalizing'].includes(session.status);
const message = (error: unknown) => plainError(error);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
  const mounted = useRef(true), operation = useRef(false), current = useRef<string | null>(null), pending = useRef<{ take: FinishedTake; placement: TakePlacement; title?: string } | null>(null);
  const take = useRef<{ placement: TakePlacement; title?: string } | null>(null);
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
      else setRecorderState({ state: 'desktop' });
    }).catch(cause => { if (alive) setRecorderState({ state: 'unavailable', reason: message(cause) }); });
    return () => { alive = false; mounted.current = false; countdownCancel.current?.(); recorder.current?.dispose(); recorder.current = null; };
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

  /** Upload a stopped take, have it made into a video, and say where it went. */
  const finish = useCallback(async (id: string, take: FinishedTake, placement: TakePlacement, title?: string) => {
    const rec = recorder.current;
    if (!rec) return;
    pending.current = { take, placement, ...(title ? { title } : {}) };
    patch(id, { status: 'finalizing', step: 'Uploading', retry: false, error: undefined });
    try {
      const keys = await uploadTake(rec, take, files => { if (mounted.current) setUploads(files); });
      if (mounted.current) setLiveTracks([]);
      patch(id, { step: 'Preparing your recording', ...(take.note ? { note: take.note } : {}) });
      const answer = await submitTake(recordingRequest(take, keys, placement, title), view => patch(id, { step: view.step, progress: view.progress, ...(view.note ? { note: view.note } : {}) }), () => mounted.current);
      if (answer.recording.status !== 'done') return;
      pending.current = null;
      await rec.discard(take).catch(() => {});
      const view = answer.recording;
      patch(id, { status: 'completed', step: undefined, ...(view.projectId ? { projectId: view.projectId } : {}), ...(view.screenAssetId ? { screenAssetId: view.screenAssetId } : {}), ...(view.voiceAssetId ? { voiceAssetId: view.voiceAssetId } : {}), ...(view.note ? { note: view.note } : {}),
        ...(view.placed === 'new' && placement.kind !== 'new' ? { punch: undefined } : {}) });
      if (mounted.current) setUploads([]);
    } catch (cause) {
      patch(id, { status: 'failed', step: undefined, retry: true, error: `The take is kept on this device, but it could not be saved: ${message(cause)}` });
    }
  }, [patch]);

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
      const kept = pending.current;
      if (kept && rec) { pending.current = null; await rec.discard(kept.take).catch(() => {}); patch(id, { status: 'cancelled', retry: false }); }
      return;
    }
    countdownCancel.current?.();
    current.current = null;
    try { await rec?.cancel(); } catch { /* already stopped */ }
    patch(id, { status: 'cancelled', level: null });
  }, [patch]);
  /** Send a kept take again after its upload or processing failed. */
  const retry = useCallback(async (id: string) => { const kept = pending.current; if (!kept) return; await finish(id, kept.take, kept.placement, kept.title); }, [finish]);
  /** Teleprompter: the line moved on (or is being retaken), noted on the screen file's clock. */
  const mark = useCallback((value: { beat?: number; retake?: number }) => { const at = screenStart.current; if (at === null) return; marks.current = [...marks.current, { ms: Math.max(0, Math.round(performance.now() - at)), ...value }]; }, []);
  const refreshSessions = useCallback(async () => { await refreshTargets(); }, [refreshTargets]);
  // A take recording or uploading lives in this tab: leaving the page would lose it, so the browser asks first.
  const busy = !!active;
  useEffect(() => {
    if (!busy) return;
    const before = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [busy]);
  /** The takes kept on the Studio after their window closed mid-take. */
  const refreshSavedTakes = useCallback(async () => { try { const takes = await listSavedTakes(); if (mounted.current) setSavedTakes(takes); } catch { /* an older server: nothing to offer */ } }, []);
  useEffect(() => { void refreshSavedTakes(); }, [refreshSavedTakes]);
  /** Make a saved take a new video from what reached the Studio, followed like a finished take. */
  const recoverSaved = useCallback(async (takeId: string) => {
    const saved = savedTakes.find(item => item.id === takeId);
    const id = crypto.randomUUID();
    const session: RecordingSession = { id, status: 'finalizing', createdAt: saved?.createdAt ?? new Date().toISOString(), camera: !!saved?.tracks.some(track => track.role === 'camera'), microphone: !!saved?.tracks.some(track => track.role === 'microphone'), elapsedMs: Math.round((saved?.seconds ?? 0) * 1000), step: 'Bringing back your recording' };
    setSessions(all => [session, ...all].slice(0, 20)); setSelectedId(id); setSavedTakes(all => all.filter(item => item.id !== takeId));
    try {
      const answer = await recoverSavedTake(takeId, view => patch(id, { step: view.step, progress: view.progress, ...(view.note ? { note: view.note } : {}) }), () => mounted.current);
      if (answer.recording.status !== 'done') return;
      const view = answer.recording;
      patch(id, { status: 'completed', step: undefined, ...(view.projectId ? { projectId: view.projectId } : {}), ...(view.screenAssetId ? { screenAssetId: view.screenAssetId } : {}), ...(view.voiceAssetId ? { voiceAssetId: view.voiceAssetId } : {}), ...(view.note ? { note: view.note } : {}) });
    } catch (cause) { patch(id, { status: 'failed', step: undefined, error: message(cause) }); void refreshSavedTakes(); }
  }, [patch, refreshSavedTakes, savedTakes]);
  /** Throw a saved take away for good. */
  const discardSaved = useCallback(async (takeId: string) => { try { await discardSavedTake(takeId); if (mounted.current) setSavedTakes(all => all.filter(item => item.id !== takeId)); } catch (cause) { if (mounted.current) setError(message(cause)); } }, []);
  /** A partial take kept apart from a video does not exist with this recorder (a stopped take is always the whole take). */
  const openPartial = useCallback(async (id: string): Promise<EditorProject | null> => { void id; return null; }, []);

  return { recorderState, targets, permissions, browserDevices, share, sessions, selected, active, selectedId, setSelectedId, loadingTargets, working, error, uploads, liveTracks, savedTakes,
    refreshTargets, refreshSessions, checkPermissions, requestPermissions, unlockDevices, chooseShare, clearShare, start, stop, cancel, retry, mark, openPartial, refreshSavedTakes, recoverSaved, discardSaved };
}
export type ManualRecording = ReturnType<typeof useManualRecording>;
