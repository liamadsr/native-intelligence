import { studioPortal, studioKeys, studioCan } from '../studio-env';
import { assetHref } from '@/lib/studio/engine/asset-base';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { createPortal } from 'react-dom';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { applyOps } from '@/lib/studio/engine/ops';
import { beatEnd, cameraSlots, isPlaceholder, needsRecording, pictureSources, reorderBeats, sortBeats, StoryboardSchema, wordBudget, type Beat, type BeatSource, type Storyboard, type TrackInputs } from '@/lib/studio/engine/storyboard';
import { request } from './client';
import { rememberCameras } from './ManualRecordPanel';
import { listBrowserDevices, openRecorder, unlockDeviceLabels, type DesktopApp, type DeviceOption } from '../record';
import { nativeRecorderAvailable } from '../record/desktop';

// The Storyboard track: the film's beats in order, on the timeline. Placeholders (beats still waiting for their take)
// are dashed; select one or several in a row and press Record in the track header: a countdown, the teleprompter
// shows those lines, and the take lands in their place. Which camera, window and mic feed the tracks is set once
// in the header (Inputs) and kept with the project.

export const sourceLabel = (source: BeatSource) => source.startsWith('camera:') ? `Camera ${source.slice(7)}` : ({ screen: 'Screen', slides: 'Slides', generated: 'Generated', scene: 'Code scene', component: 'Product UI', broll: 'B-roll' } as Record<string, string>)[source] ?? source;
export const sourceTone = (source: BeatSource) => source === 'camera:A' ? 'var(--st-hue-teal)' : source.startsWith('camera:') ? 'var(--st-hue-sky)' : source === 'screen' ? 'var(--st-hue-amber)' : source === 'generated' ? 'var(--st-hue-orange)' : source === 'component' ? 'var(--st-hue-blue)' : source === 'scene' ? 'var(--st-hue-magenta)' : 'var(--st-text-faint)';
export const statusLabel: Record<Beat['status'], string> = { planned: 'Planned', recorded: 'Recorded', generated: 'Generated', placed: 'Placed', done: 'Done' };
const board = (project: EditorProject): Storyboard => project.storyboard ?? { beats: [] };
const setBoard = (project: EditorProject, next: Storyboard): EditorProject => ({ ...project, storyboard: StoryboardSchema.parse({ ...next, beats: sortBeats(next.beats) }) });

/** Selection that stays contiguous: shift-click extends from the first selected beat to this one. */
export function nextSelection(beats: Beat[], current: string[], id: string, extend: boolean) {
  if (!extend || !current.length) return current.length === 1 && current[0] === id ? [] : [id];
  const order = sortBeats(beats).map(b => b.id), anchor = order.indexOf(current[0]!), at = order.indexOf(id);
  return order.slice(Math.min(anchor, at), Math.max(anchor, at) + 1);
}

