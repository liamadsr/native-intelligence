import type { EditorLayer, EditorProject } from './contracts';
import { moveLayer } from './layers';
import { clampFades, editAudioSegment, segmentEndFrame } from './audio-segments';

/** Something on the timeline that can be selected with others: an audio segment or an overlay layer. */
export type TimelineItem = { kind: 'audio'; trackId: string; segmentId: string } | { kind: 'layer'; id: string };
export type TimelineSpan = { item: TimelineItem; key: string; lane: string; startFrame: number; endFrame: number };
export type PickMode = 'only' | 'toggle' | 'range';

export const itemKey = (item: TimelineItem) => item.kind === 'audio' ? `audio:${item.trackId}:${item.segmentId}` : `layer:${item.id}`;
/** The timeline track an overlay layer sits on: layers sharing `track` (captions) share one. */
export const layerLaneKey = (layer: Pick<EditorLayer, 'id' | 'track'>) => `layer:${layer.track ?? layer.id}`;
export const audioLaneKey = (trackId: string) => `audiotrack:${trackId}`;

/** Every selectable item with its lane and frames, in lane order (layers, then audio tracks). */
export function timelineSpans(p: EditorProject): TimelineSpan[] {
  const fps = p.output.fps;
  return [...(p.layers ?? []).map(layer => ({ item: { kind: 'layer', id: layer.id } as TimelineItem, lane: layerLaneKey(layer), startFrame: layer.startFrame, endFrame: layer.endFrame })),
    ...p.audioTracks.flatMap(track => track.segments.map(s => ({ item: { kind: 'audio', trackId: track.id, segmentId: s.id } as TimelineItem, lane: audioLaneKey(track.id), startFrame: s.startFrame, endFrame: segmentEndFrame(s, fps) })))]
    .map(span => ({ ...span, key: itemKey(span.item) }));
}
/** Drop items that no longer exist (after an undo or an assistant edit). */
export function liveItems(p: EditorProject, items: TimelineItem[]) { const keys = new Set(timelineSpans(p).map(s => s.key)); return items.filter(item => keys.has(itemKey(item))); }

/** Rubber band: everything on the touched lanes that overlaps the frames [from, to]. */
export function marqueeItems(p: EditorProject, from: number, to: number, lanes: Iterable<string>): TimelineItem[] {
  const lo = Math.min(from, to), hi = Math.max(from, to), touched = new Set(lanes);
  return timelineSpans(p).filter(s => touched.has(s.lane) && s.startFrame <= hi && s.endFrame > lo).map(s => s.item);
}

/** Click (only), ⌘-click (toggle) or Shift-click (range from the last picked item, on both items' lanes). */
export function pickItems(p: EditorProject, current: TimelineItem[], item: TimelineItem, mode: PickMode): TimelineItem[] {
  const key = itemKey(item);
  if (mode === 'toggle') return current.some(i => itemKey(i) === key) ? current.filter(i => itemKey(i) !== key) : [...current, item];
  const spans = timelineSpans(p), anchor = mode === 'range' ? spans.find(s => s.key === (current.length ? itemKey(current.at(-1)!) : '')) : undefined, target = spans.find(s => s.key === key);
  if (!anchor || !target) return [item];
  const lo = Math.min(anchor.startFrame, target.startFrame), hi = Math.max(anchor.startFrame, target.startFrame), lanes = new Set([anchor.lane, target.lane]);
  const range = spans.filter(s => lanes.has(s.lane) && s.startFrame >= lo && s.startFrame <= hi).map(s => s.item), seen = new Set<string>();
  const merged = [...current, ...range].filter(i => { const k = itemKey(i); if (seen.has(k)) return false; seen.add(k); return true; });
  return [...merged.filter(i => itemKey(i) !== anchor.key), anchor.item];
}

