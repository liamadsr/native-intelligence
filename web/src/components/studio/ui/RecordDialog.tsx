import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icons';
import { clockLabel, openCameraPreview, recentRecordings, type DesktopApp, type LiveTrackStatus, type RecordingView, type DesktopDisplay, type DeviceOption, type RecorderPermissionName, type ScreenChoice, type TakePlacement } from '../record';
import { request } from './client';
import { Modal, StudioSelect } from './controls';
import type { ManualRecording, RecordingSession, RecordingStart } from './useManualRecording';
import { plainStep } from './record-steps';

/*
 * The Record dialog: what to record, then the take while it records, then the take while it is saved.
 *
 * Setting up reads top to bottom as the steps go: the one first step (choose what to share, or which window or
 * display), then the other sources as a list of rows (each with its switch on the right, its device revealed when it
 * is on), then one action, Start, with what still stands in its way said beside it. Recording shows the time, the
 * microphone's level and Stop. Saving shows each file's progress. Styles: the "Record dialog" section of studio.css
 * (`rd-`). The recorder itself is ../record and ./useManualRecording.
 */

/** A take for the open edit: replaces fromFrame..toFrame (equal = inserted there), or goes into storyboard beats. */
export type PunchTarget = { projectId: string; fromFrame: number; toFrame: number; label: string; deckId?: string;
  /** Recording into storyboard beats: their ids, and their lines for the teleprompter. */
  beatIds?: string[]; prompter?: { text: string; seconds?: number; label?: string }[] };
type Props = {
  /** The open project's Storyboard inputs: the dialog shows and changes the same main camera (one source of truth). */
  cameraInputs?: { main: string | null; extras: string[] } | null;
  setCameraInputs?: (main: { id: string; name: string } | null, extras: { id: string; name: string }[]) => void;
  recording: ManualRecording;
  /** Set when recording a punch-in (or storyboard beats) for the open edit. */
  punch?: PunchTarget | null;
  start: (options: RecordingStart) => Promise<void>;
  open: (session: RecordingSession) => void;
};

const prefsKey = 'ni:studio:record-prefs-v1';
type Prefs = { microphone: boolean; microphoneId: string; camera: boolean; cameraId: string; scriptId: string; screenKey: string; systemAudio: boolean; shareSound: boolean };
const defaults: Prefs = { microphone: true, microphoneId: '', camera: true, cameraId: '', scriptId: '', screenKey: '', systemAudio: false, shareSound: true };
type ScriptSummary = { id: string; title: string; beats: { text: string; seconds?: number; label?: string }[]; updatedAt: string };
/** One camera choice everywhere: the Record dialog and the Storyboard inputs keep the same main camera. */
export function rememberCameras(mainId: string | null, extraIds: string[]) {
  void extraIds;
  try { const next = { ...readPrefs(), camera: !!mainId, cameraId: mainId ?? '' }; localStorage.setItem(prefsKey, JSON.stringify(next)); } catch { /* preference only */ }
}
function readPrefs(): Prefs { try { return { ...defaults, ...JSON.parse(localStorage.getItem(prefsKey) ?? '{}') as Partial<Prefs> }; } catch { return defaults; } }
const terminal = (session: RecordingSession) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(session.status);
/** The app's own windows: recording them would put this dialog (and a teleprompter) in the picture. */
const ownApp = (app: { bundleId: string; appName: string }) => /dial8|nativeintelligence|native-intelligence/i.test(app.bundleId) || /^Native Intelligence/i.test(app.appName);
const PERMISSION_NAMES: Record<RecorderPermissionName, string> = { screenRecording: 'Screen Recording', accessibility: 'Accessibility', inputMonitoring: 'Input Monitoring', camera: 'Camera', microphone: 'Microphone' };

type ScreenOption = { key: string; group: string; label: string; detail: string; choice: ScreenChoice; ownApp: boolean };
/** The desktop picker's rows: each display, then every app's windows (by app name). */
export function screenOptions(displays: DesktopDisplay[], apps: DesktopApp[]): ScreenOption[] {
  const rows: ScreenOption[] = displays.map(display => ({ key: `display:${display.displayId}`, group: 'Displays', label: display.name || 'Display', detail: display.width && display.height ? `Whole display · ${display.width} × ${display.height}` : 'Whole display', choice: { kind: 'display', displayId: display.displayId }, ownApp: false }));
  for (const app of apps) for (const window of app.windows) rows.push({ key: `window:${window.windowId}`, group: app.appName, label: !window.title || window.title === app.appName ? app.appName : window.title, detail: `${app.appName} window`, choice: { kind: 'window', windowId: window.windowId }, ownApp: ownApp(app) });
  return rows;
}
/** The remembered choice: the same display, or a window of the same app (window ids change between launches). */
function rememberedKey(options: ScreenOption[], apps: DesktopApp[], saved: string): string {
  if (options.some(option => option.key === saved)) return saved;
  const bundle = saved.startsWith('app:') ? saved.slice(4) : '';
  const app = bundle ? apps.find(item => item.bundleId === bundle && item.windows.length) : undefined;
  if (app) return `window:${app.windows[0]!.windowId}`;
  return options.find(option => option.choice.kind === 'display')?.key ?? options[0]?.key ?? '';
}

