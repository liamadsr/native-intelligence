import { defaultClipView, type ClipView, type EditorClip, type EditorProject, type ShotLayout, type SlideDeck } from './contracts';
import { neutralMotion } from './motion-contracts';
import { scheduleProject, sourceTimeSeconds, splitClip, type ScheduledClip } from './timeline';

// Browser-safe (this module is bundled into the preview/export composition): no Node imports.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** 'screen' (the main take), 'slides', 'camera' (the main camera) or an extra recorded source id ('src-…'). */
export type ShotSource = ClipView['main'];
export const shotSources: { id: ShotSource; label: string }[] = [
  { id: 'screen', label: 'Screen' }, { id: 'slides', label: 'Slides' }, { id: 'camera', label: 'Camera' }];
export const clipView = (clip: EditorClip): ClipView => clip.view ?? defaultClipView;
/** Shot lanes are useful once a project has more than one synchronized picture source. */
export const hasShots = (project: EditorProject) => !!project.slideDeck || !!project.presenterTrack || !!project.sources?.length;
export function availableShotSources(project: EditorProject): ShotSource[] {
  return [...shotSources.map(item => item.id).filter(id => id === 'screen' || (id === 'slides' ? !!project.slideDeck : !!project.presenterTrack)), ...(project.sources ?? []).map(source => source.id)];
}
export function sourceLabel(project: EditorProject, id: ShotSource): string {
  return shotSources.find(item => item.id === id)?.label ?? project.sources?.find(source => source.id === id)?.name ?? id;
}
/** Every source a shot puts on screen, main first. */
export const shownSources = (view: ClipView): ShotSource[] => view.layout ? view.layout.sources : [view.main];
/** Cameras fill their tile; screens, windows and slides fit inside theirs so nothing is cropped. */
export const isCameraSource = (project: EditorProject, id: ShotSource) => id === 'camera' || project.sources?.find(source => source.id === id)?.kind === 'camera';

/** The synced recording behind a source for one screen take (the original or a punch-in), or null if it has none. */
export function syncedTake(project: EditorProject, id: ShotSource, screenAssetId: string): { assetId: string; offsetSeconds: number } | null {
  if (id === 'camera') { const track = project.presenterTrack; if (!track?.sync) return null;
    return [{ screenAssetId: track.sync.screenAssetId, assetId: track.assetId, offsetSeconds: track.sync.offsetSeconds }, ...(track.takes ?? [])].find(take => take.screenAssetId === screenAssetId) ?? null; }
  const source = project.sources?.find(item => item.id === id); if (!source) return null;
  return [{ screenAssetId: source.sync.screenAssetId, assetId: source.assetId, offsetSeconds: source.sync.offsetSeconds }, ...(source.takes ?? [])].find(take => take.screenAssetId === screenAssetId) ?? null;
}

export type LayoutPreset = { id: string; label: string; layout: Omit<ShotLayout, 'sources'> | null; count: number };
export const layoutPresets: LayoutPreset[] = [
  { id: 'single', label: 'One source', layout: null, count: 1 },
  { id: 'split-50', label: 'Side by side · 50/50', layout: { kind: 'split', ratio: 0.5 }, count: 2 },
  { id: 'split-60', label: 'Side by side · 60/40', layout: { kind: 'split', ratio: 0.6 }, count: 2 },
  { id: 'split-75', label: 'Side by side · 75/25', layout: { kind: 'split', ratio: 0.75 }, count: 2 },
  { id: 'stack-50', label: 'Stacked · 50/50', layout: { kind: 'stack', ratio: 0.5 }, count: 2 },
  { id: 'stack-60', label: 'Stacked · 60/40', layout: { kind: 'stack', ratio: 0.6 }, count: 2 },
  { id: 'pip', label: 'Picture in picture', layout: { kind: 'pip' }, count: 2 },
  { id: 'grid', label: 'Grid', layout: { kind: 'grid' }, count: 4 },
];
export const layoutPresetOf = (view: ClipView) => !view.layout ? 'single' : layoutPresets.find(item => item.layout?.kind === view.layout!.kind && (item.layout.ratio === undefined || Math.abs((view.layout!.ratio ?? 0.5) - item.layout.ratio) < 0.01))?.id ?? view.layout.kind;
/** Pick sources for a layout: keep what is showing, then add the others (cameras first, then windows, then slides). */
export function layoutView(project: EditorProject, view: ClipView, presetId: string, sources?: ShotSource[]): ClipView {
  const preset = layoutPresets.find(item => item.id === presetId); if (!preset) throw new Error(`Unknown layout ${presetId}`);
  const available = availableShotSources(project), current = shownSources(view).filter(id => available.includes(id));
  const others = available.filter(id => !current.includes(id)).sort((a, b) => Number(isCameraSource(project, b)) - Number(isCameraSource(project, a)) || Number(a === 'slides') - Number(b === 'slides'));
  const picked = (sources ?? [...current, ...others]).filter((id, index, all) => available.includes(id) && all.indexOf(id) === index).slice(0, preset.count === 4 ? 4 : preset.count);
  if (!preset.layout) { const { layout: _old, ...rest } = view; return { ...rest, main: picked[0] ?? view.main }; }
  if (picked.length < 2) throw new Error('Record another window or camera to show two sources at once');
  return { ...view, main: picked[0]!, layout: { ...preset.layout, sources: picked }, ...(picked.includes('camera') ? { bubble: false } : {}) };
}

