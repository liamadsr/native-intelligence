import { studioPortal, studioKeys } from '../studio-env';
import { assetHref } from '@/lib/studio/engine/asset-base';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import type { Check } from '@/lib/studio/engine/checklist';
import { beatEnd, isPlaceholder, needsRecording, reorderBeats, sortBeats, StoryboardSchema, wordCount, type Beat } from '@/lib/studio/engine/storyboard';
import { scheduleProject, sourceTimeSeconds } from '@/lib/studio/engine/timeline';
import { request } from './client';
import { Icon } from './icons';
import { studioSelectOpen } from './controls';
import { addBeatAt, CastAddForm, FormatButtons, InputsPanel, nextSelection, removeCast, sourceLabel, sourceTone, startFromScript, statusLabel, useBrowserChoosesScreen, VersionsPanel } from './Storyboard';

// The film's pages for the prompt-first workflow: Overview (the film at a glance and its script outline), Storyboard
// (the beats as cards, with the beat inspector beside them) and Cast. Edit is the editor itself, in App.tsx. Everything
// here edits the same project through `change`, so undo, autosave and the agent's edits work exactly as on the timeline.

/** A film's pages, plus 'project': the overview of the project (campaign) the film is one ad of. */
export type FilmPage = 'project' | 'overview' | 'storyboard' | 'cast' | 'edit';
export const filmPages: { id: FilmPage; label: string }[] = [{ id: 'overview', label: 'Overview' }, { id: 'storyboard', label: 'Storyboard' }, { id: 'cast', label: 'Cast' }, { id: 'edit', label: 'Edit' }];
const pageKey = (projectId: string) => `ni:studio:page.${projectId}`;
/** The page a project opens on: the one last used for it, else Overview when it has a storyboard and Edit when it doesn't. */
export function initialPage(project: EditorProject): FilmPage {
  try { const saved = localStorage.getItem(pageKey(project.id)); if (saved && (saved === 'project' || filmPages.some(p => p.id === saved))) return saved as FilmPage; } catch { /* per-viewer convenience only */ }
  return project.storyboard?.beats.length ? 'overview' : 'edit';
}
export function rememberPage(projectId: string, page: FilmPage) { try { localStorage.setItem(pageKey(projectId), page); } catch { /* optional */ } }