/** Move every selected item by the same number of frames, keeping their offsets: the group stops at frame 0 (and layers at the end). */
export function moveItems(p: EditorProject, items: TimelineItem[], delta: number, total: number): EditorProject {
  const keys = new Set(items.map(itemKey)), spans = timelineSpans(p).filter(s => keys.has(s.key)); if (!spans.length) return p;
  const layerEnds = spans.filter(s => s.item.kind === 'layer').map(s => s.endFrame);
  const d = Math.max(-Math.min(...spans.map(s => s.startFrame)), Math.min(layerEnds.length ? total - Math.max(...layerEnds) : Infinity, Math.round(delta)));
  if (!d) return p;
  return { ...p, layers: p.layers?.map(layer => keys.has(itemKey({ kind: 'layer', id: layer.id })) ? moveLayer(layer, 'move', d, total) : layer),
    audioTracks: p.audioTracks.map(track => ({ ...track, segments: track.segments.map(s => keys.has(itemKey({ kind: 'audio', trackId: track.id, segmentId: s.id })) ? editAudioSegment(s, 'move', d, p.output.fps) : s) })) };
}

/** Delete every selected item. */
export function removeItems(p: EditorProject, items: TimelineItem[]): EditorProject {
  const keys = new Set(items.map(itemKey)); if (!keys.size) return p;
  return { ...p, ...(p.layers ? { layers: p.layers.filter(layer => !keys.has(itemKey({ kind: 'layer', id: layer.id }))) } : {}),
    audioTracks: p.audioTracks.map(track => ({ ...track, segments: track.segments.filter(s => !keys.has(itemKey({ kind: 'audio', trackId: track.id, segmentId: s.id }))) })) };
}

/**
 * Blade: cut an item in two at a timeline frame. Audio halves share the cut point in the source file so they stay in sync
 * (the first keeps the fade in, the second the fade out); a layer's halves stay on one track, without an exit/entrance at the cut.
 * Returns the project unchanged when the frame is not strictly inside the item.
 */
export function splitItem(p: EditorProject, item: TimelineItem, frame: number, newId: string): { project: EditorProject; created: TimelineItem | null } {
  const f = Math.round(frame), fps = p.output.fps;
  if (item.kind === 'audio') {
    const track = p.audioTracks.find(t => t.id === item.trackId), index = track?.segments.findIndex(s => s.id === item.segmentId) ?? -1, s = track?.segments[index];
    if (!track || !s || f <= s.startFrame || f >= segmentEndFrame(s, fps)) return { project: p, created: null };
    const cut = Math.round((s.trimStartSeconds + (f - s.startFrame) / fps) * 1e6) / 1e6, fades = s as typeof s & { fadeInSeconds?: number; fadeOutSeconds?: number };
    const first = clampFades({ ...s, trimEndSeconds: cut, ...(fades.fadeOutSeconds !== undefined ? { fadeOutSeconds: 0 } : {}) });
    const second = clampFades({ ...s, id: newId, startFrame: f, trimStartSeconds: cut, ...(fades.fadeInSeconds !== undefined ? { fadeInSeconds: 0 } : {}) });
    const segments = [...track.segments]; segments.splice(index, 1, first, second);
    return { project: { ...p, audioTracks: p.audioTracks.map(t => t.id === track.id ? { ...t, segments } : t) }, created: { kind: 'audio', trackId: track.id, segmentId: newId } };
  }
  const layers = p.layers ?? [], index = layers.findIndex(l => l.id === item.id), layer = layers[index];
  if (!layer || f <= layer.startFrame || f >= layer.endFrame) return { project: p, created: null };
  const track = layer.track ?? layer.id;
  const first: EditorLayer = { ...layer, track, endFrame: f, exit: { ...layer.exit, preset: 'none' } }, second: EditorLayer = { ...layer, id: newId, track, startFrame: f, enter: { ...layer.enter, preset: 'none' } };
  const next = [...layers]; next.splice(index, 1, first, second);
  return { project: { ...p, layers: next }, created: { kind: 'layer', id: newId } };
}

/** Snap: nudge `delta` so one of the dragged edges lands on a target (playhead, other items' edges) within `threshold` frames. */
export function snapDelta(edges: number[], targets: number[], delta: number, threshold: number): number {
  let best = delta, distance = threshold + 1e-9;
  for (const edge of edges) for (const target of targets) { const d = Math.abs(edge + delta - target); if (d < distance) { distance = d; best = target - edge; } }
  return best;
}