/** Apply a layout preset to clips (each keeps what it was showing first, then fills in other sources). */
export function setLayoutForClips(project: EditorProject, clipIds: string[], presetId: string, sources?: ShotSource[]): EditorProject {
  const ids = new Set(clipIds);
  const clips = project.clips.map(clip => ids.has(clip.id) ? { ...clip, view: layoutView(project, clipView(clip), presetId, sources) } : clip);
  return { ...project, clips };
}
/** Same, for a stretch of the timeline (splits at the edges like any shot change). */
export function setLayoutRange(project: EditorProject, fromFrame: number, toFrame: number, presetId: string, sources?: ShotSource[]): EditorProject {
  const at = scheduleProject(project).find(s => Math.round((fromFrame + toFrame) / 2) >= s.startFrame && Math.round((fromFrame + toFrame) / 2) < s.startFrame + s.durationFrames) ?? scheduleProject(project)[0]!;
  const view = layoutView(project, clipView(at.clip), presetId, sources);
  return setShotRange(project, fromFrame, toFrame, { main: view.main, bubble: view.bubble, layout: view.layout });
}

export type Rect = { x: number; y: number; width: number; height: number };
/** Where each source goes inside the picture area (output pixels). The first source is the main one. */
export function layoutTiles(layout: ShotLayout, area: Rect, gap: number): { source: ShotSource; rect: Rect; inset: boolean }[] {
  const [a, b, c, d] = layout.sources, r = layout.ratio ?? 0.5;
  const tile = (source: ShotSource | undefined, rect: Rect, inset = false) => source ? [{ source, rect, inset }] : [];
  if (layout.kind === 'split') { const w = (area.width - gap) * r;
    return [...tile(a, { ...area, width: w }), ...tile(b, { ...area, x: area.x + w + gap, width: area.width - w - gap })]; }
  if (layout.kind === 'stack') { const h = (area.height - gap) * r;
    return [...tile(a, { ...area, height: h }), ...tile(b, { ...area, y: area.y + h + gap, height: area.height - h - gap })]; }
  if (layout.kind === 'pip') { const inset = layout.inset ?? defaultInset(area, gap);
    return [...tile(a, area), ...tile(b, { x: area.x + inset.x * area.width, y: area.y + inset.y * area.height, width: inset.width * area.width, height: inset.height * area.height }, true)]; }
  // Grid: 2 → halves, 3 → one large left with two stacked right, 4 → 2×2.
  const half = (area.width - gap) / 2, rowH = (area.height - gap) / 2;
  if (!c) return [...tile(a, { ...area, width: half }), ...tile(b, { ...area, x: area.x + half + gap, width: half })];
  if (!d) return [...tile(a, { ...area, width: half }), ...tile(b, { x: area.x + half + gap, y: area.y, width: half, height: rowH }), ...tile(c, { x: area.x + half + gap, y: area.y + rowH + gap, width: half, height: rowH })];
  return [...tile(a, { x: area.x, y: area.y, width: half, height: rowH }), ...tile(b, { x: area.x + half + gap, y: area.y, width: half, height: rowH }),
    ...tile(c, { x: area.x, y: area.y + rowH + gap, width: half, height: rowH }), ...tile(d, { x: area.x + half + gap, y: area.y + rowH + gap, width: half, height: rowH })];
}
/** Where the picture-in-picture window starts: bottom-right corner, about a third of the width. */
export function defaultInset(area: Rect, gap: number) {
  const width = 0.3, height = 0.34, mx = gap * 1.5 / area.width, my = gap * 1.5 / area.height;
  return { x: 1 - width - mx, y: 1 - height - my, width, height };
}
/** The picture area and gap used for layouts (output pixels) — the same numbers the composition draws with. */
export function layoutArea(project: EditorProject): { area: Rect; gap: number } {
  const { width, height } = project.output, p = project.presentation, pad = Math.min(p.padding + p.inset, Math.min(width, height) * 0.45);
  return { area: { x: pad, y: pad, width: width - pad * 2, height: height - pad * 2 }, gap: Math.min(width, height) * 0.02 };
}