type Change = (fn: (p: EditorProject) => EditorProject) => void;
const clock = (seconds: number) => { const s = Math.max(0, seconds), m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`; };
const length = (seconds: number) => seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}` : `${seconds.toFixed(1)} s`;
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
const aspect = (w: number, h: number) => { const d = gcd(w, h), a = `${w / d}:${h / d}`; return ['16:9', '9:16', '1:1', '4:5', '4:3', '16:10'].includes(a) ? a : null; };
const stageLabel: Record<string, string> = { planned: 'Not generated', still: 'Still to approve', 'still-approved': 'Still approved', clip: 'Draft clip', final: 'Final clip' };
const beatTitle = (beat: Beat) => beat.label ?? sourceLabel(beat.source);
const setBoard = (p: EditorProject, beats: Beat[]): EditorProject => ({ ...p, storyboard: StoryboardSchema.parse({ ...(p.storyboard ?? { beats: [] }), beats: sortBeats(beats) }) });

/** What to show for a beat: its generated clip, its still, the frame of the footage under it, or nothing. */
function beatMedia(project: EditorProject, beat: Beat): { kind: 'image' | 'video'; url: string; poster?: string; time?: number; playable?: boolean } | null {
  const asset = (id?: string) => id ? project.assets.find(a => a.id === id) : undefined, g = beat.generation;
  const still = asset(g?.stillAssetId), clip = asset(g?.clipAssetId);
  if (clip?.kind === 'video') return { kind: 'video', url: assetHref(clip.file), ...(still ? { poster: assetHref(still.file) } : {}), time: 0.05, playable: true };
  if (still?.kind === 'image') return { kind: 'image', url: assetHref(still.file) };
  const fps = project.output.fps, at = beat.startFrame + Math.floor(beat.durationFrames / 2);
  const shot = scheduleProject(project).find(s => at >= s.startFrame && at < s.startFrame + s.durationFrames);
  if (!shot || /^blank canvas/i.test(shot.asset.name)) return null;
  if (shot.asset.kind === 'image') return { kind: 'image', url: assetHref(shot.asset.file) };
  if (shot.asset.kind !== 'video') return null;
  return { kind: 'video', url: assetHref(shot.asset.file), time: sourceTimeSeconds(shot.clip, shot.asset, at - shot.startFrame, fps) };
}

/** The beat's picture: the same generated clip the beat inspector previews (plays on hover), else a still frame. */
export function BeatPreview({ project, beat, play }: { project: EditorProject; beat: Beat; play?: boolean }) {
  const media = useMemo(() => beatMedia(project, beat), [project.assets, project.clips, beat]);
  const [failed, setFailed] = useState(false), video = useRef<HTMLVideoElement>(null);
  useEffect(() => { setFailed(false); }, [media?.url]);
  useEffect(() => { const v = video.current; if (!v || !media?.playable) return; if (play) void v.play().catch(() => {}); else v.pause(); }, [play, media?.url, media?.playable]);
  if (!media || failed) return <span className="beat-preview empty" aria-hidden="true"><span>{sourceLabel(beat.source)}</span></span>;
  if (media.kind === 'image') return <img className="beat-preview" src={media.url} alt="" loading="lazy" onError={() => setFailed(true)} />;
  return <video ref={video} className="beat-preview" src={media.time !== undefined ? `${media.url}#t=${media.time.toFixed(2)}` : media.url} poster={media.poster} muted loop={media.playable} playsInline preload="metadata" onError={() => setFailed(true)} />;
}

function Badges({ project, beat, cast = true, todo = true }: { project: EditorProject; beat: Beat; cast?: boolean; todo?: boolean }) {
  const refs = (project.storyboard?.cast ?? []).filter(c => beat.generation?.references?.includes(c.id)), placeholder = isPlaceholder(beat);
  return <span className="film-badges">
    <span className="film-badge source" style={{ ['--tone' as string]: sourceTone(beat.source) }}><i />{sourceLabel(beat.source)}</span>
    {placeholder && !todo ? null : <span className={`film-badge status ${placeholder ? 'todo' : beat.status === 'planned' ? '' : 'ok'}`}>{placeholder ? 'Needs recording' : statusLabel[beat.status]}</span>}
    {beat.generation ? <span className={`film-badge stage ${beat.generation.stage ?? 'planned'}`}>{stageLabel[beat.generation.stage ?? 'planned']}</span> : null}
    {beat.locked ? <span className="film-badge">Locked</span> : null}
    {cast && refs.length ? <span className="film-cast">{refs.map(c => { const a = project.assets.find(x => x.id === c.assetIds[0]);
      return <span key={c.id} className="film-cast-chip" title={`${c.name} (${c.kind})`}>{a ? <img src={assetHref(a.file)} alt="" /> : null}{c.name}</span>; })}</span> : null}
  </span>;
}

function EmptyStoryboard({ project, change, frame, duration, disabled, goEdit, title }: { project: EditorProject; change: Change; frame: number; duration: number; disabled: boolean; goEdit: () => void; title: string }) {
  const [busy, setBusy] = useState(false);
  return <div className="film-empty">
    <div className="film-empty-mark"><Icon name="transcript" size={22} /></div>
    <h2>{title}</h2>
    <p>Beats are the video's plan: the words, which camera or generated shot, what's on screen. Plan them here, then record or generate into them.</p>
    <div className="film-empty-actions">
      <button className="primary" disabled={disabled || busy} onClick={() => { setBusy(true); void startFromScript(project, change, frame, duration).finally(() => setBusy(false)); }}>Start from the script</button>
      <button className="subtle-button" disabled={disabled} onClick={() => addBeatAt(change, frame, duration, project.output.fps)}><Icon name="plus" size={14}/>Beat at playhead</button>
      <button className="subtle-button" onClick={goEdit}>Open the editor</button>
    </div>
  </div>;
}

type Common = { project: EditorProject; change: Change; frame: number; duration: number; disabled: boolean; openBeat: (id: string) => void; editAt: (frame: number) => void; goEdit: () => void };

/** Overview: the film at a glance (length, shape, look, readiness) and the script as an outline, beat by beat. */
export function OverviewPage({ project, change, frame, duration, disabled, openBeat, editAt, goEdit, savedKey }: Common & { savedKey: string }) {
  const board = project.storyboard, beats = sortBeats(board?.beats ?? []), fps = project.output.fps;
  const [checks, setChecks] = useState<Check[] | null>(null), [checkError, setCheckError] = useState('');
  useEffect(() => { let alive = true; const timer = setTimeout(() => { void request<{ checks: Check[] }>(`/api/account/studio/projects/${encodeURIComponent(project.id)}/checklist`)
    .then(r => { if (alive) { setChecks(r.checks); setCheckError(''); } }).catch(e => { if (alive) setCheckError(e instanceof Error ? e.message : String(e)); }); }, 400);
    return () => { alive = false; clearTimeout(timer); }; }, [project.id, savedKey]);
  const groups = useMemo(() => { const map = new Map<string, Check[]>(); for (const c of checks ?? []) map.set(c.check, [...(map.get(c.check) ?? []), c]); return [...map.entries()]; }, [checks]);
  const passing = groups.filter(([, list]) => list.every(c => c.ok)).length, problems = (checks ?? []).filter(c => !c.ok);
  const words = beats.reduce((n, b) => n + wordCount(b.words), 0), toRecord = beats.filter(isPlaceholder).length, generated = beats.filter(b => b.generation?.clipAssetId).length;
  const shape = aspect(project.output.width, project.output.height);
  const meta = [length(duration / fps), ...(shape ? [shape] : []), `${project.output.width} × ${project.output.height}`, `${fps} fps`, ...(board?.stylePack ? [`Style · ${board.stylePack}`] : []), ...(beats.length ? [`${beats.length} beat${beats.length === 1 ? '' : 's'}`] : [])];
  return <div className="film-page ov-page"><div className="ov-inner">
    <header className="ov-head">
      <div className="ov-title">
        <span className="film-kicker">Video</span>
        <h1 title={project.title}>{project.title}</h1>
        <div className="ov-meta">{meta.map(m => <span key={m}>{m}</span>)}</div>
        {beats.length ? <div className="ov-stats">
          <div><b>{words}</b><span>words in the script</span></div>
          <div><b>{toRecord}</b><span>{toRecord === 1 ? 'beat' : 'beats'} to record</span></div>
          <div><b>{generated}</b><span>generated {generated === 1 ? 'shot' : 'shots'}</span></div>
          <div><b>{(board?.cast ?? []).length}</b><span>in the cast</span></div>
        </div> : null}
      </div>
      <section className="ov-ready" aria-label="Readiness">
        <div className="ov-ready-head"><strong>Readiness</strong>{checks ? <span className={problems.length ? 'warn' : 'ok'}>{problems.length ? `${passing} of ${groups.length} checks pass · ${problems.length} to fix` : `All ${groups.length} checks pass`}</span> : null}</div>
        {checkError ? <p className="ov-ready-error">{checkError}</p> : !checks ? <p className="ov-ready-loading">Checking the saved video…</p> : <ul>
          {problems.map((c, i) => <li key={i} className="todo"><i aria-hidden="true" /><span><b>{c.check}</b>{c.detail}</span>{c.at !== undefined ? <button className="ov-at" title="Show this moment in the editor" onClick={() => editAt(Math.round(c.at! * fps))}>{clock(c.at)}</button> : null}</li>)}
          {groups.filter(([, list]) => list.every(c => c.ok)).map(([name, list]) => <li key={name} className="ok"><i aria-hidden="true" /><span><b>{name}</b>{list[0]!.detail}</span></li>)}
        </ul>}
      </section>
    </header>
    <section className="ov-outline" aria-label="Script outline">
      <div className="film-section-head"><h2>Script</h2>{beats.length ? <span>{beats.length} beats · {words} words · click a beat to open it on the Storyboard</span> : null}<ScriptDocuments videoId={project.id} disabled={disabled} /></div>
      {!beats.length ? <EmptyStoryboard project={project} change={change} frame={frame} duration={duration} disabled={disabled} goEdit={goEdit} title="No storyboard yet" /> :
        <ol className="ov-rows">{beats.map((beat, i) => <li key={beat.id}>
          <div className={`ov-row${isPlaceholder(beat) ? ' placeholder' : ''}`} role="button" tabIndex={0} style={{ ['--beat-tone' as string]: sourceTone(beat.source) }}
            onClick={() => openBeat(beat.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBeat(beat.id); } }} aria-label={`Beat ${i + 1}: ${beatTitle(beat)}. Open on the Storyboard`}>
            <span className="ov-num">{i + 1}</span>
            <span className="ov-thumb"><BeatPreview project={project} beat={beat} /></span>
            <span className="ov-body">
              <span className="ov-line"><strong title={beatTitle(beat)}>{beatTitle(beat)}</strong><span className="ov-time">{clock(beat.startFrame / fps)}–{clock(beatEnd(beat) / fps)}</span><span className="ov-len">{(beat.durationFrames / fps).toFixed(1)} s</span></span>
              <span className={`ov-words${beat.words.trim() ? '' : ' none'}`}>{beat.words.trim() || (beat.shot ? `Picture only · ${beat.shot}` : 'Picture only, no words')}</span>
              <Badges project={project} beat={beat} />
            </span>
            <span className="ov-actions"><button className="subtle-button" title={`Open the editor at ${clock(beat.startFrame / fps)}`} onClick={e => { e.stopPropagation(); editAt(beat.startFrame); }}><Icon name="play" size={14} />Edit at {clock(beat.startFrame / fps)}</button></span>
          </div></li>)}</ol>}
    </section>
  </div></div>;
}