/** One source in the list: icon, name and state on the left, its switch (or other control) on the right; its device below when on. */
function SourceRow({ icon, name, state, control, off, children }: { icon: IconName; name: string; state: React.ReactNode; control?: React.ReactNode; off?: boolean; children?: React.ReactNode }) {
  return <li className={cn('rd-source', off && 'rd-off')}>
    <div className="rd-source-head">
      <span className="rd-source-icon" aria-hidden="true"><Icon name={icon} /></span>
      <div className="rd-source-text"><span className="rd-source-name">{name}</span><span className="rd-source-state">{state}</span></div>
      {control ? <div className="rd-source-control">{control}</div> : null}
    </div>
    {children ? <div className="rd-source-detail">{children}</div> : null}
  </li>;
}
/** The app's switch, labelled for a screen reader by the row it sits in. */
function RowSwitch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <Switch className="st-app-switch" aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />;
}
function Meter({ level }: { level: number | null | undefined }) {
  return <span className="rd-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level ?? 0}><span style={{ width: `${Math.round(Math.max(0, Math.min(1, level ?? 0)) * 100)}%` }} /></span>;
}
/** The live camera bubble shown while choosing the camera (never recorded). */
function CameraPreview({ deviceId }: { deviceId: string | null }) {
  const video = useRef<HTMLVideoElement>(null), [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, stream: MediaStream | null = null;
    const element = video.current;
    setFailure(null);
    void openCameraPreview(deviceId).then(opened => { if (!alive) { for (const track of opened.getTracks()) track.stop(); return; } stream = opened; if (element) element.srcObject = opened; })
      .catch(cause => { if (alive) setFailure(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; for (const track of stream?.getTracks() ?? []) track.stop(); if (element) element.srcObject = null; };
  }, [deviceId]);
  return failure ? <small className="rd-note rd-note-warn">{failure}</small> : <div className="rd-camera-preview"><video ref={video} autoPlay muted playsInline aria-label="Camera preview" /></div>;
}
/** The teleprompter while recording: one line at a time, Next and Retake marking the take. */
function Prompter({ lines, recording, mark }: { lines: { text: string; label?: string }[]; recording: boolean; mark: (value: { beat?: number; retake?: number }) => void }) {
  const [index, setIndex] = useState(0), line = lines[Math.min(index, lines.length - 1)];
  if (!line) return null;
  const next = () => { if (index >= lines.length - 1) return; mark({ beat: index + 1 }); setIndex(index + 1); };
  return <div className="rec-prompter" aria-live="polite">
    <span className="rec-prompter-count">{line.label ? `${line.label} · ` : ''}{index + 1} / {lines.length}</span>
    <p>{line.text}</p>
    {lines[index + 1] ? <small>Next: {lines[index + 1]!.text.slice(0, 90)}{lines[index + 1]!.text.length > 90 ? '…' : ''}</small> : null}
    <div className="rec-prompter-actions"><button disabled={!recording || index === 0} onClick={() => setIndex(index - 1)}>Back</button><button disabled={!recording} onClick={() => mark({ retake: index })}>Retake line</button><button className="primary" disabled={!recording || index >= lines.length - 1} onClick={next}>Next line</button></div>
  </div>;
}

/** Each uploading file's icon. */
const ROLE_ICONS: Record<string, IconName> = { screen: 'screen', camera: 'camera', microphone: 'mic', 'system-audio': 'audio' };
/**
 * Each file of the take on its way up: name, bar, how far. Read loosely (the recorder may add fields, and may report
 * while the take still records), so an item needs only a role or a label and a fraction.
 */
function Uploads({ items }: { items: ReadonlyArray<{ role?: string; label?: string; fraction?: number; done?: boolean }> }) {
  return <ul className="rd-uploads" aria-label="Files being saved">{items.map((item, index) => {
    const fraction = Math.max(0, Math.min(1, Number(item.fraction) || 0)), done = !!item.done || fraction >= 1, name = item.label ?? item.role ?? 'File';
    return <li key={item.role ?? index} className={done ? 'rd-upload-done' : undefined}>
      <span className="rd-upload-icon" aria-hidden="true"><Icon name={ROLE_ICONS[item.role ?? ''] ?? 'file'} size={14} /></span>
      <span className="rd-upload-name">{name}</span>
      <span className="rd-upload-bar" role="progressbar" aria-label={`${name} saved`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}><span style={{ width: `${Math.round(fraction * 100)}%` }} /></span>
      <span className="rd-upload-state">{done ? <><Icon name="check" size={14} />Saved</> : `${Math.round(fraction * 100)}%`}</span>
    </li>;
  })}</ul>;
}

/** The dialog. `title` and `close` are the dialog's; the rest is the recorder's. */
export function RecordDialog({ title, close, ...props }: Props & { title: string; close: () => void }) {
  const rec = props.recording, kind = rec.recorderState.state, session = rec.active ?? rec.selected;
  const live = !!session && !terminal(session);
  const description = live ? undefined : kind === 'browser' ? 'Record a tab, a window or your whole screen, with your camera and voice.' : kind === 'desktop' ? 'Record a window or a display, with your camera and voice, in one take.' : undefined;
  return <Modal title={title} description={description} close={close} className="rd-dialog">{live && session ? <LiveTake session={session} close={close} {...props} /> : <Setup {...props} />}</Modal>;
}

/**
 * While a take records, one calm line about where it is: saved as it records, or, only when something is wrong, which
 * track and what happens to it. The person is recording; this is not a dashboard. Null when the recorder does not
 * upload as it records (the Mac app's recorder, an older server).
 */
export function savedLine(tracks: ReadonlyArray<LiveTrackStatus>): { tone: 'ok' | 'quiet' | 'warn'; text: string } | null {
  if (!tracks.length) return null;
  const named = (list: ReadonlyArray<LiveTrackStatus>) => list.map(track => track.label.toLowerCase()).join(' and ');
  const failed = tracks.filter(track => track.state === 'failed'), retrying = tracks.filter(track => track.state === 'retrying');
  const why = failed[0]?.error?.trim().replace(/\.$/, '');
  if (failed.length) return { tone: 'warn', text: `The Studio stopped taking the ${named(failed)}${why ? `: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : ''}. What reached it is kept.` };
  if (retrying.length) { const waiting = Math.round(Math.max(...retrying.map(track => track.unsavedSeconds || 0)));
    return { tone: 'warn', text: `Connection dropped. Kept here${waiting >= 2 ? ` (${waiting} s so far)` : ''}, and it goes up when the connection is back.` }; }
  if (tracks.some(track => track.state === 'local')) return { tone: 'quiet', text: 'Kept on this computer. It uploads after Stop.' };
  if (tracks.some(track => track.state === 'connecting')) return { tone: 'quiet', text: 'Connecting to the Studio…' };
  return { tone: 'ok', text: 'Saved as you record' };
}

/** Prepared on the Studio after the upload: the files are up (or there were none to send from here). */
const uploadsDone = (uploads: ReadonlyArray<{ done?: boolean; fraction?: number }>) => uploads.every(item => item.done || (item.fraction ?? 0) >= 1);

/** Whether a teleprompter can show in this window without being in the picture, and its lines. */
function usePrompter(props: Props, option: ScreenOption | undefined, scriptId: string) {
  const rec = props.recording, kind = rec.recorderState.state;
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  useEffect(() => { void request<{ scripts: ScriptSummary[] }>('/api/account/studio/scripts').then(result => setScripts(result.scripts ?? [])).catch(() => {}); }, []);
  const [appTitle] = useState(() => typeof document === 'undefined' ? '' : document.title);
  const allowed = kind === 'desktop' ? !!option && option.choice.kind === 'window' && !option.ownApp
    : kind === 'browser' && !!rec.share && (rec.share.surface === 'browser' || rec.share.surface === 'window' && (!appTitle || !rec.share.label.includes(appTitle)));
  const script = scripts.find(item => item.id === scriptId) ?? null;
  const lines = props.punch?.prompter?.length ? props.punch.prompter : script?.beats ?? [];
  return { scripts, script, lines, allowed };
}

function LiveTake({ session, close, ...props }: Props & { session: RecordingSession; close: () => void }) {
  const rec = props.recording, kind = rec.recorderState.state;
  // The teleprompter's script is the one chosen while setting up (remembered with the other choices).
  const [prefs] = useState(readPrefs);
  const options = useMemo(() => rec.targets ? screenOptions(rec.targets.displays, rec.targets.apps) : [], [rec.targets]);
  const option = rec.targets ? options.find(item => item.key === rememberedKey(options, rec.targets!.apps, prefs.screenKey)) : undefined;
  const prompter = usePrompter(props, option, prefs.scriptId);
  const recording = session.status === 'recording', finishing = session.status === 'finalizing';
  const uploads = rec.uploads as ReadonlyArray<{ role?: string; label?: string; fraction?: number; done?: boolean }>;
  // Finishing has two parts: the last of the files go up (short when they went up while recording), then the Studio
  // makes them a video, which it finishes on its own whether or not anyone watches.
  const uploading = finishing && (session.step === 'Uploading' || session.step === 'Saving the recording' || (uploads.length > 0 && !uploadsDone(uploads)));
  const preparing = finishing && !uploading, progress = Math.round(Math.max(0, Math.min(1, session.progress ?? 0)) * 100);
  const saved = recording ? savedLine(rec.liveTracks ?? []) : null;
  const says = session.status === 'preparing' ? (kind === 'browser' ? 'If the browser asks for the camera or microphone, allow it.' : 'Getting the screen, camera and microphone ready.')
    : session.status === 'countdown' ? (kind === 'desktop' ? 'Switch to what you are recording. The floating Stop bar stays on top and out of the picture.' : 'Switch to what you are sharing. Stop here, or end the share from the browser’s own bar.')
    : recording ? (kind === 'desktop' ? 'Use your app as usual. Your clicks and typing are timed for zooms. Stop from the floating bar or here.' : 'Use what you are sharing. Come back here to stop, or end the share from the browser’s bar.')
    : uploading ? 'Keep this window open until the files are up.'
    : 'The Studio finishes the video even if you close this. You get a note when it is ready.';
  return <div className="rd-live" role="status">
    <div className={cn('rd-live-hero', `rd-live-${session.status}`)}>
      {session.status === 'countdown' ? <><span className="rd-live-label">Starting in</span><span className="rd-live-big" aria-live="assertive">{Math.max(1, session.countdownRemaining ?? 1)}</span></>
        : recording ? <><span className="rd-live-label"><span className="rd-live-dot" aria-hidden="true" />Recording</span><span className="rd-live-big">{clockLabel(session.elapsedMs)}</span>{session.microphone ? <Meter level={session.level} /> : null}</>
        : uploading ? <><span className="rd-live-label">Saving your recording</span><span className="rd-live-step">Uploading the last of it</span></>
        : preparing ? <><span className="rd-live-label">Making it a video</span><span className="rd-live-step">{plainStep(session.step)}</span>
            <span className="rd-prep" role="progressbar" aria-label="Preparing the video" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${Math.max(3, progress)}%` }} /></span><span className="rd-prep-value">{progress}%</span></>
        : <><span className="rd-live-label">Getting ready</span><span className="rd-live-step">One moment</span></>}
    </div>
    {saved ? <p className={cn('rd-saved', `rd-saved-${saved.tone}`)}><Icon name={saved.tone === 'warn' ? 'warning' : saved.tone === 'ok' ? 'check' : 'refresh'} size={14} />{saved.text}</p> : null}
    <p className="rd-live-says">{says}</p>
    {finishing && session.note ? <p className="rd-saved rd-saved-warn"><Icon name="warning" size={14} />{session.note}</p> : null}
    {prompter.allowed && prompter.lines.length && (recording || session.status === 'countdown') ? <Prompter lines={prompter.lines} recording={recording} mark={rec.mark} /> : null}
    {uploading && uploads.length ? <Uploads items={uploads} /> : null}
    {uploading ? null : <div className="rd-foot rd-foot-live">
      <div className="rd-foot-actions">
        {session.status === 'preparing' || session.status === 'countdown' ? <Button variant="ghost" className="st-app-button" onClick={() => void rec.cancel(session.id)}>Cancel</Button> : null}
        {recording ? <><Button variant="ghost" className="st-app-button" disabled={rec.working} onClick={() => void rec.cancel(session.id)}>Cancel and discard</Button>
          <Button variant="destructive" className="st-app-button rd-stop" disabled={rec.working} onClick={() => void rec.stop(session.id)}><span className="rd-square" aria-hidden="true" />Stop recording</Button></> : null}
        {preparing ? <><span /><Button variant="secondary" className="st-app-button" onClick={close}>Keep working</Button></> : null}
      </div>
    </div>}
  </div>;
}

