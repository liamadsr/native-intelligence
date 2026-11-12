// One edit, delivered everywhere. reframe() makes a version of an edit at another shape (9:16, 4:5, 1:1): camera shots
// fill the frame and their crop follows the person's face; screen shots zoom in and follow the pointer; text and cards
// keep their size relative to the frame's width. Export presets add each platform's size, length limit, loudness and
// the margins its buttons cover, and say what breaks them.
import type { EditorProject } from './contracts';
import type { FaceTracks } from './director';
import { setLanePoints, lanePoints, type AutomationPoint } from './automation';
import { clipView, isCameraSource, syncedTake } from './shots';
import { scheduleProject, sourceTimeSeconds, projectDuration } from './timeline';

export type ExportPreset = { id: string; label: string; width: number; height: number; maxSeconds: number; lufs: number;
  /** Margins (fractions of the frame) the platform's own buttons and captions cover. */ safe: { top: number; bottom: number; left: number; right: number } };
/** Defaults as of late 2026; platforms change limits, so the export notes say "check before posting". */
export const exportPresets: ExportPreset[] = [
  { id: 'youtube', label: 'YouTube (16:9)', width: 1920, height: 1080, maxSeconds: 12 * 3600, lufs: -14, safe: { top: 0, bottom: 0.08, left: 0, right: 0 } },
  { id: 'youtube-shorts', label: 'YouTube Shorts (9:16)', width: 1080, height: 1920, maxSeconds: 180, lufs: -14, safe: { top: 0.1, bottom: 0.2, left: 0.04, right: 0.14 } },
  { id: 'tiktok', label: 'TikTok (9:16)', width: 1080, height: 1920, maxSeconds: 600, lufs: -14, safe: { top: 0.1, bottom: 0.22, left: 0.04, right: 0.15 } },
  { id: 'instagram-reels', label: 'Instagram Reels (9:16)', width: 1080, height: 1920, maxSeconds: 180, lufs: -14, safe: { top: 0.12, bottom: 0.22, left: 0.04, right: 0.12 } },
  { id: 'instagram-feed', label: 'Instagram feed (4:5)', width: 1080, height: 1350, maxSeconds: 3600, lufs: -14, safe: { top: 0.04, bottom: 0.06, left: 0.03, right: 0.03 } },
  { id: 'linkedin', label: 'LinkedIn (16:9)', width: 1920, height: 1080, maxSeconds: 600, lufs: -14, safe: { top: 0, bottom: 0.06, left: 0, right: 0 } },
  { id: 'instagram-story', label: 'Instagram Stories (9:16)', width: 1080, height: 1920, maxSeconds: 60, lufs: -14, safe: { top: 0.14, bottom: 0.2, left: 0.04, right: 0.04 } },
  { id: 'x', label: 'X (16:9)', width: 1920, height: 1080, maxSeconds: 140, lufs: -14, safe: { top: 0, bottom: 0.08, left: 0, right: 0 } },
  { id: 'facebook-feed', label: 'Facebook feed (4:5)', width: 1080, height: 1350, maxSeconds: 14400, lufs: -14, safe: { top: 0.04, bottom: 0.08, left: 0.03, right: 0.03 } },
  { id: 'square', label: 'Square (1:1)', width: 1080, height: 1080, maxSeconds: 3600, lufs: -14, safe: { top: 0.04, bottom: 0.06, left: 0.03, right: 0.03 } },
];

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };

