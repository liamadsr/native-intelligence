import React, { useRef, useState } from 'react';
import type { ClipView, EditorProject } from '@/lib/studio/engine/contracts';
import type { ScheduledClip } from '@/lib/studio/engine/timeline';
import { presenterMoveFrames } from '@/lib/studio/engine/presenter-position';
import { availableShotSources, clipView, hasShots, layoutPresetOf, layoutPresets, setLayoutForClips, setShotForClips, shownSources, slideForClipFrame, sourceLabel, type ShotSource } from '@/lib/studio/engine/shots';

type Lane = ShotSource;
type Drag = { lane: Lane; pointerId: number; from: number; to: number; startX: number; moved: boolean; multiple: boolean; bubble?: boolean };

/** Logic-style comping: every synchronized source gets a lane; drag across a lane to put it on screen for that stretch. */
export function ShotLanes({ project, schedule, duration, disabled, setShot, seek, selectedIds, selectClip, overlay }: {
  project: EditorProject; schedule: ScheduledClip[]; duration: number; disabled: boolean;
  setShot: (from: number, to: number, patch: Partial<ClipView>) => void; seek: (frame: number) => void;
  selectedIds: string[]; selectClip: (id: string, multiple: boolean) => void; overlay?: React.ReactNode;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  if (!hasShots(project)) return null;
  const moves = project.presenterTrack ? presenterMoveFrames(project) : [];
  const lanes: Lane[] = [...availableShotSources(project), ...(project.presenterTrack ? ['bubble'] : [])];
  const laneLabel = (lane: Lane) => lane === 'bubble' ? 'Bubble' : sourceLabel(project, lane);
  const frameAt = (event: React.PointerEvent, element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    return Math.max(0, Math.min(duration, Math.round((event.clientX - box.left) / box.width * duration)));
  };
  const clipAt = (frame: number) => schedule.find(s => frame >= s.startFrame && frame < s.startFrame + s.durationFrames) ?? schedule.at(-1)!;
  const begin = (lane: Lane) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0 || dragRef.current) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = frameAt(event, event.currentTarget), view = clipView(clipAt(at).clip);
    const next: Drag = { lane, pointerId: event.pointerId, from: at, to: at, startX: event.clientX, moved: false, multiple: event.shiftKey || event.metaKey || event.ctrlKey, ...(lane === 'bubble' ? { bubble: !view.bubble } : {}) };
    dragRef.current = next; setDrag(next);
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = dragRef.current; if (!current || current.pointerId !== event.pointerId) return;
    // Only a real drag (a few pixels) selects a range; smaller movement is still a click.
    const moved = current.moved || Math.abs(event.clientX - current.startX) > 4;
    const next = { ...current, moved, to: frameAt(event, event.currentTarget) }; dragRef.current = next; if (moved) setDrag(next);
  };
  const end = (cancel: boolean) => (event: React.PointerEvent<HTMLDivElement>) => {
    const current = dragRef.current; if (!current || current.pointerId !== event.pointerId) return;
    dragRef.current = null; setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel) return;
    // A click just moves the playhead; dragging across a lane chooses that source for the stretch.
    // Clicking a region selects that section (its zoom, effects and source show in the inspector) like a clip in Logic.
    if (!current.moved) { const hit = clipAt(current.from); if (active(current.lane, hit)) selectClip(hit.clip.id, current.multiple); seek(Math.min(duration - 1, current.from)); return; }
    const from = Math.min(current.from, current.to), to = Math.max(current.from, current.to);
    if (to <= from) return;
    setShot(from, to, current.lane === 'bubble' ? { bubble: current.bubble } : { main: current.lane });
    seek(Math.min(duration - 1, from));
  };
  const active = (lane: Lane, s: ScheduledClip) => { const view = clipView(s.clip);
    return lane === 'bubble' ? view.bubble && view.main !== 'camera' && !view.layout?.sources.includes('camera') : shownSources(view).includes(lane); };
  const layoutBadge = (s: ScheduledClip, lane: Lane) => { const view = clipView(s.clip); if (!view.layout) return null;
    const preset = layoutPresets.find(item => item.id === layoutPresetOf(view)); const index = view.layout.sources.indexOf(lane);
    return <small className="shot-badge layout" title={`${preset?.label ?? view.layout.kind} · ${view.layout.sources.map(id => sourceLabel(project, id)).join(' + ')}`}>{preset?.label.replace('Side by side · ', '↔ ').replace('Stacked · ', '↕ ').replace('Picture in picture', 'PiP') ?? view.layout.kind}{index > 0 ? ` · ${index + 1}` : ''}</small>; };
  const fps = project.output.fps, length = (frames: number) => { const seconds = frames / fps; return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; };
  return <div className="shot-lanes" aria-label="Shots: what is on screen">
    {lanes.map(lane => <div key={lane} data-head={`video:${lane}`} className={`shot-lane shot-${lane}`} role="group" aria-label={`${laneLabel(lane)} shot lane`}
      title={lane === 'bubble' ? 'Click a region to select it · drag across to show or hide your webcam bubble' : `Click a region to select it · drag across to show ${laneLabel(lane).toLowerCase()} for that stretch`}
      onPointerDown={begin(lane)} onPointerMove={move} onPointerUp={end(false)} onPointerCancel={end(true)} onLostPointerCapture={end(true)}>
      <span className="shot-lane-label">{laneLabel(lane)}</span>
      {/* Video automation lives inside the top video track (the one whose header picks the parameter), contained by it. */}
      {overlay && lane === lanes[0] ? <span className="lane-automation" onPointerDown={event => event.stopPropagation()}>{overlay}</span> : null}
      {schedule.filter(s => active(lane, s)).map(s => <span key={s.clip.id} className={`shot-block ${selectedIds.includes(s.clip.id) ? 'selected' : ''}`}
        title={s.clip.view?.reason ? `Why this shot: ${s.clip.view.reason}` : undefined}
        style={{ left: `${s.startFrame / duration * 100}%`, width: `${s.durationFrames / duration * 100}%` }}>
        {lane === 'slides' ? slideRuns(project, s).map(run => { const image = project.assets.find(a => a.id === run.assetId);
          return <span key={run.from} className="shot-slide" style={{ left: `${run.from / s.durationFrames * 100}%`, width: `${(run.to - run.from) / s.durationFrames * 100}%`, ...(image ? { backgroundImage: `url(/${image.file})` } : {}) }}><em>{run.page + 1}</em></span>; })
          : <span className="shot-region-name">{laneLabel(lane)}<small>{length(s.durationFrames)}</small>{s.clip.view?.reason ? <small className="shot-badge reason">{s.clip.view.reason}</small> : null}{s.clip.zooms.length ? <small className="shot-badge">Zoom</small> : null}{layoutBadge(s, lane)}</span>}
      </span>)}
      {lane === 'bubble' ? moves.map(frame => <button key={frame} className="bubble-move" style={{ left: `${frame / duration * 100}%` }} title="The bubble moves here · click to jump"
        aria-label={`Bubble moves at ${(frame / project.output.fps).toFixed(1)} seconds`} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); seek(frame); }} />) : null}
      {drag?.lane === lane ? <span className="shot-ghost" style={{ left: `${Math.min(drag.from, drag.to) / duration * 100}%`, width: `${Math.abs(drag.to - drag.from) / duration * 100}%` }} /> : null}
    </div>)}
  </div>;
}