/** When a saved take was cut off, in a few words: "9:32 AM" today, "Nov 12, 9:32 AM" before. */
const takeTime = (iso: string) => { const at = new Date(iso); if (Number.isNaN(at.getTime())) return 'earlier'; const today = new Date().toDateString() === at.toDateString();
  return at.toLocaleString(undefined, today ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
/** "42 seconds", "3 minutes 12 seconds". */
export const lengthWords = (seconds: number) => { const s = Math.max(0, Math.round(seconds)), m = Math.floor(s / 60), r = s % 60;
  const part = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return m ? (r ? `${part(m, 'minute')} ${part(r, 'second')}` : part(m, 'minute')) : part(r, 'second'); };

/** Recordings the Studio is still making into videos (this tab's, an earlier tab's, before a reload), and their progress. */
function PreparingElsewhere({ open }: { open: (session: RecordingSession) => void }) {
  const [items, setItems] = useState<RecordingView[]>([]), seen = useRef(new Set<string>());
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const all = await recentRecordings();
        if (!alive) return;
        for (const item of all) if (item.status === 'processing') seen.current.add(item.id);
        // Still being made, or made while this dialog was watching it.
        const shown = all.filter(item => item.status === 'processing' || seen.current.has(item.id) && item.status === 'done' && !!item.projectId);
        setItems(shown);
        if (shown.some(item => item.status === 'processing')) timer = setTimeout(() => void read(), 3000);
      } catch { /* an older server: nothing to show */ }
    };
    void read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);
  if (!items.length) return null;
  return <ul className="rd-preparing" aria-label="Recordings being made into videos">{items.map(item => <li key={item.id}>
    <span className="rd-source-icon" aria-hidden="true"><Icon name={item.status === 'done' ? 'done' : 'clip'} /></span>
    <div className="rd-source-text"><span className="rd-source-name">{item.status === 'done' ? 'A recording is ready' : 'A recording is being made into a video'}</span><span className="rd-source-state">{item.status === 'done' ? 'Open it as its own video.' : `${plainStep(item.step)} · ${Math.round(Math.max(0, Math.min(1, item.progress)) * 100)}%`}</span></div>
    {item.status === 'done' && item.projectId ? <Button size="sm" variant="outline" className="st-app-button" onClick={() => open({ id: item.id, status: 'completed', createdAt: '', camera: false, microphone: false, elapsedMs: 0, projectId: item.projectId!, ...(item.screenAssetId ? { screenAssetId: item.screenAssetId } : {}), ...(item.voiceAssetId ? { voiceAssetId: item.voiceAssetId } : {}) })}>Open</Button> : null}
  </li>)}</ul>;
}