/** Where to centre a camera clip: the median face centre (a little headroom above the eyes). */
export function cameraFocus(project: EditorProject, faces: FaceTracks, clipId: string) {
  const s = scheduleProject(project).find(x => x.clip.id === clipId); if (!s) return null;
  const view = clipView(s.clip), take = syncedTake(project, view.main, s.asset.id); if (!take) return null;
  const fps = project.output.fps, from = sourceTimeSeconds(s.clip, s.asset, 0, fps) - take.offsetSeconds, to = sourceTimeSeconds(s.clip, s.asset, s.durationFrames - 1, fps) - take.offsetSeconds;
  const hits = (faces[take.assetId] ?? []).filter(x => x.t >= from && x.t <= to).flatMap(x => x.faces.filter(f => f.confidence > 0.4).sort((a, b) => b.h - a.h).slice(0, 1));
  if (!hits.length) return null;
  return { x: +median(hits.map(f => f.x + f.w / 2)).toFixed(3), y: +Math.min(1, median(hits.map(f => f.y + f.h * 0.55))).toFixed(3) };
}

export function reframe(project: EditorProject, faces: FaceTracks, size: { width: number; height: number }) {
  return reframeWith(project, size, clipId => cameraFocus(project, faces, clipId));
}

/** reframe with the camera crops given directly (clip id → face centre, or null to keep the centre). */
export function reframeWith(project: EditorProject, size: { width: number; height: number }, focusFor: (clipId: string) => { x: number; y: number } | null) {
  const fps = project.output.fps, oldAspect = project.output.width / project.output.height, newAspect = size.width / size.height, k = newAspect / oldAspect;
  const warnings: string[] = [];
  let next: EditorProject = { ...project, output: { ...project.output, width: size.width, height: size.height },
    presentation: { ...project.presentation, padding: 0, inset: 0, radius: 0, shadow: { ...project.presentation.shadow, opacity: 0 }, cameraFill: true } };
  if (Math.abs(k - 1) < 0.02) return { project: next, warnings };
  // Cameras: crop follows the face.
  // Footage (generated shots, imported video: no pointer trace) fills the frame like a camera, cropped around the face.
  const footage = (clip: EditorProject['clips'][number]) => { const view = clipView(clip), a = project.assets.find(x => x.id === clip.assetId);
    return view.main === 'screen' && !view.layout && !!a && a.kind === 'video' && !a.trace?.cursor?.length && !/^Blank canvas/.test(a.name); };
  next = { ...next, clips: next.clips.map(clip => { const view = clipView(clip); if ((!isCameraSource(project, view.main) && !footage(clip)) || view.layout) return clip;
    const focus = focusFor(clip.id); return focus ? { ...clip, view: { ...view, focus } } : clip; }) };
  // Screens: zoom in (narrower frame) and follow the pointer; the zoom lane is rewritten only inside screen shots.
  if (k < 1) { const zoomIn = Math.min(2.4, Math.max(1.15, 1 / k * 0.55)), zoom: AutomationPoint[] = [], panX: AutomationPoint[] = [], panY: AutomationPoint[] = [];
    for (const s of scheduleProject(next)) { const view = clipView(s.clip); if (view.main !== 'screen' || view.layout || footage(s.clip)) continue;
      const actions = s.asset.trace?.cursor ?? [], vp = s.asset.trace?.viewport;
      // The zoom applies only inside screen shots: back to 1× (and centred) on either side, so camera shots aren't zoomed.
      const before = s.startFrame - 1, after = s.startFrame + s.durationFrames;
      if (before >= 0) { zoom.push({ frame: before, value: 1, curve: 'hold' }); panX.push({ frame: before, value: 0.5, curve: 'hold' }); panY.push({ frame: before, value: 0.5, curve: 'hold' }); }
      zoom.push({ frame: s.startFrame, value: zoomIn, curve: 'hold' }, { frame: after - 1, value: zoomIn, curve: 'hold' }, { frame: after, value: 1, curve: 'hold' });
      // Follow the pointer; with no pointer trace (footage, generated shots), hold on the person's face when one was found.
      const face = actions.length && vp ? null : focusFor(s.clip.id);
      for (let f = 0; f < s.durationFrames; f += Math.round(fps * 0.75)) { const ms = sourceTimeSeconds(s.clip, s.asset, f, fps) * 1000;
        const near = actions.length && vp ? actions.reduce((best, c) => Math.abs(c[0] - ms) < Math.abs(best[0] - ms) ? c : best, actions[0]!) : null;
        panX.push({ frame: s.startFrame + f, value: near ? Math.max(0, Math.min(1, near[1] / vp!.width)) : face?.x ?? 0.5 }); panY.push({ frame: s.startFrame + f, value: near ? Math.max(0, Math.min(1, near[2] / vp!.height)) : face?.y ?? 0.5 }); }
      panX.push({ frame: after, value: 0.5, curve: 'hold' }); panY.push({ frame: after, value: 0.5, curve: 'hold' }); }
    const keep = (param: 'zoom' | 'panX' | 'panY', added: AutomationPoint[]) => { if (!added.length) return; const spans = added.map(p => p.frame);
      next = setLanePoints(next, param, [...lanePoints(next, param).filter(p => p.frame < Math.min(...spans) || p.frame > Math.max(...spans)), ...added].sort((a, b) => a.frame - b.frame)); };
    keep('zoom', zoom); keep('panX', panX); keep('panY', panY); }
  // Text and cards keep their size relative to the frame's width (heights are fractions of the frame's height).
  // Narrower: overlays keep roughly their size on screen (×f in pixels), capped to the frame; text that now wraps onto
  // more lines gets the height for them. Wider: as before, sizes follow the frame's width.
  const W0 = project.output.width, H0 = project.output.height, f = Math.min(1, (size.width / W0) * 1.7);
  next = { ...next, layers: (next.layers ?? []).map(l => { if (l.width >= 0.95 && l.height >= 0.95) return l;
    if (k >= 1) { const style = l.style.size ? { ...l.style, size: Math.max(0.028, l.style.size * k) } : l.style; return { ...l, height: Math.min(1, l.height * k), style }; }
    const wantW = l.width * W0 * f / size.width, width = Math.min(0.92, wantW), wrap = l.kind === 'text' ? Math.max(1, wantW / width) : 1;
    const height = Math.min(0.9, l.height * H0 * f / size.height * wrap), style = l.style.size ? { ...l.style, size: Math.max(0.018, l.style.size * H0 * f / size.height) } : l.style;
    return { ...l, width, height, style }; }) };
  const scenes = (next.layers ?? []).filter(l => l.kind === 'code' && l.width >= 0.95).length;
  if (scenes) warnings.push(`${scenes} full-frame code scene${scenes === 1 ? ' was' : 's were'} designed for ${project.output.width}×${project.output.height}; give ${scenes === 1 ? 'it' : 'them'} a pass at this shape (the stage is 1920 wide, its height follows the frame)`);
  if (next.captions.enabled) next = { ...next, captions: { ...next.captions, y: k < 1 ? 0.7 : next.captions.y, fontSize: Math.round(next.captions.fontSize * Math.max(1, size.height / project.output.height) * (k < 1 ? 0.8 : 1)) } };
  return { project: next, warnings };
}