/** Stretches of the timeline that show the same thing (one source, or one layout) — the regions of the Layout track. */
export type ShotSegment = { from: number; to: number; clipIds: string[]; view: ClipView };
export function shotSegments(project: EditorProject): ShotSegment[] {
  const segments: ShotSegment[] = [];
  for (const s of scheduleProject(project)) {
    const view = clipView(s.clip), key = stableStringify(view.layout ?? { main: view.main }), last = segments.at(-1);
    if (last && stableStringify(last.view.layout ?? { main: last.view.main }) === key) { last.to = s.startFrame + s.durationFrames; last.clipIds.push(s.clip.id); }
    else segments.push({ from: s.startFrame, to: s.startFrame + s.durationFrames, clipIds: [s.clip.id], view });
  }
  return segments;
}
/** Change the arrangement of one stretch (e.g. a dragged divider or a moved inset) on every clip in it. */
export function setSegmentLayout(project: EditorProject, clipIds: string[], patch: Partial<ShotLayout>): EditorProject {
  const ids = new Set(clipIds);
  return { ...project, clips: project.clips.map(clip => { const view = clipView(clip); return ids.has(clip.id) && view.layout ? { ...clip, view: { ...view, layout: { ...view.layout, ...patch } } } : clip; }) };
}
/** Move the point where one shot/layout changes to the next: the neighbour on the growing side takes over the frames between. */
export function moveShotChange(project: EditorProject, boundary: number, to: number, before: ClipView, after: ClipView): EditorProject {
  const target = Math.round(to); if (target === boundary) return project;
  const patch = (view: ClipView): Partial<ClipView> => ({ main: view.main, bubble: view.bubble, layout: view.layout });
  return target > boundary ? setShotRange(project, boundary, target, patch(before)) : setShotRange(project, target, boundary, patch(after));
}

/** Fit a source of a given shape inside a tile: contain (whole picture) or cover (fill, cropping the edges). */
export function fitRect(tile: Rect, sourceW: number, sourceH: number, cover: boolean): { card: Rect; media: Rect } {
  const scale = cover ? Math.max(tile.width / sourceW, tile.height / sourceH) : Math.min(tile.width / sourceW, tile.height / sourceH);
  const w = sourceW * scale, h = sourceH * scale;
  if (cover) return { card: tile, media: { x: (tile.width - w) / 2, y: (tile.height - h) / 2, width: w, height: h } };
  const card = { x: tile.x + (tile.width - w) / 2, y: tile.y + (tile.height - h) / 2, width: w, height: h };
  return { card, media: { x: 0, y: 0, width: w, height: h } };
}

/** Index of the slide showing at a time on the screen take's clock. Before the first change the deck opens on page 0. */
export function slidePageAt(deck: SlideDeck, ms: number): number {
  let page = 0;
  for (const change of deck.changes) { if (change.ms > ms) break; page = change.page; }
  return page;
}
/** The slide to draw for a clip frame; clips from other footage keep the slide that was showing at their start. */
export function slideForClipFrame(project: EditorProject, scheduled: ScheduledClip, localFrame: number): { assetId: string; page: number } | null {
  const deck = project.slideDeck; if (!deck) return null;
  // Each take (the original or a punch-in) follows its own slide timing; other footage keeps the opening slide.
  const take = scheduled.asset.id === deck.screenAssetId ? deck : deck.takes?.find(item => item.screenAssetId === scheduled.asset.id);
  const ms = take ? sourceTimeSeconds(scheduled.clip, scheduled.asset, Math.min(localFrame, scheduled.durationFrames - scheduled.clip.holdEndFrames - 1), project.output.fps) * 1000 : 0;
  const page = slidePageAt({ ...deck, changes: take?.changes ?? deck.changes }, ms);
  return { assetId: deck.pageAssetIds[page]!, page };
}

