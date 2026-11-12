import React, { useLayoutEffect, useRef, useState } from 'react';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { automationParams, automationValue, lanePoints, paramInfo, type AutomationParam } from '@/lib/studio/engine/automation';
import { layerKindInfo, layerLanePoints, layerParamInfo, layerParams, layerValue, type LayerParam } from '@/lib/studio/engine/layers';
import { layerTone, trackKeyOf, trackTitle } from './LayerLanes';
import { layoutPresetOf, layoutPresets, shotSegments, sourceLabel } from '@/lib/studio/engine/shots';
import { presetShort } from './LayoutLane';
import type { ScheduledClip } from '@/lib/studio/engine/timeline';

/** What each track's automation shows, by track key: 'audio', 'video', or 'layer:<id>' → a parameter id or 'off'. */
export type TrackParams = Record<string, string>;
export const defaultTrackParams: TrackParams = { audio: 'volume', video: 'zoom' };
/** Heights the person dragged a track to, in px at lane zoom 1. Tracks not listed use the shared default height. */
export type TrackHeights = Record<string, number>;
export const TRACK_HEIGHT = 44;
type Head = { key: string; top: number; height: number };

/** Live level of the recording's audio at a frame (from the waveform), after gain, mute and Volume automation. */
function levelAt(project: EditorProject, schedule: ScheduledClip[], frame: number) {
  const s = schedule.find(item => frame >= item.startFrame && frame < item.startFrame + item.durationFrames);
  if (!s || s.clip.audio.muted || !s.asset.waveform?.length || !s.asset.sourceFrames) return 0;
  const source = s.clip.trimStartSourceFrame + (frame - s.startFrame) / project.output.fps * s.asset.sourceFps! * s.clip.playbackRate;
  const peak = s.asset.waveform[Math.min(s.asset.waveform.length - 1, Math.max(0, Math.floor(source / s.asset.sourceFrames * s.asset.waveform.length)))] ?? 0;
  return Math.min(1.4, peak * s.clip.audio.gain * automationValue(project, 'volume', frame));
}

const shotNames: Record<string, string> = { screen: 'Screen', slides: 'Slides', camera: 'Camera', bubble: 'Bubble' };

/** Whether two measurements show the same headers. Inside a page that is scaled or still moving into place, a
 *  lane's edge can land a pixel either side of where it was from one measurement to the next; a header that followed
 *  each of those would measure, draw and measure again without end, so a pixel of difference is none. */
const sameHeads = (a: Head[], b: Head[]) => a.length === b.length && a.every((head, i) => head.key === b[i]!.key && Math.abs(head.top - b[i]!.top) <= 1 && Math.abs(head.height - b[i]!.height) <= 1);

/**
 * Logic-style track headers in their own fixed column left of the timeline: lanes scroll sideways without them, and the
 * headers follow vertical scrolling. Each lane marks itself with data-head and its header is measured against it.
 * Drag a header's bottom edge to make that one track taller; double-click the edge to reset it.
 */