/** A version for a platform: its shape, its loudness, and what breaks its rules (too long, text under its buttons). */
export function forPreset(project: EditorProject, preset: ExportPreset, faces: FaceTracks) {
  const { project: shaped, warnings } = reframe(project, faces, preset);
  const out: EditorProject = { ...shaped, master: { lufs: preset.lufs, truePeak: -1 } };
  const seconds = projectDuration(out) / out.output.fps;
  if (seconds > preset.maxSeconds) warnings.push(`${seconds.toFixed(0)} s is longer than ${preset.label} allows (${preset.maxSeconds} s)`);
  const z = preset.safe;
  for (const l of out.layers ?? []) { const text = l.style.text ?? l.style.title ?? l.style.items?.join(' '); if (!text || (l.width >= 0.95 && l.height >= 0.95)) continue;
    const top = l.y - l.height / 2, bottom = l.y + l.height / 2, left = l.x - l.width / 2, right = l.x + l.width / 2;
    if (top < z.top || bottom > 1 - z.bottom || left < z.left || right > 1 - z.right) warnings.push(`“${text.slice(0, 30)}” sits where ${preset.label} draws its own buttons or captions; move it toward the centre`); }
  if (out.captions.enabled && out.captions.y > 1 - z.bottom) warnings.push(`Captions sit under ${preset.label}'s own UI; raise them`);
  warnings.push('Platform limits change: check the length and size rules before posting.');
  return { project: out, warnings };
}

