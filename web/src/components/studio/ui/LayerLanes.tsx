import React, { useRef } from 'react';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { layerKindInfo, layerLanePoints, layerParamInfo, moveLayer, setLayerLane, type EditorLayer, type LayerParam } from '@/lib/studio/engine/layers';
import { AutomationOverlay, type AutomationTool } from './AutomationOverlay';
import { itemKey, layerLaneKey, moveItems, timelineSpans, type PickMode, type TimelineItem } from '@/lib/studio/engine/timeline-selection';

/** Each layer kind's colour on the timeline and in the inspector: one of the Studio's categorical hues (studio.css `--st-hue-*`), so it follows the app's theme. */
export const layerTone: Record<EditorLayer['kind'], string> = { text: 'var(--st-hue-violet)', box: 'var(--st-hue-yellow)', highlight: 'var(--st-hue-amber)', arrow: 'var(--st-hue-orange)', spotlight: 'var(--st-hue-sky)', notification: 'var(--st-hue-sky)', card: 'var(--st-hue-green)', chips: 'var(--st-hue-green)', image: 'var(--st-hue-pink)', background: 'var(--st-hue-indigo)', waveform: 'var(--st-hue-indigo)', icons: 'var(--st-hue-amber)', ring: 'var(--st-hue-indigo)', code: 'var(--st-hue-magenta)', particles: 'var(--st-hue-blue)' };
export const layerTitle = (layer: EditorLayer) => layer.kind === 'text' ? (layer.style.text ?? layer.name).replace(/\s+/g, ' ').slice(0, 60) : layer.name;
/** Layers sharing a `track` sit on one timeline track (captions); others get their own. */
export const trackKeyOf = (layer: EditorLayer) => layerLaneKey(layer);
export function layerTracks(project: EditorProject) {
  const tracks = new Map<string, EditorLayer[]>();
  for (const layer of project.layers ?? []) { const key = trackKeyOf(layer); tracks.set(key, [...(tracks.get(key) ?? []), layer]); }
  return [...tracks.entries()].map(([key, layers]) => ({ key, layers }));
}
export const trackTitle = (layers: EditorLayer[]) => layers.length > 1 ? `${(layers[0]!.track ?? 'Layers').replace(/^\w/, c => c.toUpperCase())} · ${layers.length}` : layerTitle(layers[0]!);

type Drag = { pointerId: number; x: number; width: number; layer: EditorLayer; mode: 'move' | 'start' | 'end'; moved: boolean; group: TimelineItem[] | null; origin: EditorProject };
/** Timeline multi-selection: what is picked, how a click changes it, and snapping of dragged edges. */
export type LaneSelection = { selection?: TimelineItem[]; pick?: (item: TimelineItem, mode: PickMode) => void; snap?: (edges: number[], delta: number, exclude: string[]) => number };

