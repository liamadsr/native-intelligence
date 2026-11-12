import React, { useEffect, useMemo, useRef, useState } from 'react';
import { clockLabel, openCameraPreview, type DesktopApp, type DesktopDisplay, type DeviceOption, type RecorderPermissionName, type ScreenChoice, type TakePlacement } from '../record';
import { request } from './client';
import type { ManualRecording, RecordingSession, RecordingStart } from './useManualRecording';

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

const glyphs: Record<string, React.ReactNode> = {
  app: <><rect x="3" y="4.5" width="18" height="13" rx="2"/><path d="M8 20.5h8M3 8.5h18"/></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></>,
  camera: <><rect x="3" y="6.5" width="13" height="11" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3"/></>,
  prompter: <><rect x="3" y="3.5" width="18" height="17" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></>,
};
function Glyph({ name }: { name: keyof typeof glyphs }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{glyphs[name]}</svg>;
}
function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <label className="rec-switch" title={label}><input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span aria-hidden="true" /></label>;
}
function Card({ icon, title, detail, on, action, children }: { icon: keyof typeof glyphs; title: string; detail?: string; on?: boolean; action?: React.ReactNode; children?: React.ReactNode }) {
  return <section className={`rec-card${on === false ? ' rec-off' : ''}`}><header><span className="rec-icon" aria-hidden="true"><Glyph name={icon} /></span><div><strong>{title}</strong>{detail ? <small>{detail}</small> : null}</div>{action}</header>{children}</section>;
}
function Meter({ level }: { level: number | null | undefined }) {
  return <span className="rec-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level ?? 0}><span style={{ width: `${Math.round((level ?? 0) * 100)}%` }} /></span>;
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
  return failure ? <small className="rec-hint">{failure}</small> : <div className="rec-camera-preview"><video ref={video} autoPlay muted playsInline aria-label="Camera preview" /></div>;
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

export function ManualRecordPanel(props: Props) {
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
  const live = !!session && !terminal(session);
  const locked = rec.working || !!rec.active;
  // What to record (desktop): displays and windows from the native list.
  const options = useMemo(() => rec.targets ? screenOptions(rec.targets.displays, rec.targets.apps) : [], [rec.targets]);
  const optionKey = rec.targets ? rememberedKey(options, rec.targets.apps, prefs.screenKey) : '';
  const option = options.find(item => item.key === optionKey);
  const chooseScreen = (key: string) => { const picked = options.find(item => item.key === key); const app = picked?.choice.kind === 'window' ? rec.targets?.apps.find(item => item.windows.some(w => w.windowId === (picked.choice as { windowId: number }).windowId)) : undefined;
    setPrefs({ screenKey: app ? `app:${app.bundleId}` : key }); };
  const groups = useMemo(() => [...new Set(options.map(item => item.group))], [options]);
  // Teleprompter: the scripts (newest first), or the beats' own lines when recording into beats.
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  useEffect(() => { void request<{ scripts: ScriptSummary[] }>('/api/account/studio/scripts').then(result => setScripts(result.scripts ?? [])).catch(() => {}); }, []);
  const [appTitle] = useState(() => typeof document === 'undefined' ? '' : document.title);
  // A teleprompter in this window is only worth showing when this window is not in the picture.
  const prompterAllowed = kind === 'desktop' ? !!option && option.choice.kind === 'window' && !option.ownApp
    : kind === 'browser' && !!rec.share && (rec.share.surface === 'browser' || rec.share.surface === 'window' && (!appTitle || !rec.share.label.includes(appTitle)));
  const script = scripts.find(item => item.id === prefs.scriptId) ?? null;
  const lines = props.punch?.prompter?.length ? props.punch.prompter : script?.beats ?? [];
  const showPrompter = prompterAllowed && lines.length > 0;
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

  if (session && live) {
    const recording = session.status === 'recording';
    return <div className="manual-record-panel rec-live" role="status">
      <div className="rec-live-indicator"><span className={recording ? 'rec-dot pulsing' : 'rec-dot idle'} /><strong>{session.status === 'preparing' ? 'Getting ready' : session.status === 'countdown' ? `Starting in ${Math.max(1, session.countdownRemaining ?? 1)}…` : recording ? `Recording · ${clockLabel(session.elapsedMs)}` : 'Finishing…'}</strong></div>
      {recording && session.microphone ? <Meter level={session.level} /> : null}
      <p>{session.status === 'preparing' ? (kind === 'browser' ? 'If the browser asks for the camera or microphone, allow it.' : 'Getting the screen, camera and microphone ready.')
        : session.status === 'countdown' ? (kind === 'desktop' ? 'Switch to what you are recording. The floating Stop bar stays on top and out of the picture.' : 'Switch to what you are sharing. Stop here, or end the share from the browser’s own bar.')
        : recording ? (kind === 'desktop' ? 'Use your app normally: your clicks and typing are timed for zooms. Stop from the floating bar or here.' : 'Use what you are sharing. Come back here to stop, or end the share from the browser’s bar.')
        : session.step ?? 'Saving your recording. It opens in the editor when it is ready.'}</p>
      {showPrompter && (recording || session.status === 'countdown') ? <Prompter lines={lines} recording={recording} mark={rec.mark} /> : null}
      {session.status === 'finalizing' && rec.uploads.length ? <ul className="rec-uploads">{rec.uploads.map(item => <li key={item.role}><span>{item.label}</span><span className="rec-upload-bar"><span style={{ width: `${Math.round(item.fraction * 100)}%` }} /></span><small>{item.done ? 'Uploaded' : `${Math.round(item.fraction * 100)}%`}</small></li>)}</ul> : null}
      <div className="rec-live-actions">
        {session.status === 'preparing' || session.status === 'countdown' ? <button onClick={() => void rec.cancel(session.id)}>Cancel</button> : null}
        {recording ? <><button disabled={rec.working} onClick={() => void rec.cancel(session.id)}>Cancel and discard</button><button className="rec-stop" disabled={rec.working} onClick={() => void rec.stop(session.id)}><span className="rec-square" />Stop recording</button></> : null}
      </div>
    </div>;
  }

  return <div className="manual-record-panel">
    {props.punch ? <div className="rec-punch" role="status"><span className="rec-punch-dot" /><div><strong>{props.punch.beatIds?.length ? 'Record into beats' : 'Punch in'}</strong><span>{props.punch.label}</span></div></div> : null}
    {session && terminal(session) && session.status !== 'cancelled' && (!props.punch || session.punch) ? <div className={`rec-result ${session.status === 'completed' ? 'ok' : 'warn'}`} role="status">
      <div><strong>{session.status === 'completed' ? (session.punch ? 'Take placed' : 'Recording ready') : 'The recording was not saved'}</strong>
        <span>{session.error ?? session.note ?? (session.status === 'completed' ? (session.punch ? 'Placed in your edit.' : 'Saved as a new video.') : 'Try again.')}</span></div>
      {session.status === 'completed' && session.projectId ? <button className="primary" disabled={rec.working} onClick={() => props.open(session)}>Open in editor</button> : null}
      {session.retry ? <><button className="primary" disabled={rec.working} onClick={() => void rec.retry(session.id)}>Try again</button><button disabled={rec.working} onClick={() => void rec.cancel(session.id)}>Discard</button></> : null}
    </div> : null}

    {kind === 'checking' ? <p className="rec-intro">Getting the recorder ready…</p> : null}
    {kind === 'unavailable' ? <div className="rec-permission" role="alert"><strong>Recording isn't available here</strong><span>{rec.recorderState.state === 'unavailable' ? rec.recorderState.reason : ''}</span></div> : null}
    {kind === 'desktop' && missing.length ? <div className="rec-permission" role="alert">
      <strong>{blocking ? `Native Intelligence needs ${missing.filter(name => name !== 'accessibility' && name !== 'inputMonitoring').map(name => PERMISSION_NAMES[name]).join(', ').replace(/, ([^,]*)$/, ' and $1')} access` : 'Turn on Accessibility or Input Monitoring for precise zooms'}</strong>
      <span>{blocking ? 'macOS asks the app that records. Click Grant and allow Native Intelligence in each prompt' : 'Recording works without it, but your clicks and typing are not timed for zooms and the cursor'}{missing.includes('screenRecording') ? ', then quit and reopen Native Intelligence.' : '.'}</span>
      <div><button className="primary" disabled={rec.working} onClick={() => void rec.requestPermissions(missing)}>{rec.working ? 'Opening Settings…' : 'Grant'}</button><button onClick={() => void rec.checkPermissions()}>Check again</button></div>
    </div> : null}
    {kind === 'desktop' || kind === 'browser' ? <>
    <p className="rec-intro">{kind === 'browser' ? 'Record a tab, a window or your whole screen, with your camera and voice. The browser asks you to allow each one.' : 'Record a window or a display with your camera and voice in one take. You choose what is on screen afterwards.'}</p>

    <div className="rec-grid">
      {kind === 'desktop' ? <Card icon="app" title="Screen" detail={option ? option.detail : 'Window or display to record'}
        action={<button className="rec-icon-button" aria-label="Refresh windows and displays" title="Refresh windows and displays" disabled={locked || rec.loadingTargets} onClick={() => void rec.refreshTargets()}>{rec.loadingTargets ? '…' : '↻'}</button>}>
        <select aria-label="What to record" value={option?.key ?? ''} disabled={locked || rec.loadingTargets} onChange={event => chooseScreen(event.target.value)}>
          {options.length ? <>{!option ? <option value="">Choose a window or display…</option> : null}
            {groups.map(group => <optgroup key={group} label={group}>{options.filter(item => item.group === group).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</optgroup>)}</>
            : <option value="">{rec.loadingTargets ? 'Finding windows…' : 'No windows found'}</option>}
        </select>
        <small className="rec-hint">{option?.ownApp ? 'This is Native Intelligence itself: this dialog shows in the picture until you switch away.' : option?.choice.kind === 'display' ? 'Everything on this display is recorded.' : 'Only this window is recorded; your clicks and typing drive auto-zooms.'}</small>
        <label className="rec-check"><input type="checkbox" checked={prefs.systemAudio} disabled={locked} onChange={event => setPrefs({ systemAudio: event.target.checked })} /><span>Record the computer's sound</span></label>
      </Card> : <Card icon="app" title="Screen" detail={rec.share ? (rec.share.surface === 'browser' ? 'A browser tab' : rec.share.surface === 'window' ? 'A window' : rec.share.surface === 'monitor' ? 'Your whole screen' : 'Shared') : 'A tab, window or screen'}>
        {rec.share ? <div className="rec-share"><span title={rec.share.label}>{rec.share.surface === 'monitor' ? 'Entire screen' : rec.share.label || 'Shared'}</span><button disabled={locked} onClick={() => void rec.chooseShare(prefs.shareSound)}>Change…</button><button disabled={locked} onClick={() => rec.clearShare()}>Stop sharing</button></div>
          : <button className="rec-import" disabled={locked} onClick={() => void rec.chooseShare(prefs.shareSound)}>Choose what to share…</button>}
        <label className="rec-check"><input type="checkbox" checked={prefs.shareSound} disabled={locked} onChange={event => setPrefs({ shareSound: event.target.checked })} /><span>Include the tab's or computer's sound</span></label>
        <small className="rec-hint">{rec.share ? (rec.share.hasAudio ? 'Its sound is recorded too.' : 'No sound comes with this share.') : 'Opens the browser’s picker. Nothing is recorded until you press Start.'}</small>
      </Card>}

      <Card icon="mic" title="Microphone" on={prefs.microphone} detail={prefs.microphone ? 'Narration' : 'Off'}
        action={<Switch label="Record microphone narration" checked={prefs.microphone} disabled={locked} onChange={microphone => setPrefs({ microphone })} />}>
        <select aria-label="Microphone" value={microphoneId} disabled={locked || !prefs.microphone} onChange={event => setPrefs({ microphoneId: event.target.value })}>
          <option value="">System default{microphones.find(item => item.isDefault) ? ` (${microphones.find(item => item.isDefault)!.name})` : ''}</option>
          {microphones.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {unnamed ? <button className="rec-link" disabled={locked} onClick={() => void rec.unlockDevices(prefs.camera, prefs.microphone)}>Show device names</button> : null}
      </Card>

      <Card icon="camera" title="Camera" on={prefs.camera} detail={prefs.camera ? 'Movable bubble' : 'Off'}
        action={<Switch label="Record the camera as a movable bubble" checked={prefs.camera} disabled={locked} onChange={camera => setPrefs({ camera })} />}>
        <select aria-label="Camera" value={cameraId} disabled={locked || !prefs.camera} onChange={event => setPrefs({ cameraId: event.target.value })}>
          <option value="">System default{cameras.find(item => item.isDefault) ? ` (${cameras.find(item => item.isDefault)!.name})` : ''}</option>
          {cameras.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {prefs.camera && !locked ? <CameraPreview deviceId={cameraId || null} /> : null}
      </Card>

      {prompterAllowed ? <Card icon="prompter" title="Teleprompter" on={lines.length > 0} detail={lines.length ? `${lines.length} lines` : 'Optional'}>
        {props.punch?.prompter?.length ? <small className="rec-hint">The beats' own lines, one at a time. Next line marks where each beat starts in the take.</small>
          : scripts.length ? <select aria-label="Teleprompter script" value={script?.id ?? ''} disabled={locked} onChange={event => setPrefs({ scriptId: event.target.value })}>
            <option value="">No teleprompter</option>{scripts.map(item => <option key={item.id} value={item.id}>{item.title} · {item.beats.length} lines</option>)}
          </select> : <small className="rec-hint">Ask the assistant to write a script for this video; it shows up here.</small>}
        {lines.length ? <small className="rec-hint">Shown in this window while you record, out of the picture. First line: "{lines[0]!.text.slice(0, 70)}{lines[0]!.text.length > 70 ? '…' : ''}"</small> : null}
      </Card> : null}
    </div>

    {rec.error ? <p className="rec-error" role="alert">{rec.error}</p> : null}
    <button className="rec-start" disabled={!ready || locked} onClick={begin}><span className="rec-dot" />Start recording</button>
    <p className="rec-foot">{kind === 'browser' ? (rec.share ? '3-second countdown, then use what you shared. Stop here or from the browser’s sharing bar.' : 'Choose what to share first.') : '3-second countdown, then use your app. Stop from the floating bar, which stays out of the recording.'}</p>
    </> : null}
  </div>;
}