const neutral = stableStringify(neutralMotion());
function mergeable(project: EditorProject, a: EditorClip, b: EditorClip) {
  return a.assetId === b.assetId && a.trimEndSourceFrame === b.trimStartSourceFrame && a.holdEndFrames === 0 && a.playbackRate === b.playbackRate
    && stableStringify(a.audio) === stableStringify(b.audio) && stableStringify(clipView(a)) === stableStringify(clipView(b))
    && stableStringify(a.motion) === neutral && stableStringify(b.motion) === neutral
    && !project.voiceoverDraft.targetClipIds.includes(a.id) && !project.voiceoverDraft.targetClipIds.includes(b.id);
}
/** Rejoin neighbouring pieces of one continuous take that now show the same shot, so comping does not litter the clip lane. */
export function mergeShotClips(project: EditorProject, boundaryFrames?: Set<number>): EditorProject {
  const schedule = scheduleProject(project), clips: EditorClip[] = [];
  let lastDuration = 0;
  schedule.forEach((s, index) => {
    const previous = clips.at(-1);
    if (previous && index > 0 && (!boundaryFrames || boundaryFrames.has(s.startFrame)) && mergeable(project, previous, s.clip)) {
      const shift = lastDuration;
      clips[clips.length - 1] = { ...previous, trimEndSourceFrame: s.clip.trimEndSourceFrame, holdEndFrames: s.clip.holdEndFrames,
        zooms: [...previous.zooms, ...s.clip.zooms.map(z => ({ ...z, startClipFrame: z.startClipFrame + shift, endClipFrame: z.endClipFrame + shift }))],
        dismissedActionIndices: [...new Set([...previous.dismissedActionIndices, ...s.clip.dismissedActionIndices])].sort((x, y) => x - y) };
      lastDuration += s.durationFrames;
    } else { clips.push(s.clip); lastDuration = s.durationFrames; }
  });
  if (clips.length === project.clips.length) return project;
  // Merged neighbours must never change the program length; keep the unmerged edit if frame rounding would.
  const merged = { ...project, clips };
  const before = schedule.at(-1)!, after = scheduleProject(merged).at(-1)!;
  return before.startFrame + before.durationFrames === after.startFrame + after.durationFrames ? merged : project;
}
function splitAt(project: EditorProject, frame: number): EditorProject {
  const s = scheduleProject(project).find(item => frame > item.startFrame && frame < item.startFrame + item.durationFrames);
  if (!s) return project;
  try { return splitClip(project, s.clip.id, frame - s.startFrame); } catch { return project; } // Inside an ending hold: keep the whole clip.
}
/** Choosing one source (a lane drag) shows just that source; a patch with a layout sets the whole arrangement. */
function patchView(view: ClipView, patch: Partial<ClipView>): ClipView {
  const next = { ...view, ...patch };
  if (patch.main !== undefined && !('layout' in patch)) { const { layout: _layout, ...single } = next; return single; }
  if ('layout' in patch && !patch.layout) { const { layout: _layout, ...single } = next; return single; }
  return next;
}
function checkShot(project: EditorProject, patch: Partial<ClipView>) {
  const available = availableShotSources(project);
  for (const id of [patch.main, ...(patch.layout?.sources ?? [])]) if (id && !available.includes(id))
    throw new Error(id === 'slides' ? 'Add slides to this project first' : id === 'camera' ? 'This project has no camera recording' : `This project has no source "${id}"`);
}
/** Logic-style comping: choose what is on screen for [fromFrame, toFrame). Edges become clip splits; the shot follows later trims and cuts. */
export function setShotRange(project: EditorProject, fromFrame: number, toFrame: number, patch: Partial<ClipView>): EditorProject {
  const total = scheduleProject(project).reduce((n, s) => Math.max(n, s.startFrame + s.durationFrames), 0);
  const from = Math.max(0, Math.min(total, Math.round(Math.min(fromFrame, toFrame)))), to = Math.max(0, Math.min(total, Math.round(Math.max(fromFrame, toFrame))));
  if (to <= from) return project;
  checkShot(project, patch);
  const split = splitAt(splitAt(project, from), to);
  const schedule = scheduleProject(split);
  const touched = new Set(schedule.filter(s => s.startFrame + s.durationFrames / 2 >= from && s.startFrame + s.durationFrames / 2 < to).map(s => s.clip.id));
  const edited = { ...split, clips: split.clips.map(clip => touched.has(clip.id) ? { ...clip, view: patchView(clipView(clip), patch) } : clip) };
  const boundaries = new Set(scheduleProject(edited).map(s => s.startFrame).filter(f => f >= from - 1 && f <= to + 1));
  return mergeShotClips(edited, boundaries);
}
export function setShotForClips(project: EditorProject, clipIds: string[], patch: Partial<ClipView>): EditorProject {
  checkShot(project, patch);
  const ids = new Set(clipIds);
  return { ...project, clips: project.clips.map(clip => ids.has(clip.id) ? { ...clip, view: patchView(clipView(clip), patch) } : clip) };
}

