import React, { useRef } from 'react';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { editAudioSegment, removeAudioSegment, segmentEndFrame, updateAudioSegment, type AudioSegmentEdit } from '@/lib/studio/engine/audio-segments';
import { Waveform } from './controls';
import { itemKey, moveItems, timelineSpans, type TimelineItem } from '@/lib/studio/engine/timeline-selection';
import type { LaneSelection } from './LayerLanes';

type Segment = EditorProject['audioTracks'][number]['segments'][number];
type Drag = { pointerId: number; x: number; width: number; trackId: string; segment: Segment; mode: AudioSegmentEdit; moved: boolean; group: TimelineItem[] | null; origin: EditorProject };
const secondsText = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;

/** One lane per audio track (voiceover, music, sound effects). Click a segment to select it, drag it to move, drag its edges to trim, its top corners to fade; Delete removes it. */
export function AudioLanes({ project, duration, disabled, selection = [], pick, snap, change, beginEdit, endEdit, seek }: LaneSelection & {
  project: EditorProject; duration: number; disabled: boolean;
  change?: (fn: (p: EditorProject) => EditorProject) => void; beginEdit: () => void; endEdit: (cancel: boolean) => void; seek: (frame: number) => void;
}) {
  const drag = useRef<Drag | null>(null), fps = project.output.fps, editable = !!change && !!pick;
  const keyOf = (trackId: string, segmentId: string) => itemKey({ kind: 'audio', trackId, segmentId });
  const begin = (event: React.PointerEvent<HTMLElement>, trackId: string, segment: Segment, mode: AudioSegmentEdit) => {
    if (!editable || disabled || event.button !== 0 || drag.current) return; event.preventDefault(); event.stopPropagation();
    const item: TimelineItem = { kind: 'audio', trackId, segmentId: segment.id }, picked = selection.some(i => itemKey(i) === itemKey(item));
    if (mode === 'move' && (event.shiftKey || event.metaKey || event.ctrlKey)) { pick!(item, event.shiftKey ? 'range' : 'toggle'); return; }
    const lane = (event.currentTarget.closest('.audio-track-lane') as HTMLElement).getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId); if (!picked) pick!(item, 'only');
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: Math.max(1, lane.width), trackId, segment, mode, moved: false, group: mode === 'move' && picked && selection.length > 1 ? selection : null, origin: project }; beginEdit();
  };
  const move = (event: React.PointerEvent<HTMLElement>) => { const d = drag.current; if (!d || d.pointerId !== event.pointerId || !change) return;
    if (!d.moved && Math.abs(event.clientX - d.x) < 3) return; d.moved = true;
    let delta = Math.round((event.clientX - d.x) / d.width * duration); const seconds = project.assets.find(a => a.id === d.segment.assetId)?.durationSeconds;
    if (d.group) { const keys = d.group.map(itemKey), spans = timelineSpans(d.origin).filter(span => keys.includes(span.key)); if (snap) delta = snap(spans.flatMap(span => [span.startFrame, span.endFrame]), delta, keys);
      const moved = moveItems(d.origin, d.group, delta, duration); change(p => ({ ...p, layers: moved.layers, audioTracks: moved.audioTracks })); return; }
    const start = d.segment.startFrame, end = segmentEndFrame(d.segment, fps);
    if (snap && d.mode !== 'fadeIn' && d.mode !== 'fadeOut') delta = snap(d.mode === 'start' ? [start] : d.mode === 'end' ? [end] : [start, end], delta, [keyOf(d.trackId, d.segment.id)]);
    change(p => updateAudioSegment(p, d.trackId, d.segment.id, () => editAudioSegment(d.segment, d.mode, delta, fps, seconds))); };
  const end = (cancel: boolean) => (event: React.PointerEvent<HTMLElement>) => { const d = drag.current; if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null; endEdit(cancel || !d.moved); if (!cancel && !d.moved && d.group) pick?.({ kind: 'audio', trackId: d.trackId, segmentId: d.segment.id }, 'only'); };
  const handlers = { onPointerMove: move, onPointerUp: end(false), onPointerCancel: end(true), onLostPointerCapture: end(false) };
  const nudge = (event: React.KeyboardEvent, trackId: string, segment: Segment) => {
    if (!editable || disabled) return;
    if ((event.key === 'Backspace' || event.key === 'Delete') && selection.length < 2) { event.preventDefault(); event.stopPropagation(); change!(p => removeAudioSegment(p, trackId, segment.id)); pick!({ kind: 'audio', trackId, segmentId: segment.id }, 'toggle'); return; }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); event.stopPropagation();
    change!(p => updateAudioSegment(p, trackId, segment.id, s => editAudioSegment(s, 'move', (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1), fps))); };
  return <>{project.audioTracks.map(track => <div key={track.id} data-head={`audiotrack:${track.id}`} className={`audio-track-lane ${track.muted ? 'muted' : ''} ${track.role === 'sfx' ? 'sfx-lane' : ''}`} aria-label={`${track.name} audio track`}>
    <span className="audio-track-name">{track.name}</span>
    {track.segments.map(segment => { const asset = project.assets.find(a => a.id === segment.assetId), visibleEnd = Math.min(duration, segmentEndFrame(segment, fps)), visibleStart = Math.min(duration, segment.startFrame);
      if (visibleEnd <= visibleStart) return null;
      const values = asset?.waveform?.slice(Math.floor(segment.trimStartSeconds / asset.durationSeconds! * asset.waveform.length), Math.ceil(segment.trimEndSeconds / asset.durationSeconds! * asset.waveform.length));
      const key = keyOf(track.id, segment.id), on = selection.some(i => itemKey(i) === key), name = track.role === 'sfx' ? (segment.sound ?? asset?.name)?.split('/').pop() : segment.label ?? asset?.name;
      const length = segment.trimEndSeconds - segment.trimStartSeconds, fades = segment as { fadeInSeconds?: number; fadeOutSeconds?: number };
      const fadeIn = Math.min(100, (fades.fadeInSeconds ?? 0) / length * 100), fadeOut = Math.min(100, (fades.fadeOutSeconds ?? 0) / length * 100);
      return <div key={segment.id} data-item={key} className={`audio-segment ${on ? 'selected' : ''}`} style={{ left: `${visibleStart / duration * 100}%`, width: `${(visibleEnd - visibleStart) / duration * 100}%` }}>
        <button className="audio-segment-move" disabled={disabled} aria-pressed={on} aria-label={`Select ${name ?? 'audio'} on ${track.name}`}
          title={`${segment.label ?? asset?.name}${segment.sound ? ` · ${segment.sound}` : ''} · ${secondsText(segment.startFrame / fps)}${editable ? ' · drag to move · edges trim · Delete removes' : ''}`}
          onPointerDown={event => begin(event, track.id, segment, 'move')} {...handlers} onClick={event => { event.stopPropagation(); if (!editable) seek(segment.startFrame); else if (event.detail === 0) pick!({ kind: 'audio', trackId: track.id, segmentId: segment.id }, 'only'); }}
          onDoubleClick={() => seek(segment.startFrame)} onKeyDown={event => nudge(event, track.id, segment)}><span>{name}</span>{values?.length ? <Waveform values={values} /> : null}</button>
        {fadeIn > 0 ? <i className="audio-fade in" style={{ width: `${fadeIn}%` }} /> : null}{fadeOut > 0 ? <i className="audio-fade out" style={{ width: `${fadeOut}%` }} /> : null}
        {editable ? (['start', 'end'] as const).map(mode => <button key={mode} className={`trim-handle audio-trim ${mode}`} disabled={disabled} aria-label={`Trim ${name ?? 'audio'} ${mode}`} title={`Drag to trim ${mode}`}
          onPointerDown={event => begin(event, track.id, segment, mode)} {...handlers} onClick={event => event.stopPropagation()} />) : null}
        {editable && on && selection.length === 1 ? (['fadeIn', 'fadeOut'] as const).map(mode => <button key={mode} className={`audio-fade-handle ${mode === 'fadeIn' ? 'in' : 'out'}`} disabled={disabled} aria-label={`${mode === 'fadeIn' ? 'Fade in' : 'Fade out'} ${name ?? 'audio'}`}
          title={`Drag to ${mode === 'fadeIn' ? 'fade in' : 'fade out'}`} style={mode === 'fadeIn' ? { left: `${fadeIn}%` } : { right: `${fadeOut}%` }}
          onPointerDown={event => begin(event, track.id, segment, mode)} {...handlers} onClick={event => event.stopPropagation()} />) : null}
      </div>; })}
  </div>)}</>;
}