/** The edit as the chosen platform sees it: reframed to its shape (cameras centred on the stored face positions), text
 *  and cards moved inside the area its buttons and captions leave free. Without a format (or "original") it is the edit
 *  itself. Pure and cheap enough to run on every change; the preview, stills and export all draw this. */
export function deliveredProject(project: EditorProject): EditorProject {
  const preset = formatPreset(project.delivery?.format);
  if (!preset || (preset.width === project.output.width && preset.height === project.output.height)) return project;
  const focus = project.delivery?.focus ?? {};
  const { project: shaped } = reframeWith(project, preset, clipId => focus[clipId] ?? null);
  return { ...shaped, layers: (shaped.layers ?? []).map(l => insideSafe(l, preset.safe)), delivery: undefined };
}

export function formatPreset(id: string | undefined): ExportPreset | undefined { return id && id !== 'original' ? exportPresets.find(p => p.id === id) : undefined; }

/** Move a text or card layer (not full-frame scenes and backdrops) inside the platform's safe area, shrinking it to fit. */
export function insideSafe<L extends { kind: string; x: number; y: number; width: number; height: number; behind?: boolean }>(layer: L, safe: ExportPreset['safe']): L {
  if (layer.width >= 0.95 && layer.height >= 0.95) return layer;
  if (!['text', 'notification', 'card', 'chips', 'image', 'callout', 'icons'].includes(layer.kind)) return layer;
  const maxW = 1 - safe.left - safe.right, maxH = 1 - safe.top - safe.bottom, width = Math.min(layer.width, maxW), height = Math.min(layer.height, maxH);
  const x = Math.min(1 - safe.right - width / 2, Math.max(safe.left + width / 2, layer.x)), y = Math.min(1 - safe.bottom - height / 2, Math.max(safe.top + height / 2, layer.y));
  return x === layer.x && y === layer.y && width === layer.width && height === layer.height ? layer : { ...layer, x, y, width, height };
}

/** Face centres for every camera clip (stored in delivery.focus when a narrower format is chosen). */
export function cameraFocusAll(project: EditorProject, faces: FaceTracks): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const clip of project.clips) { const view = clipView(clip); if (view.layout) continue;
    const f = isCameraSource(project, view.main) ? cameraFocus(project, faces, clip.id) : clipFaceFocus(project, faces, clip.id); if (f) out[clip.id] = f; }
  return out;
}

/** The face centre in a clip's own footage (generated shots, imported video): faces tracked on the clip's asset. */
export function clipFaceFocus(project: EditorProject, faces: FaceTracks, clipId: string) {
  const s = scheduleProject(project).find(x => x.clip.id === clipId); if (!s || s.asset.kind !== 'video') return null;
  const from = sourceTimeSeconds(s.clip, s.asset, 0, project.output.fps), to = sourceTimeSeconds(s.clip, s.asset, s.durationFrames - 1, project.output.fps);
  const hits = (faces[s.asset.id] ?? []).filter(x => x.t >= from && x.t <= to).flatMap(x => x.faces.filter(f => f.confidence > 0.4).sort((a, b) => b.h - a.h).slice(0, 1));
  if (!hits.length) return null;
  return { x: +median(hits.map(f => f.x + f.w / 2)).toFixed(3), y: +Math.min(1, median(hits.map(f => f.y + f.h * 0.55))).toFixed(3) };
}