export function StoryboardLane({ project, duration, disabled, selected, select, seek, change, frame, notify }: {
  project: EditorProject; duration: number; disabled: boolean; selected: string[]; select: (ids: string[]) => void; seek: (frame: number) => void;
  change?: (fn: (p: EditorProject) => EditorProject) => void; frame: number; notify?: (text: string, error?: boolean) => void;
}) {
  const beats = board(project).beats, fps = project.output.fps;
  const [busy, setBusy] = useState(false);
  // Drag a beat sideways to put it elsewhere in the order (planned beats; ones with footage stay put).
  const drag = useRef<{ id: string; x: number; moved: boolean; lane: DOMRect } | null>(null), [dropAt, setDropAt] = useState<number | null>(null);
  const orderFor = (id: string, clientX: number, lane: DOMRect) => { const sorted = sortBeats(beats), frameAt = (clientX - lane.left) / lane.width * duration;
    const rest = sorted.filter(b => b.id !== id), index = rest.filter(b => b.startFrame + b.durationFrames / 2 < frameAt).length;
    return [...rest.slice(0, index).map(b => b.id), id, ...rest.slice(index).map(b => b.id)]; };
  const onDown = (event: React.PointerEvent<HTMLButtonElement>, id: string) => { if (!change || disabled || event.button !== 0) return;
    drag.current = { id, x: event.clientX, moved: false, lane: (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect() }; event.currentTarget.setPointerCapture(event.pointerId); };
  const onMove = (event: React.PointerEvent<HTMLButtonElement>) => { const d = drag.current; if (!d) return; if (!d.moved && Math.abs(event.clientX - d.x) < 6) return; d.moved = true;
    setDropAt(Math.max(0, Math.min(1, (event.clientX - d.lane.left) / d.lane.width))); };
  const onUp = (event: React.PointerEvent<HTMLButtonElement>) => { const d = drag.current; drag.current = null; setDropAt(null); if (!d?.moved || !change) return;
    const order = orderFor(d.id, event.clientX, d.lane); if (order.join() === sortBeats(beats).map(b => b.id).join()) return;
    try { const next = reorderBeats(board(project), order); change(p => setBoard(p, next)); } catch (error) { notify?.(error instanceof Error ? error.message : String(error), true); } };
  const fromScript = async () => { if (!change) return; setBusy(true); try { await startFromScript(project, change, frame, duration); } finally { setBusy(false); } };
  const addBeat = () => { if (change) addBeatAt(change, frame, duration, fps); };
  return <div data-head="storyboard" className="storyboard-lane" role="group" aria-label="Storyboard track: the video's beats">
    {!beats.length ? <span className="storyboard-empty">{change ? <><button disabled={disabled || busy} onClick={() => void fromScript()}>Start from the script</button><button disabled={disabled} onClick={addBeat}><Icon name="plus" size={14}/>Beat at playhead</button><small>Beats are the video's plan: words, which camera, what's on screen. Record into them.</small></> : 'No storyboard'}</span> : null}
    {beats.map((beat, index) => { const on = selected.includes(beat.id), placeholder = isPlaceholder(beat), budget = wordBudget(beat, fps);
      return <button key={beat.id} className={`beat-block status-${beat.status} ${placeholder ? 'placeholder' : ''} ${on ? 'selected' : ''}`} disabled={disabled}
        style={{ left: `${beat.startFrame / duration * 100}%`, width: `${beat.durationFrames / duration * 100}%`, ['--beat-tone' as string]: sourceTone(beat.source) }}
        aria-pressed={on} title={`${index + 1}. ${beat.label ?? sourceLabel(beat.source)} · ${(beat.durationFrames / fps).toFixed(1)} s · ${statusLabel[beat.status]}${placeholder ? ' · waiting for its take' : ''}${beat.locked ? ' · locked' : ''}\n${beat.words}${budget.over ? `\n(${budget.over} words over what ${(beat.durationFrames / fps).toFixed(1)} s holds)` : ''}`}
        onPointerDown={event => onDown(event, beat.id)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { drag.current = null; setDropAt(null); }}
        onClick={event => { if (dropAt !== null) return; select(nextSelection(beats, selected, beat.id, event.shiftKey)); }} onDoubleClick={() => seek(beat.startFrame)}>
        <span className="beat-top"><b>{index + 1}</b><span className="beat-label">{beat.label ?? sourceLabel(beat.source)}</span>{beat.locked ? <i className="beat-lock" aria-label="Locked" title="Locked"><Icon name="lock" size={10}/></i> : null}
          {placeholder ? <i className="beat-rec" aria-label="Needs recording">●</i> : beat.status !== 'planned' ? <i className="beat-done" aria-label={statusLabel[beat.status]} title={statusLabel[beat.status]}><Icon name="check" size={12}/></i> : null}</span>
        <span className="beat-words">{beat.words || <em>{sourceLabel(beat.source)}</em>}</span>
        {beat.generation?.stillAssetId ? (() => { const a = project.assets.find(x => x.id === beat.generation!.stillAssetId); return a ? <img className="beat-thumb" src={assetHref(a.file)} alt="" /> : null; })() : null}
      </button>; })}
    {dropAt !== null ? <i className="beat-drop" style={{ left: `${dropAt * 100}%` }} aria-hidden="true" /> : null}
  </div>;
}

/** A beat at the playhead (up to 4 s, up to the next beat), unless one is already there. */
export function addBeatAt(change: (fn: (p: EditorProject) => EditorProject) => void, frame: number, duration: number, fps: number) {
  change(p => { const at = Math.min(frame, duration - 1), next = sortBeats(board(p).beats).find(b => b.startFrame > at), end = Math.min(duration, next?.startFrame ?? duration, at + Math.round(4 * fps));
    if (board(p).beats.some(b => at >= b.startFrame && at < beatEnd(b)) || end <= at) return p;
    return applyOps(p, [{ op: 'add_beat', args: { at: at / fps, seconds: (end - at) / fps } }]).project; });
}
/** Beats from this project's script (scripts/<id>), or one beat at the playhead when there's no script. */
export async function startFromScript(project: EditorProject, change: (fn: (p: EditorProject) => EditorProject) => void, frame: number, duration: number) {
  try { const { scripts } = await request<{ scripts: { id: string; beats: { text: string; seconds?: number; label?: string }[] }[] }>('/api/account/studio/scripts'); const script = scripts.find(s => s.id === project.id);
    if (!script) { addBeatAt(change, frame, duration, project.output.fps); return; }
    change(p => applyOps(p, [{ op: 'storyboard_from_script', args: { at: 0, lines: script.beats } }]).project); }
  catch { /* the storyboard stays empty; nothing to undo */ }
}
/** Where a floating panel sits: above its anchor (track header at the bottom) or below it (a toolbar at the top). */
const panelAt = (anchor: HTMLElement | null, below?: boolean): React.CSSProperties | undefined => { const box = anchor?.getBoundingClientRect(); if (!box) return undefined;
  return below ? { left: Math.max(8, Math.min(box.left, window.innerWidth - 340)), top: box.bottom + 8 } : { left: Math.max(8, box.left), top: Math.max(8, box.top - 8), transform: 'translateY(-100%)' }; };

/** Track header: Record the selected beats, and Inputs (which device feeds which track). */
export function StoryboardHead({ project, selected, record, change, recording, beforeServerEdit, afterServerEdit }: {
  project: EditorProject; selected: string[]; record?: (ids: string[]) => void; change?: (fn: (p: EditorProject) => EditorProject) => void; recording: boolean;
  beforeServerEdit?: () => Promise<boolean>; afterServerEdit?: () => void;
}) {
  const [open, setOpen] = useState(false), [history, setHistory] = useState(false), [cast, setCast] = useState(false), anchor = useRef<HTMLButtonElement>(null), historyAnchor = useRef<HTMLButtonElement>(null), castAnchor = useRef<HTMLButtonElement>(null);
  const beats = board(project).beats, chosen = beats.filter(b => selected.includes(b.id)), recordable = chosen.some(needsRecording);
  const browserPicks = useBrowserChoosesScreen(), inputs = board(project).inputs, missing = !inputs?.screen && !browserPicks, spent = Math.round(beats.reduce((n, b) => n + (b.generation?.spentCredits ?? 0), 0) * 100) / 100;
  const label = !chosen.length ? 'Select beats to record' : !recordable ? 'These beats have nothing to record' : `Record ${chosen.length === 1 ? 'this beat' : `${chosen.length} beats`}: countdown, then the teleprompter shows their lines`;
  return <>
    <div className="th-row"><span className="th-chip storyboard" /><span className="th-name">Storyboard</span>
      <button className="th-btn rec" disabled={!record || recording || !recordable} title={label} aria-label={label} onClick={() => missing ? setOpen(true) : record?.(chosen.map(b => b.id))}><Icon name="record" size={14}/></button>
      <button ref={anchor} className={`th-btn ${open ? 'on' : ''}`} title="Inputs: which camera, window and microphone feed the tracks" aria-label="Recording inputs" aria-expanded={open} disabled={!change} onClick={() => setOpen(v => !v)}><Icon name="settings" size={14}/></button>
      <button ref={castAnchor} className={`th-btn ${cast ? 'on' : ''}`} title="Cast: people, props and places for generated shots" aria-label="Cast" aria-expanded={cast} disabled={!change} onClick={() => setCast(v => !v)}><Icon name="people" size={14}/></button>
      <button ref={historyAnchor} className={`th-btn ${history ? 'on' : ''}`} title="Earlier versions of the storyboard (one before each change the agent makes)" aria-label="Storyboard versions" aria-expanded={history} disabled={!beforeServerEdit} onClick={() => setHistory(v => !v)}><Icon name="history" size={14}/></button></div>
    <span className="th-sub">{beats.length ? `${beats.filter(isPlaceholder).length} to record · ${chosen.length ? `${chosen.length} selected` : 'shift-click for several'}${spent ? ` · ${spent} credits spent` : ''}` : 'No beats yet'}</span>
    {open && change ? createPortal(<InputsPanel project={project} change={change} close={() => setOpen(false)} anchor={anchor.current} />, studioPortal()) : null}
    {cast && change ? createPortal(<CastPanel project={project} change={change} close={() => setCast(false)} anchor={castAnchor.current} />, studioPortal()) : null}
    {history && beforeServerEdit ? createPortal(<VersionsPanel project={project} anchor={historyAnchor.current} close={() => setHistory(false)} beforeServerEdit={beforeServerEdit} afterServerEdit={afterServerEdit} />, studioPortal()) : null}
  </>;
}

/** True when this page records through the browser, whose own picker chooses the screen at record time: there is no screen to set in Inputs first. */
export function useBrowserChoosesScreen(): boolean {
  const [browser, setBrowser] = useState(false);
  useEffect(() => { let alive = true; void nativeRecorderAvailable().then(native => { if (alive) setBrowser(!native); }); return () => { alive = false; }; }, []);
  return browser;
}

/** What Inputs lists: the Record dialog's own source (record/). `apps` null: no screen app to choose (a plain browser's picker chooses at record time). */
type InputLists = { cameras: DeviceOption[]; microphones: DeviceOption[]; apps: DesktopApp[] | null; refused?: string };
/** Ask the recorder this page records with: the Mac app's cameras, microphones and apps, else the browser's devices (`unlock`: ask for them first, so their names show). */
async function inputLists(unlock: boolean): Promise<InputLists> {
  const opened = await openRecorder();
  try {
    if (opened.kind === 'desktop') { const found = await opened.recorder.targets(); return { cameras: found.cameras, microphones: found.microphones, apps: found.apps }; }
    // Camera and microphone, else the microphone alone (no camera, or the camera refused).
    const refused = unlock ? await unlockDeviceLabels(true, true) && await unlockDeviceLabels(false, true) : null;
    return { ...await listBrowserDevices(), apps: null, ...(refused ? { refused } : {}) };
  } finally { if (opened.kind !== 'unavailable') opened.recorder.dispose(); }
}

/** Which real device feeds each track; remembered with the project. */
export function InputsPanel({ project, change, close, anchor, below }: { project: EditorProject; change: (fn: (p: EditorProject) => EditorProject) => void; close: () => void; anchor: HTMLElement | null; below?: boolean }) {
  const [lists, setLists] = useState<InputLists | null>(null), [error, setError] = useState(''), alive = useRef(true);
  const load = useCallback((unlock: boolean) => { void inputLists(unlock).then(found => { if (!alive.current) return; setLists(found); setError(found.refused ?? ''); }).catch(cause => { if (alive.current) setError(String(cause instanceof Error ? cause.message : cause)); }); }, []);
  useEffect(() => { alive.current = true; load(false); return () => { alive.current = false; }; }, [load]);
  // A camera or microphone plugged in or out while Inputs is open.
  useEffect(() => { const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices; if (!media?.addEventListener) return; const changed = () => load(false); media.addEventListener('devicechange', changed); return () => media.removeEventListener('devicechange', changed); }, [load]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; studioKeys.addEventListener('keydown', key); return () => studioKeys.removeEventListener('keydown', key); }, [close]);
  const inputs: TrackInputs = board(project).inputs ?? {};
  const set = (patch: Partial<TrackInputs>) => { change(p => setBoard(p, { ...board(p), inputs: { ...(board(p).inputs ?? {}), ...patch } }));
    // Keep the Record dialog on the same cameras.
    if (patch.cameras !== undefined) rememberCameras(patch.cameras.A?.deviceId ?? null, (['B', 'C', 'D'] as const).flatMap(k => patch.cameras![k] ? [patch.cameras![k]!.deviceId] : [])); };
  const cams = (lists?.cameras ?? []).filter(c => !/Desk View/i.test(c.name)), apps = lists?.apps ? [...new Map(lists.apps.filter(a => a.windows.length).map(a => [a.bundleId, a])).values()] : null;
  return <div className="inputs-panel" role="dialog" aria-label="Recording inputs" style={panelAt(anchor, below)}>
    <header><strong>Inputs</strong><small>Which device feeds each track. Kept with this video.</small><button onClick={() => load(!apps)} aria-label={apps ? 'Look for cameras and windows again' : 'Look for cameras and microphones again'} title={apps ? 'Look for cameras and windows again' : 'Look for cameras and microphones again (the browser may ask to use them, so their names show)'}><Icon name="refresh"/></button><button onClick={close} aria-label="Close" title="Close"><Icon name="close"/></button></header>
    {error ? <p className="inputs-error">{error}</p> : null}
    {cameraSlots.map(slot => { const value = inputs.cameras?.[slot]?.deviceId ?? '';
      return <label key={slot} className="field-label">Camera {slot}{slot === 'A' ? ' · main' : ''}<select value={value} onChange={e => { const device = cams.find(c => c.id === e.target.value);
        const cameras = { ...(inputs.cameras ?? {}) }; if (device) cameras[slot] = { deviceId: device.id, name: device.name }; else delete cameras[slot]; set({ cameras }); }}>
        <option value="">{slot === 'A' ? 'No camera' : 'Not used'}</option>
        {value && !cams.some(c => c.id === value) ? <option value={value}>{inputs.cameras?.[slot]?.name} (not connected)</option> : null}
        {cams.map(c => <option key={c.id} value={c.id} disabled={Object.entries(inputs.cameras ?? {}).some(([s, d]) => s !== slot && d?.deviceId === c.id)}>{c.name}</option>)}</select></label>; })}
    {apps ? <label className="field-label">Screen<select value={inputs.screen?.bundleId ?? ''} onChange={e => { const app = apps.find(a => a.bundleId === e.target.value); set({ screen: app ? { bundleId: app.bundleId, appName: app.appName } : undefined }); }}>
      <option value="">Choose the app to record…</option>
      {inputs.screen?.bundleId && !apps.some(a => a.bundleId === inputs.screen!.bundleId) ? <option value={inputs.screen.bundleId}>{inputs.screen.appName} (not open)</option> : null}
      {apps.map(a => <option key={a.bundleId} value={a.bundleId}>{a.appName}</option>)}</select></label> : null}
    <label className="field-label">Microphone<select value={inputs.microphone?.deviceId ?? ''} onChange={e => { const mic = lists?.microphones.find(m => m.id === e.target.value); set({ microphone: mic ? { deviceId: mic.id, name: mic.name } : undefined }); }}>
      <option value="">System default</option>
      {inputs.microphone?.deviceId && lists && !lists.microphones.some(m => m.id === inputs.microphone!.deviceId) ? <option value={inputs.microphone.deviceId}>{inputs.microphone.name} (not connected)</option> : null}
      {(lists?.microphones ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <label className="field-label">Countdown<select value={String(inputs.countdown ?? 3)} onChange={e => set({ countdown: Number(e.target.value) })}>{[0, 3, 5].map(n => <option key={n} value={n}>{n ? `${n} s` : 'None'}</option>)}</select></label>
    {!lists && !error ? <small>Looking for cameras and windows…</small> : null}
  </div>;
}

/** The selected beat's settings (one beat), in the inspector. */
type Pending = { what: 'still' | 'clip'; final: boolean; model?: string; credits?: number; tried?: { model: string; credits?: number; skipped?: string }[]; error?: string; busy?: boolean; progress?: number; note?: string };
/** A generation job as the editor polls it (the server's EditorJob, its result the filed shot). */
type ShotJob = { id: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; progress: number; logs: string[]; error?: string; result?: { outcome?: string; error?: string; placed?: boolean; placeError?: string } };
/** A beat's generated picture: still first, approved, then a cheap draft clip, then (prompt settled) the final. */
function GenerationSection({ project, beat, patch, beforeServerEdit, afterServerEdit }: { project: EditorProject; beat: Beat; patch: (fields: Partial<Beat>) => void; beforeServerEdit?: () => Promise<boolean>; afterServerEdit?: () => void }) {
  const g = beat.generation ?? {}, [pending, setPending] = useState<Pending | null>(null), cast = board(project).cast ?? [];
  const set = (fields: Partial<NonNullable<Beat['generation']>>) => patch({ generation: { ...g, ...fields } });
  const url = (id?: string) => { const a = project.assets.find(x => x.id === id); return a ? assetHref(a.file) : null; };
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // A spend is a job on the Studio worker (minutes for a clip): followed here like an export until it is filed.
  const follow = async (job: ShotJob, base: Pending) => { for (let j = job; alive.current; ) {
      if (j.status !== 'running') { const r = j.result; if (j.status === 'completed' && r?.outcome === 'made') { setPending(r.placed === false ? { ...base, busy: false, error: r.placeError ?? 'Made, but not placed on the beat.' } : null); afterServerEdit?.(); }
        else setPending({ ...base, busy: false, error: r?.error ?? j.error ?? 'The generation stopped.' }); return; }
      setPending({ ...base, busy: true, progress: j.progress, note: j.logs.at(-1) });
      await new Promise(resolve => setTimeout(resolve, 1500)); j = (await request<{ job: ShotJob }>(`/api/account/studio/jobs/${encodeURIComponent(j.id)}`)).job; } };
  const call = async (what: 'still' | 'clip', final: boolean, confirm?: { model: string; credits: number }) => {
    if (!beforeServerEdit || !await beforeServerEdit()) return;
    setPending({ what, final, busy: true, ...(confirm ? { model: confirm.model, credits: confirm.credits } : {}) });
    try { const out = await request<{ quote?: { model: string; credits: number }; tried?: Pending['tried']; spent?: number }>(`/api/account/studio/projects/${encodeURIComponent(project.id)}/beats/${encodeURIComponent(beat.id)}/generate`, { what, final, ...(confirm ? { confirm } : {}) });
      if (confirm) { const job = (out as { job?: ShotJob }).job; if (job) await follow(job, { what, final, model: confirm.model, credits: confirm.credits }); else { setPending(null); afterServerEdit?.(); } } else setPending({ what, final, model: out.quote!.model, credits: out.quote!.credits, tried: out.tried }); }
    catch (error) { setPending({ what, final, error: error instanceof Error ? error.message : String(error) }); } };
  const stage = g.stage ?? 'planned', canClip = !!g.stillAssetId && stage !== 'still' && stage !== 'planned', canFinal = stage === 'clip' || stage === 'final';
  const label = (p: Pending) => `${p.final ? 'Final' : 'Draft'} ${p.what}`;
  return <section className="beat-generation"><h3>Generation</h3>
    <label className="field-label">Shot prompt<textarea rows={5} value={g.prompt ?? ''} placeholder="The shot structure: scene, references, format, action second by second, camera, light, audio, negatives" onChange={e => set({ prompt: e.target.value || undefined })} /></label>
    {cast.length ? <div className="beat-cast"><small>References</small>{cast.map(c => { const on = (g.references ?? []).includes(c.id);
      return <button key={c.id} className={on ? 'on' : ''} aria-pressed={on} onClick={() => set({ references: on ? (g.references ?? []).filter(r => r !== c.id) : [...(g.references ?? []), c.id] })}>{url(c.assetIds[0]) ? <img src={url(c.assetIds[0])!} alt="" /> : null}{c.name}</button>; })}</div> : null}
    <label className="field-label">Final model<input value={g.model ?? ''} placeholder="seedance_2_5" onChange={e => set({ model: e.target.value.trim() || undefined })} /></label>
    <div className="beat-gen-media">{url(g.stillAssetId) ? <figure><img src={url(g.stillAssetId)!} alt="Still" /><figcaption>Still · {stage === 'still' ? 'waiting for your OK' : 'approved'}</figcaption></figure> : null}
      {url(g.clipAssetId) ? <figure><video src={url(g.clipAssetId)!} muted loop autoPlay playsInline /><figcaption>{stage === 'final' ? 'Final clip' : 'Draft clip'} · on the timeline</figcaption></figure> : null}</div>
    <div className="beat-gen-actions">
      <button disabled={!!pending?.busy} onClick={() => void call('still', false)}>{g.stillAssetId ? 'New draft still' : 'Draft still'}</button>
      {stage === 'still' ? <button className="primary" onClick={() => set({ stage: 'still-approved' })}>Approve still</button> : null}
      <button disabled={!!pending?.busy || !canClip} title={canClip ? 'Cheapest video model that starts from your still, lowest quality' : 'Approve a still first'} onClick={() => void call('clip', false)}>Draft clip</button>
      <button disabled={!!pending?.busy || !canFinal} title={canFinal ? `The best model (${g.model ?? 'seedance_2_5'}) at full quality, once` : 'Get a draft clip right first'} onClick={() => void call('clip', true)}>Final clip</button></div>
    {pending ? <div className={`beat-quote ${pending.error ? 'error' : ''}`}>{pending.error ? <span>{pending.error}</span>
      : pending.busy ? <span>{pending.credits !== undefined ? `Generating ${label(pending).toLowerCase()} with ${pending.model}…${pending.progress ? ` ${Math.round(pending.progress * 100)}%` : ''}` : 'Getting prices…'}{pending.note ? <small> {pending.note}</small> : null}</span>
      : <><span><b>{label(pending)}</b> · {pending.model} · <b>{pending.credits} credits</b>{pending.tried?.length ? <small> cheapest of {pending.tried.filter(t => t.credits).length} quoted ({pending.tried.filter(t => t.credits).map(t => `${t.model} ${t.credits}`).join(', ')})</small> : null}</span>
        <button className="primary" onClick={() => void call(pending.what, pending.final, { model: pending.model!, credits: pending.credits! })}>Spend {pending.credits} credits</button><button onClick={() => setPending(null)}>Cancel</button></>}</div> : null}
    {g.spentCredits ? <small className="hint">{g.spentCredits} credits spent on this beat</small> : null}
  </section>;
}

/** Cast and props for generated shots, kept with the storyboard. */
export function CastPanel({ project, change, close, anchor }: { project: EditorProject; change: (fn: (p: EditorProject) => EditorProject) => void; close: () => void; anchor: HTMLElement | null }) {
  const cast = board(project).cast ?? [];
  return <div className="inputs-panel cast-panel" role="dialog" aria-label="Cast" style={panelAt(anchor)}>
    <header><strong>Cast</strong><small>People, props and places for generated shots. Beats use them as references.</small><button onClick={close} aria-label="Close" title="Close"><Icon name="close"/></button></header>
    {cast.map(c => <div key={c.id} className="cast-row"><div className="cast-thumbs">{c.assetIds.slice(0, 3).map(id => { const a = project.assets.find(x => x.id === id); return a ? <img key={id} src={assetHref(a.file)} alt="" /> : null; })}</div>
      <span><b>{c.name}</b><small>{c.kind} · {c.assetIds.length} image{c.assetIds.length === 1 ? '' : 's'}</small></span>
      <button onClick={() => removeCast(change, c.id)}>Remove</button></div>)}
    <CastAddForm project={project} change={change} />
  </div>;
}
/** Take someone or something out of the cast (beats that referenced it keep their prompts). */
export const removeCast = (change: (fn: (p: EditorProject) => EditorProject) => void, id: string) => change(p => setBoard(p, { ...board(p), cast: (board(p).cast ?? []).filter(x => x.id !== id) }));
/** Add a person, prop or place: a name, a kind, photos from this project and (for a person) consent. */
export function CastAddForm({ project, change }: { project: EditorProject; change: (fn: (p: EditorProject) => EditorProject) => void }) {
  const cast = board(project).cast ?? [], images = project.assets.filter(a => a.kind === 'image');
  const [draft, setDraft] = useState<{ name: string; kind: 'person' | 'prop' | 'location'; assetIds: string[]; consent: boolean }>({ name: '', kind: 'person', assetIds: [], consent: false });
  const save = () => { if (!draft.name.trim() || !draft.assetIds.length || (draft.kind === 'person' && !draft.consent)) return;
    const id = draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || `cast-${cast.length + 1}`;
    change(p => setBoard(p, { ...board(p), cast: [...(board(p).cast ?? []).filter(c => c.id !== id), { id, name: draft.name.trim(), kind: draft.kind, assetIds: draft.assetIds, ...(draft.kind === 'person' ? { consent: true } : {}) }] }));
    setDraft({ name: '', kind: 'person', assetIds: [], consent: false }); };
  return <>
    <div className="cast-new"><input placeholder="Name (e.g. Maya)" aria-label="Cast name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
      <select value={draft.kind} aria-label="Kind" onChange={e => setDraft({ ...draft, kind: e.target.value as typeof draft.kind })}><option value="person">Person</option><option value="prop">Prop</option><option value="location">Location</option></select></div>
    {images.length ? <div className="cast-pick">{images.slice(-24).map(a => { const on = draft.assetIds.includes(a.id);
      return <button key={a.id} className={on ? 'on' : ''} aria-pressed={on} title={a.name} onClick={() => setDraft({ ...draft, assetIds: on ? draft.assetIds.filter(x => x !== a.id) : [...draft.assetIds, a.id] })}><img src={assetHref(a.file)} alt={a.name} /></button>; })}</div>
      : <small>Add photos to this video first (Add media), then pick them here.</small>}
    {draft.kind === 'person' ? <label className="check-row"><input type="checkbox" checked={draft.consent} onChange={e => setDraft({ ...draft, consent: e.target.checked })} /> These are photos of me, or of someone who agreed to be generated</label> : null}
    <button className="primary" disabled={!draft.name.trim() || !draft.assetIds.length || (draft.kind === 'person' && !draft.consent)} onClick={save}>Add to cast</button>
  </>;
}

export function BeatInspector({ project, beatId, change, close, record, recording, seek, onUseTake, removeTake, beforeServerEdit, afterServerEdit }: {
  project: EditorProject; beatId: string; change: (fn: (p: EditorProject) => EditorProject) => void; close: () => void; record?: (ids: string[]) => void; recording: boolean; seek: (frame: number) => void;
  /** Put an earlier take of this beat back on the timeline. */
  onUseTake?: (beatId: string, sessionId: string) => void;
  /** Take a whole take back out: the edit returns to how it was just before it. */
  removeTake?: (sessionId: string) => void;
  beforeServerEdit?: () => Promise<boolean>; afterServerEdit?: () => void;
}) {
  const beat = board(project).beats.find(b => b.id === beatId); if (!beat) return null;
  const fps = project.output.fps, budget = wordBudget(beat, fps), index = sortBeats(board(project).beats).indexOf(beat);
  const patch = (fields: Partial<Beat>) => change(p => setBoard(p, { ...board(p), beats: board(p).beats.map(b => b.id === beat.id ? { ...b, ...fields } : b) }));
  const remove = () => { change(p => setBoard(p, { ...board(p), beats: board(p).beats.filter(b => b.id !== beat.id) })); close(); };
  const lengthen = (seconds: number) => { const frames = Math.max(1, Math.round(seconds * fps)), next = sortBeats(board(project).beats)[index + 1];
    patch({ durationFrames: next ? Math.min(frames, next.startFrame - beat.startFrame) : frames }); };
  return <div className="layer-inspector beat-inspector" style={{ ['--layer-tone' as string]: sourceTone(beat.source) }}>
    <div className="layer-inspector-head"><span className="th-chip" style={{ background: sourceTone(beat.source) }} /><div><strong>Beat {index + 1}{beat.label ? ` · ${beat.label}` : ''}</strong>
      <small>{(beat.startFrame / fps).toFixed(1)}–{(beatEnd(beat) / fps).toFixed(1)} s · {statusLabel[beat.status]}{isPlaceholder(beat) ? ' · waiting for its take' : ''}</small></div>
      <button onClick={() => seek(beat.startFrame)} aria-label="Play from this beat" title="Play from this beat"><Icon name="play"/></button><button onClick={remove} disabled={beat.locked} title={beat.locked ? 'Unlock it first' : 'Remove this beat (its footage and layers stay)'}>Delete</button><button onClick={close} aria-label="Close beat settings" title="Close"><Icon name="close"/></button></div>
    <section><h3>Words</h3>
      <textarea value={beat.words} rows={4} aria-label="What you say in this beat" placeholder="(no words: picture only)" onChange={e => patch({ words: e.target.value })} />
      <small className={budget.over ? 'beat-over' : 'hint'}>{budget.words} words · {(beat.durationFrames / fps).toFixed(1)} s holds about {budget.budget}{budget.over ? `: ${budget.over} too many, or make the beat longer` : ''}</small></section>
    <section><h3>Beat</h3>
      <div className="layer-row"><label className="field-label">Label<input value={beat.label ?? ''} maxLength={80} onChange={e => patch({ label: e.target.value || undefined })} /></label>
        <label className="field-label">Length<input type="number" min={0.2} step={0.1} value={+(beat.durationFrames / fps).toFixed(2)} disabled={beat.status !== 'planned'} title={beat.status !== 'planned' ? 'Recorded beats take their length from the take' : undefined} onChange={e => lengthen(Number(e.target.value) || 0.2)} /></label></div>
      <label className="field-label">Picture<select value={beat.source} onChange={e => patch({ source: e.target.value as BeatSource })}>
        {cameraSlots.map(slot => <option key={slot} value={`camera:${slot}`}>Camera {slot}{board(project).inputs?.cameras?.[slot] ? ` · ${board(project).inputs!.cameras![slot]!.name}` : ''}</option>)}
        {pictureSources.map(s => <option key={s} value={s}>{sourceLabel(s)}</option>)}</select></label>
      <label className="field-label">Shot<textarea rows={2} value={beat.shot ?? ''} placeholder="What's on screen (cards fly in, product UI docks right…)" onChange={e => patch({ shot: e.target.value || undefined })} /></label>
      <label className="check-row"><input type="checkbox" checked={!!beat.locked} onChange={e => patch({ locked: e.target.checked || undefined })} /> Locked: the agent won't change it</label>
      </section>
    {beat.takes?.length ? <section><h3>Takes</h3><ol className="beat-takes">{beat.takes.map((take, i) => { const active = (beat.activeTake ?? beat.takes!.at(-1)!.sessionId) === take.sessionId;
      return <li key={take.sessionId} className={active ? 'active' : ''}><span>Take {i + 1} · {new Date(take.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        {take.startMs !== undefined && take.endMs !== undefined ? ` · ${((take.endMs - take.startMs) / 1000).toFixed(1)} s` : ''}{take.attempts ? ` · ${take.attempts} tries` : ''}</span>
        {active ? <b>On the timeline</b> : <button disabled={!onUseTake || recording || take.startMs === undefined} onClick={() => onUseTake?.(beat.id, take.sessionId)}>Use this take</button>}
        {i === beat.takes!.length - 1 && removeTake ? <button className="take-remove" disabled={recording} title="Take this whole take back out: the edit goes back to how it was before you recorded it" onClick={() => removeTake(take.sessionId)}>Remove</button> : null}</li>; })}</ol></section> : null}
    {!(beat.source === 'generated' || beat.generation) ? null : !studioCan('generatedShots') ? <section className="beat-generation"><h3>Generation</h3><p className="hint">Generated shots are not set up in this workspace yet. The beat keeps its plan; the shot can be recorded or built with layers meanwhile.</p></section> : <GenerationSection project={project} beat={beat} patch={patch} beforeServerEdit={beforeServerEdit} afterServerEdit={afterServerEdit} />}
    {needsRecording(beat) && record ? <button className="beat-record" disabled={recording} onClick={() => record([beat.id])}><Icon name="record" size={14}/>{beat.status === 'planned' ? 'Record this beat' : 'Record it again'}</button> : null}
  </div>;
}

/** The storyboard before each assistant pass; restoring brings back that plan and never moves recorded footage. */
export function VersionsPanel({ project, anchor, close, beforeServerEdit, afterServerEdit, below }: { project: EditorProject; anchor: HTMLElement | null; close: () => void; beforeServerEdit: () => Promise<boolean>; afterServerEdit?: () => void; below?: boolean }) {
  const [versions, setVersions] = useState<{ id: string; at: string; by: string; beats: number }[] | null>(null), [error, setError] = useState('');
  useEffect(() => { void request<{ versions: { id: string; at: string; by: string; beats: number }[] }>(`/api/account/studio/projects/${encodeURIComponent(project.id)}/storyboard/versions`).then(r => setVersions(r.versions)).catch(e => setError(String(e instanceof Error ? e.message : e))); }, [project.id]);
  const restore = async (id: string) => { if (!await beforeServerEdit()) return; try { await request(`/api/account/studio/projects/${encodeURIComponent(project.id)}/storyboard/versions/${id}/restore`, {}); afterServerEdit?.(); close(); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } };
  return <div className="inputs-panel" role="dialog" aria-label="Storyboard versions" style={panelAt(anchor, below)}>
    <header><strong>Versions</strong><small>The storyboard before each change the agent made. Restoring keeps your recorded beats.</small><button onClick={close} aria-label="Close" title="Close"><Icon name="close"/></button></header>
    {error ? <p className="inputs-error">{error}</p> : null}
    {!versions ? <small>Loading…</small> : !versions.length ? <small>No earlier versions yet. One is kept each time the agent changes the storyboard.</small>
      : <ol className="beat-takes">{versions.map(v => <li key={v.id}><span>{new Date(v.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {v.beats} beats<br /><small>{v.by}</small></span><button onClick={() => void restore(v.id)}>Restore</button></li>)}</ol>}
  </div>;
}

/** Export dialog: a version of this edit for each platform (its own project: shape, loudness, its rules). */
export function FormatButtons({ projectId, beforeServerEdit, open, say }: { projectId: string; beforeServerEdit: () => Promise<boolean>; open: (id: string) => void; say: (text: string, error?: boolean) => void }) {
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([]), [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { void request<{ presets: { id: string; label: string }[] }>('/api/account/studio/formats').then(r => setPresets(r.presets)).catch(() => setPresets([])); }, []);
  const make = async (id: string) => { if (!await beforeServerEdit()) return; setBusy(id);
    try { const out = await request<{ projectId: string; warnings: string[] }>(`/api/account/studio/projects/${encodeURIComponent(projectId)}/formats`, { preset: id }); const notes = out.warnings.filter(w => !/check the length/.test(w));
      say(notes.length ? `Made the version. Before posting: ${notes.join(' · ')}` : 'Made the version; it opens now', notes.length > 0); open(out.projectId); }
    catch (error) { say(error instanceof Error ? error.message : String(error), true); } finally { setBusy(null); } };
  if (!presets.length) return null;
  return <div className="format-buttons"><span className="field-label">Other formats (each becomes its own video, reframed)</span>
    <div>{presets.map(p => <button key={p.id} disabled={!!busy} onClick={() => void make(p.id)}>{busy === p.id ? 'Making…' : p.label}</button>)}</div></div>;
}