type DocRow = { id: string; title: string | null; updated_at?: string };
/**
 * The script and the workspace's documents: "Open as a document" puts the video's script in a new document (linked to
 * the video) and opens it; "Use a document…" makes the script from a document, word for word, one beat per paragraph.
 * The server reads the document as the person may (scripts/:id/from-document, script-documents.ts).
 */
function ScriptDocuments({ videoId, disabled }: { videoId: string; disabled: boolean }) {
  const [hasScript, setHasScript] = useState(false), [busy, setBusy] = useState(false), [note, setNote] = useState(''), [picking, setPicking] = useState(false);
  const [docs, setDocs] = useState<DocRow[] | null>(null), [filter, setFilter] = useState('');
  const base = `/api/account/studio/scripts/${encodeURIComponent(videoId)}`;
  useEffect(() => { let alive = true; void request<{ script: unknown }>(base).then(r => { if (alive) setHasScript(!!r.script); }).catch(() => undefined); return () => { alive = false; }; }, [base]);
  const run = async (work: () => Promise<string>) => { setBusy(true); setNote(''); try { setNote(await work()); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const openAsDocument = () => run(async () => {
    const r = await request<{ document: { id: string; title: string } }>(`${base}/to-document`, {});
    const { openTarget } = await import('@/lib/chat-cards/open-card');
    openTarget({ type: 'document', id: r.document.id, title: r.document.title }, { from: 'studio' });
    return `Made the document ${r.document.title}.`;
  });
  const pick = () => { setPicking(p => !p); if (!docs) void request<{ documents: DocRow[] }>('/api/account/documents').then(r => setDocs((r.documents ?? []).slice(0, 50))).catch(e => setNote(e instanceof Error ? e.message : String(e))); };
  const takeDocument = (doc: DocRow) => { setPicking(false); void run(async () => {
    const r = await request<{ script: { beats: unknown[] } }>(`${base}/from-document`, { documentId: doc.id });
    setHasScript(true);
    return `The script is now ${doc.title || 'that document'}, ${r.script.beats.length} beats. Start from the script on the Storyboard to use it.`;
  }); };
  const shown = (docs ?? []).filter(d => !filter.trim() || (d.title ?? '').toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 12);
  return <span className="ov-script-docs">
    {hasScript ? <button className="subtle-button" disabled={busy || disabled} title="Put this video's script in a new document, linked to the video" onClick={() => void openAsDocument()}>Open as a document</button> : null}
    <button className="subtle-button" disabled={busy || disabled} aria-expanded={picking} title="Make the script from one of the workspace's documents, word for word" onClick={pick}>Use a document…</button>
    {note ? <em className="ov-script-note" role="status">{note}</em> : null}
    {picking ? <div className="ov-doc-picker" role="dialog" aria-label="Choose a document">
      <input autoFocus placeholder="Find a document" value={filter} onChange={e => setFilter(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setPicking(false); }} />
      {!docs ? <p>Loading documents…</p> : !shown.length ? <p>No documents{filter.trim() ? ' match' : ' yet'}.</p> :
        <ul>{shown.map(d => <li key={d.id}><button onClick={() => takeDocument(d)}>{d.title || 'Untitled'}</button></li>)}</ul>}
    </div> : null}
  </span>;
}

/** Storyboard: the beats as cards (drag to reorder), the selected beat's inspector beside them, the track header's actions on top. */
export function StoryboardPage({ project, change, frame, duration, disabled, openBeat, editAt, goEdit, selected, select, record, recording, inspector, beforeServerEdit, afterServerEdit, openProject, say, goCast }: Common & {
  selected: string[]; select: (ids: string[]) => void; record: (ids: string[]) => void; recording: boolean; inspector: (beatId: string) => React.ReactNode;
  beforeServerEdit: () => Promise<boolean>; afterServerEdit: () => void; openProject: (id: string) => void; say: (text: string, error?: boolean) => void; goCast: () => void;
}) {
  void openBeat;
  const browserChoosesScreen = useBrowserChoosesScreen(); // a plain browser's own picker chooses the screen at record time
  const board = project.storyboard, beats = sortBeats(board?.beats ?? []), fps = project.output.fps;
  const [panel, setPanel] = useState<'inputs' | 'versions' | 'formats' | null>(null), [hover, setHover] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over?: string; after?: boolean } | null>(null);
  const anchors = { inputs: useRef<HTMLButtonElement>(null), versions: useRef<HTMLButtonElement>(null), formats: useRef<HTMLButtonElement>(null) };
  useEffect(() => { if (!panel) return; const close = (e: PointerEvent) => { const t = e.target as HTMLElement; if (!studioSelectOpen() && !t.closest('.inputs-panel,.sb-formats,.sb-toolbar')) setPanel(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanel(null); };
    document.addEventListener('pointerdown', close); studioKeys.addEventListener('keydown', esc); return () => { document.removeEventListener('pointerdown', close); studioKeys.removeEventListener('keydown', esc); }; }, [panel]);
  const chosen = beats.filter(b => selected.includes(b.id)), recordable = chosen.some(needsRecording), missingInputs = !board?.inputs?.screen && !browserChoosesScreen;
  const spent = Math.round(beats.reduce((n, b) => n + (b.generation?.spentCredits ?? 0), 0) * 100) / 100;
  const recordLabel = !chosen.length ? 'Select beats to record' : !recordable ? 'These beats have nothing to record' : `Record ${chosen.length === 1 ? 'this beat' : `${chosen.length} beats`}: countdown, then the teleprompter shows their lines`;
  const drop = (targetId: string, after: boolean) => { const moving = drag?.id; setDrag(null); if (!moving || moving === targetId) return;
    const rest = beats.map(b => b.id).filter(id => id !== moving), at = rest.indexOf(targetId) + (after ? 1 : 0), order = [...rest.slice(0, at), moving, ...rest.slice(at)];
    if (order.join() === beats.map(b => b.id).join()) return;
    try { const next = reorderBeats(project.storyboard!, order); change(p => setBoard(p, next.beats)); } catch (error) { say(error instanceof Error ? error.message : String(error), true); } };
  const move = (delta: number) => { const at = beats.findIndex(b => b.id === selected.at(-1)), next = beats[Math.max(0, Math.min(beats.length - 1, (at < 0 ? 0 : at) + delta))]; if (next) select([next.id]); };
  const single = selected.length === 1 && beats.some(b => b.id === selected[0]) ? selected[0]! : null;
  return <div className="film-page sb-page">
    <div className="film-main">
      <div className="sb-toolbar film-toolbar">
        <div className="film-toolbar-title"><h2>Storyboard</h2><span>{beats.length ? `${beats.length} beats · ${beats.filter(isPlaceholder).length} to record · ${chosen.length ? `${chosen.length} selected` : 'shift-click to select several'}${spent ? ` · ${spent} credits spent` : ''}` : 'No beats yet'}</span></div>
        <div className="film-toolbar-actions">
          <button className="sb-record" disabled={recording || !recordable || disabled} title={recordLabel} aria-label={recordLabel} onClick={() => missingInputs ? setPanel('inputs') : record(chosen.map(b => b.id))}><span className="rec-dot" />{chosen.length > 1 && recordable ? `Record ${chosen.length} beats` : 'Record beat'}</button>
          <span className="film-toolbar-sep" />
          <button ref={anchors.inputs} className={panel === 'inputs' ? 'on' : ''} aria-expanded={panel === 'inputs'} title="Inputs: which camera, window and microphone feed the tracks" onClick={() => setPanel(v => v === 'inputs' ? null : 'inputs')}>Inputs</button>
          <button onClick={goCast} title="Cast: people, props and places for generated shots">Cast{board?.cast?.length ? <span className="film-count">{board.cast.length}</span> : null}</button>
          <button ref={anchors.versions} className={panel === 'versions' ? 'on' : ''} aria-expanded={panel === 'versions'} title="Earlier versions of the storyboard (one before each change the agent makes)" onClick={() => setPanel(v => v === 'versions' ? null : 'versions')}>Versions</button>
          <button ref={anchors.formats} className={panel === 'formats' ? 'on' : ''} aria-expanded={panel === 'formats'} title="A version of this edit for each platform" onClick={() => setPanel(v => v === 'formats' ? null : 'formats')}>Formats</button>
        </div>
      </div>
      {!beats.length ? <EmptyStoryboard project={project} change={change} frame={frame} duration={duration} disabled={disabled} goEdit={goEdit} title="Plan the video as beats" /> :
        <div className="sb-grid" role="listbox" aria-label="Beats" aria-multiselectable="true" onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); } if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); } }}>
          {beats.map((beat, i) => { const on = selected.includes(beat.id), placeholder = isPlaceholder(beat), over = drag?.over === beat.id && drag.id !== beat.id;
            return <div key={beat.id} role="option" aria-selected={on} tabIndex={on || (!selected.length && i === 0) ? 0 : -1} draggable={!disabled}
              className={`sb-card${on ? ' selected' : ''}${placeholder ? ' placeholder' : ''}${drag?.id === beat.id ? ' dragging' : ''}${over ? (drag!.after ? ' drop-after' : ' drop-before') : ''}`}
              style={{ ['--beat-tone' as string]: sourceTone(beat.source) }} title={`${i + 1}. ${beatTitle(beat)} · double-click to open it in the editor`}
              onClick={e => select(e.shiftKey ? nextSelection(beats, selected, beat.id, true) : [beat.id])} onDoubleClick={() => editAt(beat.startFrame)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(e.shiftKey ? nextSelection(beats, selected, beat.id, true) : [beat.id]); } }}
              onMouseEnter={() => setHover(beat.id)} onMouseLeave={() => setHover(h => h === beat.id ? null : h)}
              onDragStart={e => { e.dataTransfer.setData('application/x-ni-studio-beat', beat.id); e.dataTransfer.effectAllowed = 'move'; setDrag({ id: beat.id }); }}
              onDragOver={e => { if (!drag || !e.dataTransfer.types.includes('application/x-ni-studio-beat')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; const box = e.currentTarget.getBoundingClientRect(), after = e.clientX > box.left + box.width / 2;
                if (drag.over !== beat.id || drag.after !== after) setDrag({ ...drag, over: beat.id, after }); }}
              onDrop={e => { if (!drag) return; e.preventDefault(); e.stopPropagation(); drop(beat.id, !!drag.after); }} onDragEnd={() => setDrag(null)}>
              <span className="sb-media"><BeatPreview project={project} beat={beat} play={hover === beat.id || (on && selected.length === 1)} />
                <span className="sb-num">{i + 1}</span><span className="sb-len">{(beat.durationFrames / fps).toFixed(1)} s</span>
                {placeholder ? <span className="sb-needs"><span className="rec-dot" />Needs recording</span> : null}</span>
              <span className="sb-body">
                <span className="sb-title"><strong title={beatTitle(beat)}>{beatTitle(beat)}</strong><small>{clock(beat.startFrame / fps)}–{clock(beatEnd(beat) / fps)}</small></span>
                <span className={`sb-words${beat.words.trim() ? '' : ' none'}`} title={beat.words}>{beat.words.trim() || 'Picture only, no words'}</span>
                <Badges project={project} beat={beat} todo={false} />
              </span>
            </div>; })}
        </div>}
    </div>
    {beats.length ? <aside className="film-side" aria-label="Beat settings">
      {single ? inspector(single) : <div className="film-side-hint">{selected.length > 1 ? <><strong>{selected.length} beats selected</strong><p>Record them in one take with the button above, or select one beat to edit its words, takes and generated shots.</p></>
        : <><strong>Select a beat</strong><p>Its words, picture, takes and generated still and clip open here. Drag cards to change the order; shift-click to select a run of beats to record.</p></>}</div>}
    </aside> : null}
    {panel === 'inputs' ? createPortal(<InputsPanel project={project} change={change} close={() => setPanel(null)} anchor={anchors.inputs.current} below />, studioPortal()) : null}
    {panel === 'versions' ? createPortal(<VersionsPanel project={project} anchor={anchors.versions.current} close={() => setPanel(null)} beforeServerEdit={beforeServerEdit} afterServerEdit={afterServerEdit} below />, studioPortal()) : null}
    {panel === 'formats' ? createPortal(<div className="inputs-panel sb-formats" role="dialog" aria-label="Other formats" style={(() => { const box = anchors.formats.current?.getBoundingClientRect(); return box ? { left: Math.max(8, Math.min(box.left, window.innerWidth - 340)), top: box.bottom + 8 } : undefined; })()}>
      <header><strong>Formats</strong><small>Each becomes its own video, reframed for the platform. Also in Export.</small><button onClick={() => setPanel(null)} aria-label="Close" title="Close"><Icon name="close"/></button></header>
      <FormatButtons projectId={project.id} beforeServerEdit={beforeServerEdit} open={id => { setPanel(null); openProject(id); }} say={say} /></div>, studioPortal()) : null}
  </div>;
}