/** Consecutive frames of one clip that show the same slide, for lane thumbnails. */
function slideRuns(project: EditorProject, s: ScheduledClip) {
  const runs: { from: number; to: number; page: number; assetId: string }[] = [], step = Math.max(1, Math.round(project.output.fps / 4));
  for (let frame = 0; frame < s.durationFrames; frame += step) {
    const slide = slideForClipFrame(project, s, frame)!, last = runs.at(-1);
    if (last && last.page === slide.page) last.to = Math.min(s.durationFrames, frame + step);
    else runs.push({ from: frame, to: Math.min(s.durationFrames, frame + step), page: slide.page, assetId: slide.assetId });
  }
  return runs;
}

/** Inspector control for the selected clips: what is on screen, and how several sources are arranged. */
export function ShotControl({ project, clipIds, change }: { project: EditorProject; clipIds: string[]; change: (fn: (p: EditorProject) => EditorProject) => void }) {
  if (!hasShots(project) || !clipIds.length) return null;
  const clips = project.clips.filter(c => clipIds.includes(c.id)), views = clips.map(clipView), first = views[0]!;
  const available = availableShotSources(project), main = views.every(v => v.main === first.main) ? first.main : null;
  const bubble = views.every(v => v.bubble === first.bubble) ? first.bubble : null;
  const preset = views.every(v => layoutPresetOf(v) === layoutPresetOf(first)) ? layoutPresetOf(first) : null, shown = shownSources(first);
  const apply = (presetId: string, sources?: ShotSource[]) => change(p => setLayoutForClips(p, clipIds, presetId, sources));
  const reasons = [...new Set(views.map(v => v.reason).filter(Boolean))];
  const toggle = (id: ShotSource) => { const next = shown.includes(id) ? shown.filter(item => item !== id) : [...shown, id];
    if (!next.length) return; apply(next.length === 1 ? 'single' : preset && preset !== 'single' ? preset : 'split-50', next); };
  return <div className="shot-control"><h3>On screen</h3>{reasons.length ? <p className="hint shot-reason">Chosen by the director pass: {reasons.join(" · ")}</p> : null}
    <div className="segmented shot-sources" role="radiogroup" aria-label="Main source for selected clips">{available.map(id =>
      <button key={id} role="radio" aria-checked={main === id && !first.layout} className={main === id && !first.layout ? 'active' : ''} onClick={() => change(p => setShotForClips(p, clipIds, { main: id }))}>{sourceLabel(project, id)}</button>)}</div>
    {available.length > 1 ? <>
      <label className="field-label">Layout<select value={preset ?? ''} onChange={e => apply(e.target.value)}>{preset === null ? <option value="">Mixed</option> : null}
        {layoutPresets.map(item => <option key={item.id} value={item.id} disabled={item.count > 1 && available.length < 2}>{item.label}</option>)}</select></label>
      {first.layout ? <div className="layout-sources" aria-label="Sources in this layout (first is the main one)">
        {available.map(id => <label key={id} className="checkbox-field"><input type="checkbox" checked={shown.includes(id)} onChange={() => toggle(id)} />
          {sourceLabel(project, id)}{shown.includes(id) ? <small>{shown.indexOf(id) === 0 ? ' · main' : ` · ${shown.indexOf(id) + 1}`}</small> : null}</label>)}
        <button onClick={() => apply(preset ?? 'split-50', [...shown].reverse())} title="Swap the order (left ↔ right, top ↔ bottom, which is the inset)">⇄ Swap</button>
      </div> : null}
    </> : null}
    {project.presenterTrack ? <label className="checkbox-field"><input type="checkbox" checked={bubble === true} ref={el => { if (el) el.indeterminate = bubble === null; }}
      disabled={main === 'camera' || shown.includes('camera')} onChange={e => change(p => setShotForClips(p, clipIds, { bubble: e.target.checked }))} />Show webcam bubble</label> : null}
    <p className="hint">Drag across a lane under the preview to switch sources for any stretch. Choose a layout to show two to four sources at once.</p>
  </div>;
}