export function TrackHeads({ area, project, schedule, frame, automationView, params, setParams, change, layoutKey, heights, setHeight, laneScale, selectedLayerId, selectLayer, custom }: {
  area: React.RefObject<HTMLDivElement | null>; project: EditorProject; schedule: ScheduledClip[]; frame: number; automationView: boolean;
  params: TrackParams; setParams: (next: TrackParams) => void; change?: (fn: (p: EditorProject) => EditorProject) => void; layoutKey: string;
  heights: TrackHeights; setHeight: (key: string, height: number | null) => void; laneScale: number;
  selectedLayerId?: string | null; selectLayer?: (id: string | null) => void;
  /** Header content for tracks drawn outside this file (the Storyboard track). */
  custom?: Record<string, React.ReactNode>;
}) {
  const [heads, setHeads] = useState<Head[]>([]);
  const self = useRef<HTMLDivElement | null>(null);
  // What was last drawn, and how many times this turn of the event loop the headers were redrawn from a measurement.
  const drawn = useRef<Head[]>([]), burst = useRef(0), later = useRef(0);
  const measure = () => {
    const root = area.current, origin = self.current?.getBoundingClientRect(); if (!root || !origin) return;
    const next = Array.from(root.querySelectorAll<HTMLElement>('[data-head]')).map(el => { const box = el.getBoundingClientRect();
      return { key: el.dataset.head!, top: Math.round(box.top - origin.top), height: Math.round(box.height) }; });
    // Nothing moved: no update at all (this runs after every render, so even an update that changes nothing would
    // count against React's limit on updates made while it is drawing).
    if (sameHeads(drawn.current, next)) return;
    // A measurement that keeps changing while React is still drawing (a layout that has not settled) must not be
    // followed without end: after a few redraws in one go, wait for the next frame and measure once more then.
    if (burst.current === 0) queueMicrotask(() => { burst.current = 0; });
    if (++burst.current > 6) { cancelAnimationFrame(later.current); later.current = requestAnimationFrame(() => measureRef.current()); return; }
    drawn.current = next; setHeads(next);
  };
  const measureRef = useRef(measure); measureRef.current = measure;
  // Re-measure after every render (a handful of rects) so headers follow lanes appearing, growing or loading late.
  useLayoutEffect(() => { measure(); });
  // Follow vertical scrolling of the lanes. Listen on the document (capture) so it survives the lanes being re-created.
  useLayoutEffect(() => {
    const onScroll = (event: Event) => { const target = event.target as Element | null; if (target instanceof Element && target.classList.contains('timeline-scroll')) measureRef.current(); };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => { document.removeEventListener('scroll', onScroll, { capture: true }); cancelAnimationFrame(later.current); };
  }, []);
  useLayoutEffect(() => {
    const root = area.current; if (!root) return;
    const observer = new ResizeObserver(() => measureRef.current()); observer.observe(root);
    root.querySelectorAll('[data-head]').forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [area, layoutKey, heights]);

  const resize = (key: string, height: number) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return; event.preventDefault(); event.stopPropagation();
    const handle = event.currentTarget, startY = event.clientY; handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => setHeight(key, Math.max(24, Math.min(320, (height + e.clientY - startY) / laneScale)));
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  };

  const allMuted = project.clips.every(clip => clip.audio.muted), level = levelAt(project, schedule, frame);
  const db = level > 0.001 ? 20 * Math.log10(level) : -Infinity;
  const value = (param: AutomationParam) => paramInfo(param).format(automationValue(project, param, frame));
  const firstShot = heads.find(head => head.key.startsWith('video:'))?.key;
  const body = (key: string): React.ReactNode => {
    if (key === 'ruler') return null;
    if (custom && key in custom) return custom[key];
    if (key === 'layout') { const segment = shotSegments(project).find(item => frame >= item.from && frame < item.to);
      const label = segment ? presetShort(layoutPresets.find(item => item.id === layoutPresetOf(segment.view))?.label ?? 'Single') : '';
      return <><div className="th-row"><span className="th-chip layout" /><span className="th-name">Layout</span></div><span className="th-sub" title="Drag across the Layout track to choose a layout for that stretch">{label || 'Drag across to set'}</span></>; }
    if (key === 'words') return <div className="th-row"><span className="th-chip words" /><span className="th-name">Words</span></div>;
    if (key === 'keys') return <div className="th-row"><span className="th-name">Keys</span></div>;
    if (key === 'clipzoom') return <div className="th-row"><span className="th-name">Clip zooms</span></div>;
    if (key === 'layers') return <div className="th-row"><span className="th-name">Layers</span></div>;
    if (key === 'animation') return <div className="th-row"><span className="th-name">Animation</span></div>;
    if (key === 'audio') return <>
      <div className="th-row"><span className="th-chip audio" /><span className="th-name">Audio</span>
        <button className={`th-btn ${allMuted ? 'on mute' : ''}`} aria-pressed={allMuted} title="Mute the recording's audio" disabled={!change}
          onClick={() => change?.(p => ({ ...p, clips: p.clips.map(clip => ({ ...clip, audio: { ...clip.audio, muted: !allMuted } })) }))}>M</button></div>
      <div className="th-meter" title={Number.isFinite(db) ? `${db.toFixed(1)} dB` : 'Silent'}><span style={{ width: `${Math.min(100, level / 1.4 * 100)}%` }} /></div>
      {automationView ? <div className="th-row"><select aria-label="Audio automation" title="What this track's automation line controls" value={params.audio ?? 'volume'} onChange={e => setParams({ ...params, audio: e.target.value })}>
        <option value="off">Off</option><option value="volume">{lanePoints(project, 'volume').length ? '● ' : ''}Volume</option></select>{(params.audio ?? 'volume') !== 'off' ? <output>{value('volume')}</output> : null}</div> : null}
    </>;
    if (key.startsWith('video:')) { const lane = key.slice(6);
      return <>
        <div className="th-row"><span className={`th-chip shot-${lane.startsWith('src-') ? (project.sources?.find(item => item.id === lane)?.kind ?? 'window') : lane}`} /><span className="th-name th-layer-name" title={shotNames[lane] ?? sourceLabel(project, lane)}>{shotNames[lane] ?? sourceLabel(project, lane)}</span></div>
        {automationView && key === firstShot ? <div className="th-row"><select aria-label="Picture automation" title="Automates the whole picture — screen, slides and camera (● = has automation)" value={params.video ?? 'zoom'} onChange={e => setParams({ ...params, video: e.target.value })}>
          <option value="off">Off</option>{automationParams.filter(item => item.target === 'video').map(item => <option key={item.id} value={item.id}>{lanePoints(project, item.id).length ? '● ' : ''}{item.label}</option>)}</select>
          {(params.video ?? 'zoom') !== 'off' ? <output>{value((params.video ?? 'zoom') as AutomationParam)}</output> : null}</div> : null}
      </>; }
    if (key.startsWith('layer:')) { const members = (project.layers ?? []).filter(item => trackKeyOf(item) === key), layer = members[0]; if (!layer) return null;
      const param = params[key] ?? 'opacity', title = trackTitle(members);
      return <>
        <div className="th-row"><span className="th-chip" style={{ background: layerTone[layer.kind] }} /><span className="th-name th-layer-name" title={title}>{title}</span></div>
        {automationView ? <div className="th-row"><select aria-label={`${title} automation`} title={members.length > 1 ? 'One curve for every layer on this track (● = has automation)' : 'What this layer\'s automation line controls (● = has automation)'} value={param} onChange={e => setParams({ ...params, [key]: e.target.value })}>
          <option value="off">Off</option>{layerParams.map(item => <option key={item} value={item}>{layerLanePoints(layer, item).length ? '● ' : ''}{layerParamInfo(layer, item).label}</option>)}</select>
          {param !== 'off' ? <output>{layerParamInfo(layer, param as LayerParam).format(layerValue(layer, param as LayerParam, frame))}</output> : null}</div>
          : <span className="th-sub">{members.length > 1 ? `${members.length} ${layerKindInfo[layer.kind].label.toLowerCase()} layers` : `${layerKindInfo[layer.kind].label} · ${layer.enter.preset} in`}{layer.automation.length ? ` · ${layer.automation.length} automated` : ''}</span>}
      </>; }
    if (key.startsWith('audiotrack:')) { const track = project.audioTracks.find(item => item.id === key.slice(11));
      return track ? <div className="th-row"><span className="th-chip voice" /><span className="th-name">{track.name}</span>
        <button className={`th-btn ${track.muted ? 'on mute' : ''}`} aria-pressed={track.muted} disabled={!change}
          onClick={() => change?.(p => ({ ...p, audioTracks: p.audioTracks.map(item => item.id === track.id ? { ...item, muted: !item.muted } : item) }))}>M</button></div> : null; }
    return null;
  };
  return <div className="track-heads" ref={self} aria-label="Track headers">
    {heads.map(head => <div key={head.key} className={`track-head th-${head.key.split(':')[0]} ${head.key.startsWith('layer:') && (project.layers ?? []).some(item => item.id === selectedLayerId && trackKeyOf(item) === head.key) ? 'selected' : ''}`} style={{ top: head.top, height: head.height }}
      onPointerDown={head.key.startsWith('layer:') && selectLayer ? event => { if ((event.target as HTMLElement).closest('select,button,.th-resize')) return; const first = (project.layers ?? []).find(item => trackKeyOf(item) === head.key); if (first) selectLayer(first.id); } : undefined}>
      {body(head.key)}
      {head.key !== 'ruler' ? <div className={`th-resize ${heights[head.key] ? 'custom' : ''}`} title="Drag to resize this track · double-click to reset"
        onPointerDown={resize(head.key, head.height)} onDoubleClick={() => setHeight(head.key, null)} /> : null}
    </div>)}
  </div>;
}