/** Cast: the people, props and places generated shots are made from, with the beats that use each one. */
export function CastPage({ project, change, openBeat }: { project: EditorProject; change: Change; openBeat: (id: string) => void }) {
  const cast = project.storyboard?.cast ?? [], beats = sortBeats(project.storyboard?.beats ?? []);
  return <div className="film-page cast-page">
    <div className="film-main">
      <div className="film-toolbar"><div className="film-toolbar-title"><h2>Cast</h2><span>People, props and places for generated shots. Beats use them as references, and every video in this Studio project shares them.</span></div></div>
      {!cast.length ? <div className="film-empty"><div className="film-empty-mark"><Icon name="people" size={22} /></div><h2>No cast yet</h2>
        <p>Add a person (from their own photos, with consent), a prop or a place on the right. Generated beats then use them as references, so the same face and product show up shot after shot.</p></div> :
        <div className="cast-grid">{cast.map(c => { const images = c.assetIds.map(id => project.assets.find(a => a.id === id)).filter(a => !!a), used = beats.filter(b => b.generation?.references?.includes(c.id));
          return <article key={c.id} className="cast-card">
            <div className="cast-card-media">{images[0] ? <img src={`/${images[0].file}`} alt={c.name} /> : <span className="beat-preview empty"><span>No image</span></span>}
              {images.length > 1 ? <span className="cast-card-strip">{images.slice(1, 5).map(a => <img key={a.id} src={assetHref(a.file)} alt="" />)}{images.length > 5 ? <span>+{images.length - 5}</span> : null}</span> : null}</div>
            <div className="cast-card-body">
              <div className="cast-card-title"><strong title={c.name}>{c.name}</strong><span className="film-badge">{c.kind === 'person' ? 'Person' : c.kind === 'prop' ? 'Prop' : 'Location'}</span>
                {c.kind === 'person' ? <span className={`film-badge ${c.consent ? 'ok' : 'todo'}`}>{c.consent ? 'Consent given' : 'No consent'}</span> : null}</div>
              <small>{c.assetIds.length} reference image{c.assetIds.length === 1 ? '' : 's'}</small>
              {c.notes ? <p className="cast-card-notes">{c.notes}</p> : null}
              <div className="cast-card-used"><span>Used in</span>{used.length ? used.map(b => <button key={b.id} className="film-chip" onClick={() => openBeat(b.id)} title="Open this beat on the Storyboard">{beats.indexOf(b) + 1} · {beatTitle(b)}</button>) : <em>no beats yet</em>}</div>
              <div className="cast-card-actions"><button className="subtle-button" onClick={() => removeCast(change, c.id)} title="Take out of the cast (⌘Z brings it back)">Remove</button></div>
            </div>
          </article>; })}</div>}
    </div>
    <aside className="film-side cast-side" aria-label="Add to cast"><div className="cast-add"><h3>Add to cast</h3><p>A name, what it is, and photos from this video.</p><CastAddForm project={project} change={change} /></div></aside>
  </div>;
}