/** One track per layer (or per group of layers): drag a region to move it, its edges to trim; automation draws over the track in Automation view. */
export function LayerLanes({ project, duration, disabled, selectedLayerId, selectLayer, change, beginEdit, endEdit, seek, automationView, params, tool, selection, pick, snap }: LaneSelection & {
  project: EditorProject; duration: number; disabled: boolean; selectedLayerId: string | null; selectLayer: (id: string | null) => void;
  change: (fn: (p: EditorProject) => EditorProject) => void; beginEdit: () => void; endEdit: (cancel: boolean) => void; seek: (frame: number) => void;
  automationView: boolean; params: Record<string, string>; tool: AutomationTool;
}) {
  const drag = useRef<Drag | null>(null);
  const tracks = layerTracks(project);
  if (!tracks.length) return null;
  const update = (ids: string[], fn: (layer: EditorLayer) => EditorLayer) => change(p => ({ ...p, layers: (p.layers ?? []).map(layer => ids.includes(layer.id) ? fn(layer) : layer) }));
  const begin = (event: React.PointerEvent<HTMLElement>, layer: EditorLayer, mode: Drag['mode']) => {
    if (disabled || event.button !== 0) return; event.preventDefault(); event.stopPropagation();
    const item: TimelineItem = { kind: 'layer', id: layer.id }, picked = !!selection?.some(i => itemKey(i) === itemKey(item));
    if (pick && mode === 'move' && (event.shiftKey || event.metaKey || event.ctrlKey)) { pick(item, event.shiftKey ? 'range' : 'toggle'); return; }
    const lane = (event.currentTarget.closest('.layer-lane') as HTMLElement).getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId); if (!picked) { if (pick) pick(item, 'only'); else selectLayer(layer.id); }
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: lane.width, layer, mode, moved: false, group: mode === 'move' && picked && (selection?.length ?? 0) > 1 ? selection! : null, origin: project }; beginEdit();
  };
  const move = (event: React.PointerEvent<HTMLElement>) => { const d = drag.current; if (!d || d.pointerId !== event.pointerId) return;
    if (!d.moved && Math.abs(event.clientX - d.x) < 3) return; d.moved = true; let delta = Math.round((event.clientX - d.x) / d.width * duration);
    if (d.group) { const keys = d.group.map(itemKey), spans = timelineSpans(d.origin).filter(span => keys.includes(span.key)); if (snap) delta = snap(spans.flatMap(span => [span.startFrame, span.endFrame]), delta, keys);
      const moved = moveItems(d.origin, d.group, delta, duration); change(p => ({ ...p, layers: moved.layers, audioTracks: moved.audioTracks })); return; }
    if (snap) delta = snap(d.mode === 'start' ? [d.layer.startFrame] : d.mode === 'end' ? [d.layer.endFrame] : [d.layer.startFrame, d.layer.endFrame], delta, [itemKey({ kind: 'layer', id: d.layer.id })]);
    update([d.layer.id], () => moveLayer(d.layer, d.mode, delta, duration)); };
  const end = (cancel: boolean) => (event: React.PointerEvent<HTMLElement>) => { const d = drag.current; if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null; endEdit(cancel || !d.moved); if (!cancel && !d.moved && d.group) pick?.({ kind: 'layer', id: d.layer.id }, 'only'); };
  const handlers = { onPointerMove: move, onPointerUp: end(false), onPointerCancel: end(true) };
  return <>{tracks.map(({ key, layers }) => { const first = layers[0]!, param = params[key] ?? 'opacity', ids = layers.map(layer => layer.id);
    const selectedHere = layers.some(layer => layer.id === selectedLayerId);
    return <div key={key} data-head={key} className={`layer-lane kind-${first.kind} ${selectedHere ? 'selected' : ''}`} aria-label={`${layerKindInfo[first.kind].label} track ${trackTitle(layers)}`}
      style={{ ['--layer-tone' as string]: layerTone[first.kind] }}>
      {automationView && param !== 'off' ? <span className="lane-automation" onPointerDown={event => event.stopPropagation()}>
        {/* A grouped track has one curve: it is written to every layer on the track. */}
        <AutomationOverlay info={layerParamInfo(first, param as LayerParam)} points={layerLanePoints(first, param as LayerParam)} tool={tool} tone={layerTone[first.kind]}
          setPoints={points => update(ids, current => setLayerLane(current, param as LayerParam, points))} duration={duration} disabled={disabled} beginEdit={beginEdit} endEdit={endEdit} seek={seek} />
      </span> : null}
      {layers.map(layer => { const selected = selectedLayerId === layer.id || !!selection?.some(i => i.kind === 'layer' && i.id === layer.id);
        return <div key={layer.id} data-item={itemKey({ kind: 'layer', id: layer.id })} className={`layer-region ${selected ? 'selected' : ''}`} style={{ left: `${layer.startFrame / duration * 100}%`, width: `${(layer.endFrame - layer.startFrame) / duration * 100}%` }}>
          <button className="layer-move" disabled={disabled} aria-pressed={selected} title={`${layerTitle(layer)} · drag to move · Delete removes`}
            onPointerDown={event => begin(event, layer, 'move')} {...handlers} onClick={event => { event.stopPropagation(); if (event.detail === 0) { if (pick) pick({ kind: 'layer', id: layer.id }, 'only'); else selectLayer(layer.id); } }} onDoubleClick={() => seek(layer.startFrame)}
            onKeyDown={event => { if ((event.key === 'Backspace' || event.key === 'Delete') && (selection?.length ?? 0) < 2) { event.preventDefault(); event.stopPropagation(); change(p => ({ ...p, layers: (p.layers ?? []).filter(item => item.id !== layer.id) })); if (pick) pick({ kind: 'layer', id: layer.id }, 'toggle'); else selectLayer(null); }
              else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); update([layer.id], current => moveLayer(current, 'move', (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1), duration)); } }}>
            {layers.length === 1 ? <span className="layer-kind">{layerKindInfo[layer.kind].label}</span> : null}<span className="layer-name">{layerTitle(layer)}</span>
            {layer.enter.preset !== 'none' && layer.enter.preset !== 'words' ? <i className="layer-ramp in" style={{ width: `${Math.min(45, layer.enter.frames / (layer.endFrame - layer.startFrame) * 100)}%` }} /> : null}
            {layer.exit.preset !== 'none' ? <i className="layer-ramp out" style={{ width: `${Math.min(45, layer.exit.frames / (layer.endFrame - layer.startFrame) * 100)}%` }} /> : null}
          </button>
          {(['start', 'end'] as const).map(mode => <button key={mode} className={`trim-handle layer-trim ${mode}`} disabled={disabled} aria-label={`Trim ${layerTitle(layer)} ${mode}`}
            onPointerDown={event => begin(event, layer, mode)} {...handlers} onClick={event => event.stopPropagation()} />)}
        </div>; })}
    </div>; })}</>;
}