function Setup(props: Props) {
  const rec = props.recording, kind = rec.recorderState.state;
  const [prefs, setPrefsState] = useState<Prefs>(defaults);
  useEffect(() => { const saved = readPrefs(), inputs = props.cameraInputs;
    // The project's own inputs win: what the Storyboard inputs say is what this dialog shows.
    setPrefsState(inputs ? { ...saved, camera: !!inputs.main, cameraId: inputs.main ?? '' } : saved); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const cameras: DeviceOption[] = (kind === 'desktop' ? rec.targets?.cameras : rec.browserDevices?.cameras) ?? [];
  const microphones: DeviceOption[] = (kind === 'desktop' ? rec.targets?.microphones : rec.browserDevices?.microphones) ?? [];
  const setPrefs = (patch: Partial<Prefs>) => setPrefsState(current => { const next = { ...current, ...patch }; try { localStorage.setItem(prefsKey, JSON.stringify(next)); } catch { /* preference only */ }
    if (props.setCameraInputs && ('camera' in patch || 'cameraId' in patch)) { const main = next.camera ? (next.cameraId || cameras.find(c => c.isDefault)?.id || '') : '';
      props.setCameraInputs(main ? { id: main, name: cameras.find(c => c.id === main)?.name ?? main } : null, []); }
    return next; });
  const session = rec.active ?? rec.selected;
  const locked = rec.working || !!rec.active;
  // What to record (desktop): displays and windows from the native list.
  const options = useMemo(() => rec.targets ? screenOptions(rec.targets.displays, rec.targets.apps) : [], [rec.targets]);
  const optionKey = rec.targets ? rememberedKey(options, rec.targets.apps, prefs.screenKey) : '';
  const option = options.find(item => item.key === optionKey);
  const chooseScreen = (key: string) => { const picked = options.find(item => item.key === key); const app = picked?.choice.kind === 'window' ? rec.targets?.apps.find(item => item.windows.some(w => w.windowId === (picked.choice as { windowId: number }).windowId)) : undefined;
    setPrefs({ screenKey: app ? `app:${app.bundleId}` : key }); };
  const groups = useMemo(() => [...new Set(options.map(item => item.group))], [options]);
  const prompter = usePrompter(props, option, prefs.scriptId);
  // Permissions (desktop): the screen always; Accessibility and Input Monitoring for the input trace; camera and mic when on.
  const allowed = rec.permissions;
  // Accessibility or Input Monitoring makes the trace precise (either one is enough); a take never needs them.
  const missing = (allowed ? (['screenRecording', ...(allowed.traceFull ? [] : ['accessibility', 'inputMonitoring'] as const), ...(prefs.camera ? ['camera' as const] : []), ...(prefs.microphone ? ['microphone' as const] : [])] as RecorderPermissionName[]).filter(name => allowed[name] !== 'granted') : []);
  const blocking = missing.includes('screenRecording') || prefs.camera && missing.includes('camera') || prefs.microphone && missing.includes('microphone');
  const cameraId = prefs.camera ? (cameras.some(item => item.id === prefs.cameraId) ? prefs.cameraId : '') : '';
  const microphoneId = microphones.some(item => item.id === prefs.microphoneId) ? prefs.microphoneId : '';
  const unnamed = kind === 'browser' && [...cameras, ...microphones].some(item => /^(Camera|Microphone) \d+$/.test(item.name));
  const ready = kind === 'desktop' ? !!option && !blocking : kind === 'browser' ? !!rec.share : false;
  const begin = () => {
    if (!ready || locked) return;
    const screen: ScreenChoice = kind === 'desktop' ? option!.choice : { kind: 'shared' };
    const punch = props.punch;
    const placement: TakePlacement = !punch ? { kind: 'new' } : punch.beatIds?.length ? { kind: 'beats', projectId: punch.projectId, beatIds: punch.beatIds, marks: [] } : { kind: 'punch', projectId: punch.projectId, fromFrame: punch.fromFrame, toFrame: punch.toFrame };
    void props.start({ screen, cameraId: prefs.camera ? (cameraId || null) : false, microphoneId: prefs.microphone ? (microphoneId || null) : false,
      systemAudio: kind === 'desktop' ? prefs.systemAudio : !!rec.share?.hasAudio && prefs.shareSound, countdownSeconds: 3, placement });
  };
  const defaultName = (list: DeviceOption[]) => list.find(item => item.isDefault)?.name;
  // What still stands between the person and Start, said beside it.
  const hint = kind === 'browser' ? (rec.share ? 'A 3 second countdown, then use what you shared.' : 'Choose what to share first.')
    : kind === 'desktop' ? (!option ? 'Choose a window or display first.' : blocking ? 'Allow the access above first.' : 'A 3 second countdown, then use your app.')
    : kind === 'checking' ? 'Getting the recorder ready.' : 'Recording is not available here.';
  const hintId = React.useId();
  const shared = rec.share, sharedName = shared ? (shared.surface === 'monitor' ? 'Entire screen' : shared.label || 'Shared') : '';
  const sharedKind = shared ? (shared.surface === 'browser' ? 'Sharing a browser tab' : shared.surface === 'window' ? 'Sharing a window' : shared.surface === 'monitor' ? 'Sharing your whole screen' : 'Sharing') : '';

  return <div className="rd-setup">
    {(rec.savedTakes ?? []).map(take => <div key={take.id} className="rd-banner rd-banner-warn rd-banner-recover" role="status">
      <Icon name="warning" />
      <div><strong>A recording from {takeTime(take.createdAt)} stopped before it was finished</strong><span>{lengthWords(take.seconds)} {Math.round(take.seconds) === 1 ? 'was' : 'were'} saved on the Studio.</span></div>
      <div className="rd-banner-buttons"><Button size="sm" variant="ghost" className="st-app-button" disabled={rec.working} onClick={() => void rec.discardSaved(take.id)}>Discard</Button><Button size="sm" className="st-app-button" disabled={rec.working || !!rec.active} onClick={() => void rec.recoverSaved(take.id)}>Make it a video</Button></div>
    </div>)}
    <PreparingElsewhere open={props.open} />
    {props.punch ? <div className="rd-banner rd-banner-punch" role="status"><span className="rd-banner-dot" aria-hidden="true" /><div><strong>{props.punch.beatIds?.length ? 'Recording into beats' : 'Punch in'}</strong><span>{props.punch.label}</span></div></div> : null}
    {session && terminal(session) && session.status !== 'cancelled' && (!props.punch || session.punch) ? <div className={cn('rd-banner', session.status === 'completed' ? 'rd-banner-ok' : 'rd-banner-warn')} role="status">
      <Icon name={session.status === 'completed' ? 'done' : 'warning'} />
      <div><strong>{session.status === 'completed' ? (session.punch ? 'Take placed' : 'Recording ready') : 'The recording was not saved'}</strong>
        <span>{session.error ?? session.note ?? (session.status === 'completed' ? (session.punch ? 'Placed in your edit.' : 'Saved as a new video.') : 'Try again.')}</span></div>
      {session.status === 'completed' && session.projectId ? <Button size="sm" className="st-app-button" disabled={rec.working} onClick={() => props.open(session)}>Open in editor</Button> : null}
      {session.retry ? <><Button size="sm" variant="ghost" className="st-app-button" disabled={rec.working} onClick={() => void rec.cancel(session.id)}>Discard</Button><Button size="sm" className="st-app-button" disabled={rec.working} onClick={() => void rec.retry(session.id)}>Try again</Button></> : null}
    </div> : null}

    {kind === 'checking' ? <p className="rd-note">Getting the recorder ready…</p> : null}
    {kind === 'unavailable' ? <div className="rd-banner rd-banner-warn" role="alert"><Icon name="warning" /><div><strong>Recording is not available here</strong><span>{rec.recorderState.state === 'unavailable' ? rec.recorderState.reason : ''}</span></div></div> : null}
    {kind === 'desktop' && missing.length ? <div className="rd-banner rd-banner-warn rd-banner-stack" role="alert">
      <Icon name="warning" />
      <div><strong>{blocking ? `Native Intelligence needs ${missing.filter(name => name !== 'accessibility' && name !== 'inputMonitoring').map(name => PERMISSION_NAMES[name]).join(', ').replace(/, ([^,]*)$/, ' and $1')} access` : 'Turn on Accessibility or Input Monitoring for precise zooms'}</strong>
        <span>{blocking ? 'macOS asks the app that records. Click Grant and allow Native Intelligence in each prompt' : 'Recording works without it, but your clicks and typing are not timed for zooms and the cursor'}{missing.includes('screenRecording') ? ', then quit and reopen Native Intelligence.' : '.'}</span>
        <div className="rd-banner-actions"><Button size="sm" className="st-app-button" disabled={rec.working} onClick={() => void rec.requestPermissions(missing)}>{rec.working ? 'Opening Settings…' : 'Grant'}</Button><Button size="sm" variant="ghost" className="st-app-button" onClick={() => void rec.checkPermissions()}>Check again</Button></div></div>
    </div> : null}

    {kind === 'desktop' || kind === 'browser' ? <>
      {/* Step one: what goes in the picture. */}
      {kind === 'browser' ? (shared
        ? <div className="rd-screen rd-screen-chosen">
            <span className="rd-screen-icon" aria-hidden="true"><Icon name="screen" size={20} /></span>
            <div className="rd-screen-text"><span className="rd-screen-name" title={shared.label}>{sharedName}</span><span className="rd-screen-kind">{sharedKind}</span></div>
            <div className="rd-screen-actions"><Button variant="ghost" size="sm" className="st-app-button" disabled={locked} onClick={() => rec.clearShare()}>Stop sharing</Button><Button variant="outline" size="sm" className="st-app-button" disabled={locked} onClick={() => void rec.chooseShare(prefs.shareSound)}>Change</Button></div>
          </div>
        : <button type="button" className="rd-screen rd-screen-pick" disabled={locked} onClick={() => void rec.chooseShare(prefs.shareSound)}>
            <span className="rd-screen-icon" aria-hidden="true"><Icon name="share" size={20} /></span>
            <span className="rd-screen-text"><span className="rd-screen-name">Choose what to share</span><span className="rd-screen-kind">A tab, a window or your whole screen. Nothing records until you press Start.</span></span>
            <span className="rd-screen-go" aria-hidden="true"><Icon name="chevronRight" /></span>
          </button>)
        : <div className="rd-screen rd-screen-chosen rd-screen-desktop">
            <span className="rd-screen-icon" aria-hidden="true"><Icon name="screen" size={20} /></span>
            <div className="rd-screen-text">
              <StudioSelect size="normal" aria-label="What to record" value={option?.key ?? ''} disabled={locked || rec.loadingTargets} onChange={v => chooseScreen(v)}>
                {options.length ? <>{!option ? <option value="">Choose a window or display…</option> : null}
                  {groups.map(group => <optgroup key={group} label={group}>{options.filter(item => item.group === group).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</optgroup>)}</>
                  : <option value="">{rec.loadingTargets ? 'Finding windows…' : 'No windows found'}</option>}
              </StudioSelect>
              <span className="rd-screen-kind">{option?.ownApp ? 'This is Native Intelligence itself. This dialog shows in the picture until you switch away.' : option?.choice.kind === 'display' ? 'Everything on this display is recorded.' : option ? 'Only this window is recorded. Your clicks and typing drive the zooms.' : 'A window or a whole display.'}</span>
            </div>
            <button type="button" className="rd-icon-button" aria-label="Refresh windows and displays" title="Refresh windows and displays" disabled={locked || rec.loadingTargets} onClick={() => void rec.refreshTargets()}><Icon name="refresh" size={14} /></button>
          </div>}

      {/* The other sources, one row each. */}
      <h3 className="rd-section">Also record</h3>
      <ul className="rd-sources">
        {kind === 'browser'
          ? <SourceRow icon="audio" name="Tab or computer sound" off={!prefs.shareSound}
              state={!prefs.shareSound ? 'Off' : shared ? (shared.hasAudio ? 'Comes with this share' : 'This share has no sound') : 'When the share carries it'}
              control={<RowSwitch label="Include the tab's or computer's sound" checked={prefs.shareSound} disabled={locked} onChange={shareSound => setPrefs({ shareSound })} />} />
          : <SourceRow icon="audio" name="Computer sound" off={!prefs.systemAudio} state={prefs.systemAudio ? 'On' : 'Off'}
              control={<RowSwitch label="Record the computer's sound" checked={prefs.systemAudio} disabled={locked} onChange={systemAudio => setPrefs({ systemAudio })} />} />}
        <SourceRow icon="mic" name="Microphone" off={!prefs.microphone} state={prefs.microphone ? 'Your voice' : 'Off'}
          control={<RowSwitch label="Record your microphone" checked={prefs.microphone} disabled={locked} onChange={microphone => setPrefs({ microphone })} />}>
          {prefs.microphone ? <>
            <StudioSelect size="normal" aria-label="Microphone" value={microphoneId} disabled={locked} onChange={v => setPrefs({ microphoneId: v })}>
              <option value="">System default{defaultName(microphones) ? ` (${defaultName(microphones)})` : ''}</option>
              {microphones.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </StudioSelect>
            {unnamed ? <button type="button" className="rd-link" disabled={locked} onClick={() => void rec.unlockDevices(prefs.camera, prefs.microphone)}>Show device names</button> : null}
          </> : null}
        </SourceRow>
        <SourceRow icon="camera" name="Camera" off={!prefs.camera} state={prefs.camera ? 'A bubble you can move in the edit' : 'Off'}
          control={<RowSwitch label="Record your camera" checked={prefs.camera} disabled={locked} onChange={camera => setPrefs({ camera })} />}>
          {prefs.camera ? <div className="rd-camera">
            <StudioSelect size="normal" aria-label="Camera" value={cameraId} disabled={locked} onChange={v => setPrefs({ cameraId: v })}>
              <option value="">System default{defaultName(cameras) ? ` (${defaultName(cameras)})` : ''}</option>
              {cameras.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </StudioSelect>
            {!locked ? <CameraPreview deviceId={cameraId || null} /> : null}
          </div> : null}
        </SourceRow>
        {prompter.allowed ? <SourceRow icon="prompter" name="Teleprompter" off={!prompter.lines.length} state={prompter.lines.length ? `${prompter.lines.length} lines, shown here while you record` : 'Optional'}>
          {props.punch?.prompter?.length ? <small className="rd-note">The beats’ own lines, one at a time. Next line marks where each beat starts in the take.</small>
            : prompter.scripts.length ? <StudioSelect size="normal" aria-label="Teleprompter script" value={prompter.script?.id ?? ''} disabled={locked} onChange={v => setPrefs({ scriptId: v })}>
              <option value="">No teleprompter</option>{prompter.scripts.map(item => <option key={item.id} value={item.id}>{item.title} · {item.beats.length} lines</option>)}
            </StudioSelect> : <small className="rd-note">Ask the agent to write a script for this video. It shows up here.</small>}
        </SourceRow> : null}
      </ul>
    </> : null}

    {rec.error ? <p className="rd-error" role="alert"><Icon name="warning" size={14} />{rec.error}</p> : null}
    <div className="rd-foot">
      <span className={cn('rd-foot-hint', !ready && 'rd-foot-blocked')} id={hintId}>{hint}</span>
      <div className="rd-foot-actions">
        <Button className="st-app-button rd-start" disabled={!ready || locked} aria-describedby={hintId} onClick={begin}><span className="rd-start-dot" aria-hidden="true" />Start recording</Button>
      </div>
    </div>
  </div>;
}