export type ShotEvent = { ms: number; main: Exclude<ShotSource, 'camera'> };
/** What you were showing while recording: the Slides window or a slide change means slides; the app coming forward
 * or input inside it means the screen. Runs shorter than minRunMs are folded into their neighbour. */
export function recordedShotTimeline(input: { focus: { ms: number; slides: boolean }[]; slideChanges: number[]; appInput: number[]; durationMs: number; minRunMs?: number }): ShotEvent[] {
  const events = [...input.focus.map(f => ({ ms: f.ms, main: f.slides ? 'slides' as const : 'screen' as const, rank: 0 })),
    ...input.slideChanges.map(ms => ({ ms, main: 'slides' as const, rank: 1 })), ...input.appInput.map(ms => ({ ms, main: 'screen' as const, rank: 1 }))]
    .filter(e => Number.isFinite(e.ms)).sort((a, b) => a.ms - b.ms || a.rank - b.rank);
  const runs: ShotEvent[] = [];
  let initial: ShotEvent['main'] = 'screen';
  for (const e of events) { if (e.ms <= 0) initial = e.main; }
  runs.push({ ms: 0, main: initial });
  for (const e of events) { if (e.ms <= 0 || e.ms >= input.durationMs) continue; if (runs.at(-1)!.main !== e.main) runs.push({ ms: e.ms, main: e.main }); }
  const minimum = input.minRunMs ?? 1200, kept: ShotEvent[] = [];
  runs.forEach((run, index) => {
    const end = runs[index + 1]?.ms ?? input.durationMs;
    if (index > 0 && end - run.ms < minimum) return;
    if (kept.at(-1)?.main === run.main) return;
    kept.push(index === 0 ? run : { ...run });
  });
  return kept.length ? kept : [{ ms: 0, main: 'screen' }];
}
/** Split one whole-take clip into shot clips. Source-frame boundaries keep audio and camera continuous across cuts. */
export function clipsFromShots(clip: EditorClip, sourceFps: number, shots: ShotEvent[], bubble: boolean): EditorClip[] {
  const bounds = shots.map(shot => Math.max(clip.trimStartSourceFrame, Math.min(clip.trimEndSourceFrame, clip.trimStartSourceFrame + Math.round(shot.ms / 1000 * sourceFps))));
  const pieces: EditorClip[] = [];
  shots.forEach((shot, index) => {
    const start = index === 0 ? clip.trimStartSourceFrame : bounds[index]!, end = index === shots.length - 1 ? clip.trimEndSourceFrame : bounds[index + 1]!;
    if (end - start < 2) return;
    pieces.push({ ...clip, id: index === 0 ? clip.id : `${clip.id.slice(0, 80)}-shot-${index}`, trimStartSourceFrame: start, trimEndSourceFrame: end,
      holdEndFrames: index === shots.length - 1 ? clip.holdEndFrames : 0, zooms: [], view: { main: shot.main, bubble } });
  });
  // Keep only contiguous pieces from the first boundary.
  if (!pieces.length) return [{ ...clip, view: { main: 'screen', bubble } }];
  pieces[0] = { ...pieces[0]!, trimStartSourceFrame: clip.trimStartSourceFrame };
  for (let i = 1; i < pieces.length; i++) pieces[i] = { ...pieces[i]!, trimStartSourceFrame: pieces[i - 1]!.trimEndSourceFrame };
  pieces[pieces.length - 1] = { ...pieces.at(-1)!, trimEndSourceFrame: clip.trimEndSourceFrame, holdEndFrames: clip.holdEndFrames };
  return pieces.filter(piece => piece.trimEndSourceFrame > piece.trimStartSourceFrame);
}
