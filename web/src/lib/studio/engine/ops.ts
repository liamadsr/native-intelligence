import { z } from 'zod';
import { EditorProjectSchema, type ClipView, type EditorProject } from './contracts';
import { setShotRange, shotSegments } from './shots';
import { addTransition, addZoomBump, automationParams, erasePoints, lanePoints, paramInfo, setLanePoints, spliceCurve, transitionKinds, type AutomationParam, type AutomationPoint, type TransitionKind } from './automation';
import { animationPresets, easeKinds, ParticleFormSchema, createLayer, layerKindInfo, layerLanePoints, layerParamInfo, layerParams, LayerStyleSchema, SceneProps, setLayerLane, textLooks, type EditorLayer, type LayerKind, type LayerParam, type TextLook } from './layers';
import { projectDuration, scheduleProject } from './timeline';
import { transcriptWords } from './transcript';
import { defaultDuck } from './ducking';
import { exportPresets } from './formats';
import { BeatGenerationSchema, BeatSourceSchema, beatEnd, beatsFromScript, isPlaceholder, newBeatId, reorderBeats, sortBeats, StoryboardSchema, wordBudget, type Beat, type Storyboard } from './storyboard';

/**
 * Editing commands — the one vocabulary both the in-app assistant (scripts/project.ts ops) and the MCP server use, and
 * the same operations the timeline UI performs. Times are seconds on the edited timeline; positions are fractions of
 * the frame (0,0 top-left → 1,1 bottom-right). Every command validates its input and the resulting project.
 */
type Ctx = { fps: number; total: number };
type Op<S extends z.ZodType> = { name: string; summary: string; input: S; apply: (project: EditorProject, args: z.infer<S>, ctx: Ctx) => { project: EditorProject; result?: unknown } };
const op = <S extends z.ZodType>(definition: Op<S>) => definition;

const seconds = z.number().finite().min(0).max(36_000);
const fraction = z.number().finite().min(-1).max(2);
const positions = { top: [0.5, 0.14], center: [0.5, 0.5], bottom: [0.5, 0.84], 'lower-third': [0.5, 0.76], 'top-left': [0.22, 0.14], 'top-right': [0.78, 0.14], 'bottom-left': [0.22, 0.84], 'bottom-right': [0.78, 0.84] } as const;
const Position = z.union([z.enum(Object.keys(positions) as [keyof typeof positions, ...(keyof typeof positions)[]]), z.object({ x: fraction, y: fraction }).strict()]);
const Animation = z.object({ preset: z.enum(animationPresets), seconds: z.number().finite().min(0.02).max(20).optional(), ease: z.enum(easeKinds).optional() }).strict();
const PointInput = z.object({ time: seconds, value: z.number().finite(), curve: z.enum(['smooth', 'linear', 'hold']).optional() }).strict();
const mainParams = automationParams.map(item => item.id) as [AutomationParam, ...AutomationParam[]];

const toFrame = (time: number, ctx: Ctx) => Math.max(0, Math.min(ctx.total, Math.round(time * ctx.fps)));
const where = (position: z.infer<typeof Position> | undefined, fallback: [number, number]) => !position ? fallback : typeof position === 'string' ? [...positions[position]] as [number, number] : [position.x, position.y] as [number, number];
const animation = (value: z.infer<typeof Animation> | undefined, fallback: EditorLayer['enter'], fps: number) => value ? { preset: value.preset, frames: Math.max(1, Math.round((value.seconds ?? fallback.frames / fps) * fps)), ...(value.ease ?? fallback.ease ? { ease: value.ease ?? fallback.ease } : {}) } : fallback;
function nextId(project: EditorProject, stem: string) { const used = new Set((project.layers ?? []).map(layer => layer.id)); let n = 1; while (used.has(`${stem}-${n}`)) n++; return `${stem}-${n}`; }
function findLayer(project: EditorProject, id: string) { const layer = project.layers?.find(item => item.id === id); if (!layer) throw new Error(`No layer "${id}". Layers: ${(project.layers ?? []).map(item => item.id).join(', ') || 'none'}`); return layer; }
const withLayer = (project: EditorProject, layer: EditorLayer) => ({ ...project, layers: [...(project.layers ?? []).filter(item => item.id !== layer.id), layer] });
const replaceLayer = (project: EditorProject, layer: EditorLayer) => ({ ...project, layers: (project.layers ?? []).map(item => item.id === layer.id ? layer : item) });
function span(at: number, duration: number | undefined, ctx: Ctx, fallback = 2.5) {
  const start = Math.min(toFrame(at, ctx), Math.max(0, ctx.total - 1)), end = Math.max(start + 1, Math.min(ctx.total, toFrame(at + (duration ?? fallback), ctx)));
  return [start, end] as const;
}
const describeLayer = (layer: EditorLayer, fps: number) => ({ id: layer.id, kind: layer.kind, name: layer.name, ...(layer.track ? { track: layer.track } : {}), start: +(layer.startFrame / fps).toFixed(2), end: +(layer.endFrame / fps).toFixed(2),
  x: layer.x, y: layer.y, width: layer.width, height: layer.height, ...(layer.style.text ? { text: layer.style.text } : {}), enter: layer.enter.preset, exit: layer.exit.preset,
  ...(layer.behind ? { behind: true } : {}), automated: layer.automation.map(lane => lane.param) });

// Storyboard commands. The assistant edits beats through these; a locked beat is the person's and is refused.
const board = (project: EditorProject): Storyboard => project.storyboard ?? { beats: [] };
function findBeat(project: EditorProject, id: string) { const beat = board(project).beats.find(b => b.id === id); if (!beat) throw new Error(`No beat "${id}". Beats: ${board(project).beats.map(b => b.id).join(', ') || 'none'}`); return beat; }
const unlocked = (beat: Beat) => { if (beat.locked) throw new Error(`Beat ${beat.label ?? beat.id} is locked by the person; ask them before changing it`); return beat; };
const withBoard = (project: EditorProject, next: Storyboard) => ({ ...project, storyboard: StoryboardSchema.parse({ ...next, beats: sortBeats(next.beats) }) });
const describeBeat = (beat: Beat, fps: number) => { const budget = wordBudget(beat, fps);
  return { id: beat.id, ...(beat.label ? { label: beat.label } : {}), start: +(beat.startFrame / fps).toFixed(2), end: +(beatEnd(beat) / fps).toFixed(2), seconds: +(beat.durationFrames / fps).toFixed(2), source: beat.source, words: beat.words,
    ...(beat.words ? { wordBudget: budget.budget, ...(budget.over ? { overBy: budget.over } : {}) } : {}), status: beat.status, ...(isPlaceholder(beat) ? { placeholder: true } : {}), ...(beat.locked ? { locked: true } : {}),
    ...(beat.shot ? { shot: beat.shot } : {}), ...(beat.arrive ? { arrive: beat.arrive } : {}), ...(beat.leave ? { leave: beat.leave } : {}), ...(beat.placeholders?.length ? { standIns: beat.placeholders } : {}),
    ...(beat.takes?.length ? { takes: beat.takes.length } : {}), ...(beat.generation ? { generation: beat.generation } : {}) }; };
const BeatFields = { label: z.string().max(80).optional(), words: z.string().max(4000).optional(), source: BeatSourceSchema.optional(), shot: z.string().max(4000).optional(),
  arrive: z.string().max(80).optional(), leave: z.string().max(80).optional(), standIns: z.array(z.string()).max(16).optional(), generation: BeatGenerationSchema.optional() };
const fieldsOf = (args: { label?: string; words?: string; source?: Beat['source']; shot?: string; arrive?: string; leave?: string; standIns?: string[]; generation?: Beat['generation'] }) => ({
  ...(args.label !== undefined ? { label: args.label } : {}), ...(args.words !== undefined ? { words: args.words } : {}), ...(args.source ? { source: args.source } : {}), ...(args.shot !== undefined ? { shot: args.shot } : {}),
  ...(args.arrive !== undefined ? { arrive: args.arrive } : {}), ...(args.leave !== undefined ? { leave: args.leave } : {}), ...(args.standIns ? { placeholders: args.standIns } : {}), ...(args.generation ? { generation: args.generation } : {}) });

export const ops = [
  op({ name: 'add_text', summary: 'Add a text layer with a look (impact = huge heavy caps; hero, gradient, statement, title, caption, label, pill, subtitle) and an in/out animation. Modern presets: blur-in (words rise out of a blur), chars (letters), streak (letters fly in from the right with motion blur — pair with style.drift ≈ -0.04 for a sliding title), scatter (letters assemble), zoom-blur (big and blurred to sharp), plus typewriter and words (spoken timing). style.swapWords cycles words after the text; style.countFrom counts the number in the text up. position = the text\'s centre (a name, or {x, y} as fractions of the frame, 0,0 top left); width = a fraction of the frame width (the text wraps to it); style.size = the text height as a fraction of the frame height (0.06 ≈ 65 px at 1080p; each look sets its own).',
    input: z.object({ text: z.string().min(1).max(2000), at: seconds, duration: seconds.optional(), look: z.enum(Object.keys(textLooks) as [TextLook, ...TextLook[]]).optional(),
      position: Position.optional(), width: z.number().min(0.05).max(1).optional(), enter: Animation.optional(), exit: Animation.optional(), style: LayerStyleSchema.optional(), behind: z.boolean().optional(), name: z.string().min(1).max(100).optional() }).strict(),
    apply: (project, args, ctx) => { const [start, end] = span(args.at, args.duration, ctx), [x, y] = where(args.position, args.look === 'caption' || args.look === 'subtitle' ? [0.5, 0.8] : [0.5, 0.5]);
      const base = createLayer('text', nextId(project, 'text'), start, end, {}, ctx.fps);
      const layer = createLayer('text', base.id, start, end, { name: args.name ?? args.text.slice(0, 40), x, y, width: args.width ?? (args.look === 'impact' ? 0.96 : base.width), ...(args.behind ? { behind: true } : {}),
        style: { ...textLooks[args.look ?? 'title'], ...(args.style ?? {}), text: args.text }, enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'set_ducking', summary: 'Sidechain ducking: the music dips while anyone speaks (narration or speech on the clips) and comes back between sentences. depthDb how far down (default 12), attackMs how early it starts dipping before a word (150), releaseMs how slowly it comes back (500). track = a music track id (default: every music track). off: true removes it. More depthDb = the music lower under speech: 3 dB is a small step, 6 dB a clear one.',
    input: z.object({ track: z.string().optional(), depthDb: z.number().min(1).max(40).optional(), attackMs: z.number().min(0).max(2000).optional(), releaseMs: z.number().min(0).max(5000).optional(), off: z.boolean().optional() }).strict(),
    apply: (project, args) => { const targets = project.audioTracks.filter(t => args.track ? t.id === args.track : t.role === 'music');
      if (!targets.length) throw new Error(args.track ? `No audio track ${args.track}` : 'No music track to duck: add music first');
      const duck = { depthDb: args.depthDb ?? defaultDuck.depthDb, attackMs: args.attackMs ?? defaultDuck.attackMs, releaseMs: args.releaseMs ?? defaultDuck.releaseMs };
      const ids = new Set(targets.map(t => t.id));
      return { project: { ...project, audioTracks: project.audioTracks.map(t => { if (!ids.has(t.id)) return t; if (args.off) { const { duck: _gone, ...rest } = t; return rest; } return { ...t, duck }; }) },
        result: args.off ? { unducked: [...ids] } : { ducked: [...ids], ...duck } }; } }),
  op({ name: 'set_audio_segment', summary: 'Shape one audio segment (a narration line, the music bed, a sound effect): gain (× on top of the track, 0–4), fadeIn / fadeOut (seconds, equal-power), or remove: true to delete it. Find ids with the project\'s audioTracks. gain multiplies the track\'s level (1 = as it is): read the current gain first; "louder" ≈ ×1.4 (+3 dB), "a little quieter" ≈ ×0.8 (−2 dB), ×2 = +6 dB.',
    input: z.object({ track: z.string(), segment: z.string(), gain: z.number().min(0).max(4).optional(), fadeIn: z.number().min(0).max(60).optional(), fadeOut: z.number().min(0).max(60).optional(), remove: z.boolean().optional() }).strict(),
    apply: (project, args) => { const track = project.audioTracks.find(t => t.id === args.track); if (!track) throw new Error(`No audio track ${args.track}`);
      if (!track.segments.some(s => s.id === args.segment)) throw new Error(`No segment ${args.segment} on ${args.track}`);
      const segments = args.remove ? track.segments.filter(s => s.id !== args.segment) : track.segments.map(s => s.id !== args.segment ? s : { ...s,
        ...(args.gain !== undefined ? { gain: args.gain } : {}), ...(args.fadeIn !== undefined ? { fadeInSeconds: args.fadeIn } : {}), ...(args.fadeOut !== undefined ? { fadeOutSeconds: args.fadeOut } : {}) });
      return { project: { ...project, audioTracks: project.audioTracks.map(t => t.id === track.id ? { ...t, segments } : t) }, result: args.remove ? 'removed' : 'shaped' }; } }),
  op({ name: 'set_transition', summary: 'How the picture (and sound) changes at a cut between clips: dissolve (the shots blend), dip-black / dip-white (through a colour), or cut (back to a plain cut). at = the cut in seconds (the nearest one within 0.75 s). At 0 the film fades up from black (or white); at the very end it fades out. seconds = length (default 0.6; 1 for the fade up/out).',
    input: z.object({ at: seconds, kind: z.enum(['cut', 'dissolve', 'dip-black', 'dip-white']), seconds: z.number().min(0.05).max(5).optional() }).strict(),
    apply: (project, args, ctx) => { const schedule = scheduleProject(project); if (!schedule.length) throw new Error('No clips to transition between');
      const f = toFrame(args.at, ctx), tol = Math.round(0.75 * ctx.fps), last = schedule.at(-1)!, end = last.startFrame + last.durationFrames;
      const edge = !schedule.some((s, i) => i > 0 && Math.abs(s.startFrame - f) <= tol);
      if (Math.abs(f - end) <= tol && edge) { const t = args.kind === 'cut' ? undefined : { kind: args.kind === 'dissolve' ? 'dip-black' as const : args.kind, seconds: args.seconds ?? 1 };
        return { project: { ...project, clips: project.clips.map(c => c.id !== last.clip.id ? c : t ? { ...c, transitionOut: t } : (({ transitionOut: _t, ...rest }) => rest)(c)) }, result: { clip: last.clip.id, out: t ?? 'cut' } }; }
      const target = schedule.reduce((best, s) => Math.abs(s.startFrame - f) < Math.abs(best.startFrame - f) ? s : best);
      if (Math.abs(target.startFrame - f) > tol) throw new Error(`No cut near ${args.at} s: cuts are at ${schedule.slice(1).map(s => (s.startFrame / ctx.fps).toFixed(2)).join(', ')} s`);
      const t = args.kind === 'cut' ? undefined : { kind: args.kind, seconds: args.seconds ?? (target === schedule[0] ? 1 : 0.6) };
      return { project: { ...project, clips: project.clips.map(c => c.id !== target.clip.id ? c : t ? { ...c, transitionIn: t } : (({ transitionIn: _t, ...rest }) => rest)(c)) },
        result: { clip: target.clip.id, at: +(target.startFrame / ctx.fps).toFixed(3), transition: t ?? 'cut' } }; } }),
  op({ name: 'set_format', summary: 'Show and export the edit in a platform format: youtube, youtube-shorts, tiktok, instagram-reels, instagram-story, instagram-feed, facebook-feed, linkedin, x, square, or original. Non-destructive: the edit stays as it is and the format is a reframed view (cameras follow the face, screens zoom and follow the pointer, text moves inside the platform\'s safe area). Switch back any time.',
    input: z.object({ format: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict(),
    apply: (project, args) => { if (args.format !== 'original' && !exportPresets.some(p => p.id === args.format)) throw new Error(`Unknown format; choose original or ${exportPresets.map(p => p.id).join(', ')}`);
      const preset = exportPresets.find(p => p.id === args.format);
      return { project: { ...project, delivery: { ...(project.delivery ?? {}), format: args.format } }, result: { format: args.format, size: preset ? `${preset.width}×${preset.height}` : `${project.output.width}×${project.output.height}` } }; } }),
  op({ name: 'set_master', summary: 'Master the soundtrack on export to a loudness target: lufs -14 (web, default; -16 for podcasts/voice-led; a higher number is louder, 1 LU is a small step), truePeak -1 dBTP. off: true removes it. earshot\'s critique checks integrated loudness against professional launch films.',
    input: z.object({ lufs: z.number().min(-30).max(-6).optional(), truePeak: z.number().min(-6).max(0).optional(), off: z.boolean().optional() }).strict(),
    apply: (project, args) => { if (args.off) { const { master: _gone, ...rest } = project; return { project: rest as EditorProject, result: 'unmastered' }; }
      const master = { lufs: args.lufs ?? -14, truePeak: args.truePeak ?? -1 }; return { project: { ...project, master }, result: master }; } }),
  op({ name: 'set_frame', summary: 'How the picture sits in the video: cameraFill makes camera shots fill the frame (films, talking heads, vertical) instead of the screen recording\'s shape; fullBleed fills the whole frame edge to edge (no wallpaper, corners or shadow — the look for talking heads and words-behind-the-speaker); otherwise set padding (px around the picture), radius (corner px) and shadow (0–1). padding and radius are pixels of the output size; shadow is the shadow\'s opacity (0 none, 1 full).',
    input: z.object({ cameraFill: z.boolean().optional(), fullBleed: z.boolean().optional(), padding: z.number().min(0).max(500).optional(), radius: z.number().min(0).max(300).optional(), shadow: z.number().min(0).max(1).optional() }).strict(),
    apply: (project, args) => { const p = project.presentation;
      const presentation = args.fullBleed ? { ...p, padding: 0, inset: 0, radius: 0, shadow: { ...p.shadow, opacity: 0 } }
        : { ...p, ...(args.padding !== undefined ? { padding: args.padding } : {}), ...(args.radius !== undefined ? { radius: args.radius } : {}), ...(args.shadow !== undefined ? { shadow: { ...p.shadow, opacity: args.shadow } } : {}) };
      const filled = args.cameraFill === undefined ? presentation : { ...presentation, cameraFill: args.cameraFill };
      return { project: { ...project, presentation: filled }, result: { padding: filled.padding, radius: filled.radius, cameraFill: !!filled.cameraFill } }; } }),
  op({ name: 'set_canvas', summary: 'Blank-canvas projects (made with New project / new-blank, no recording): set the film\'s length in seconds. Longer holds the canvas; shorter trims it. Layers past the new end are cut off. Change the look with add_background, not here.',
    input: z.object({ seconds: z.number().min(0.5).max(600) }).strict(),
    apply: (project, args) => {
      const clip = project.clips.length === 1 ? project.clips[0]! : null, asset = clip ? project.assets.find(a => a.id === clip.assetId) : undefined;
      if (!clip || !asset?.provenance?.blank || !asset.sourceFps || !asset.sourceFrames) throw new Error('set_canvas only changes the length of a blank-canvas project (one made without a recording)');
      const fps = project.output.fps, canvasSeconds = asset.sourceFrames / asset.sourceFps;
      const next = args.seconds <= canvasSeconds
        ? { ...clip, trimStartSourceFrame: 0, trimEndSourceFrame: Math.max(1, Math.round(args.seconds * asset.sourceFps)), holdEndFrames: 0, playbackRate: 1 }
        : { ...clip, trimStartSourceFrame: 0, trimEndSourceFrame: asset.sourceFrames, holdEndFrames: Math.round((args.seconds - canvasSeconds) * fps), playbackRate: 1 };
      return { project: { ...project, clips: [next] }, result: { seconds: args.seconds } }; } }),
  op({ name: 'add_callout', summary: 'Add a box (outline), highlight (glowing marker) or spotlight (dims everything else) over an area of the frame. x, y = the area\'s centre and width, height its size, all fractions of the frame (0,0 top left).',
    input: z.object({ kind: z.enum(['box', 'highlight', 'spotlight']), x: fraction, y: fraction, width: z.number().min(0.01).max(3), height: z.number().min(0.01).max(3),
      at: seconds, duration: seconds.optional(), color: z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/).optional(), enter: Animation.optional(), exit: Animation.optional(), style: LayerStyleSchema.optional(), name: z.string().min(1).max(100).optional() }).strict(),
    apply: (project, args, ctx) => { const [start, end] = span(args.at, args.duration, ctx), base = createLayer(args.kind, nextId(project, args.kind), start, end, {}, ctx.fps);
      const colored = args.color ? args.kind === 'highlight' ? { stroke: args.color, background: `${args.color.slice(0, 7)}55` } : { stroke: args.color } : {};
      const layer = createLayer(args.kind, base.id, start, end, { name: args.name ?? layerKindInfo[args.kind].label, x: args.x, y: args.y, width: args.width, height: args.height,
        style: { ...base.style, ...colored, ...(args.style ?? {}) }, enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_notification', summary: 'A glass macOS/iOS-style notification that drops in from the top and types its message — great for "Payment received", "New email", app alerts. Stack several by giving later ones a lower y.',
    input: z.object({ app: z.string().min(1).max(60), text: z.string().min(1).max(300), title: z.string().max(300).optional(), icon: z.string().max(12).optional(), at: seconds, duration: seconds.optional(),
      position: Position.optional(), width: z.number().min(0.1).max(0.9).optional(), enter: Animation.optional(), exit: Animation.optional(), style: LayerStyleSchema.optional() }).strict(),
    apply: (project, args, ctx) => { const [start, end] = span(args.at, args.duration, ctx, 3), base = createLayer('notification', nextId(project, 'notification'), start, end, {}, ctx.fps), [x, y] = where(args.position, [base.x, base.y]);
      const layer = createLayer('notification', base.id, start, end, { name: args.app, x, y, width: args.width ?? base.width, style: { ...base.style, ...(args.style ?? {}), app: args.app, text: args.text, ...(args.title ? { title: args.title } : {}), ...(args.icon ? { icon: args.icon } : {}) },
        enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_card', summary: 'A floating glass card with an avatar (image asset id or emoji icon), a line that types in and placeholder lines — like a DM, offer or profile.',
    input: z.object({ text: z.string().min(1).max(300), title: z.string().max(300).optional(), assetId: z.string().optional(), icon: z.string().max(12).optional(), at: seconds, duration: seconds.optional(),
      position: Position.optional(), width: z.number().min(0.1).max(0.95).optional(), enter: Animation.optional(), exit: Animation.optional(), style: LayerStyleSchema.optional() }).strict(),
    apply: (project, args, ctx) => { const [start, end] = span(args.at, args.duration, ctx, 3), base = createLayer('card', nextId(project, 'card'), start, end, {}, ctx.fps), [x, y] = where(args.position, [0.5, 0.5]);
      if (args.assetId && !project.assets.some(asset => asset.id === args.assetId && asset.kind === 'image')) throw new Error('assetId must be an image in this project');
      const layer = createLayer('card', base.id, start, end, { name: 'Card', x, y, width: args.width ?? base.width, ...(args.assetId ? { assetId: args.assetId } : {}),
        style: { ...base.style, ...(args.style ?? {}), text: args.text, ...(args.title ? { title: args.title } : {}), ...(args.icon ? { icon: args.icon } : {}) }, enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_chips', summary: 'A stack of pills (✓ icon + text) popping in one after another — features, steps, things an agent does. stagger = frames between pills.',
    input: z.object({ items: z.array(z.string().min(1).max(160)).min(1).max(12), at: seconds, duration: seconds.optional(), position: Position.optional(), width: z.number().min(0.1).max(0.9).optional(),
      color: z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/).optional(), stagger: z.number().min(0).max(30).optional(), enter: Animation.optional(), exit: Animation.optional(), style: LayerStyleSchema.optional() }).strict(),
    apply: (project, args, ctx) => { const [start, end] = span(args.at, args.duration, ctx, 3), base = createLayer('chips', nextId(project, 'chips'), start, end, {}, ctx.fps), [x, y] = where(args.position, [base.x, base.y]);
      const layer = createLayer('chips', base.id, start, end, { name: args.items[0]!.slice(0, 40), x, y, width: args.width ?? base.width,
        style: { ...base.style, ...(args.style ?? {}), items: args.items, ...(args.color ? { background: args.color } : {}), ...(args.stagger !== undefined ? { stagger: args.stagger } : {}) },
        enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_waveform', summary: 'A waveform that grows in from the centre and keeps moving — "sound", "voice", "listening". style.variant bars | mirror | dots | line | radial; color→color2 gradient, glow, gap, roundness, amp, speed, count; source voice|music|all moves it with the film\'s audio.',
    input: z.object({ at: seconds, duration: seconds.optional(), position: Position.optional(), width: z.number().min(0.05).max(1).optional(), height: z.number().min(0.02).max(0.6).optional(),
      color: z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/).optional(), count: z.number().int().min(4).max(120).optional(), spike: z.boolean().optional(), enter: Animation.optional(), exit: Animation.optional(), style: LayerStyleSchema.optional() }).strict(),
    apply: (project, args, ctx) => { const [start, end] = span(args.at, args.duration, ctx, 3), base = createLayer('waveform', nextId(project, 'waveform'), start, end, {}, ctx.fps), [x, y] = where(args.position, [base.x, base.y]);
      const layer = createLayer('waveform', base.id, start, end, { name: 'Waveform', x, y, width: args.width ?? base.width, height: args.height ?? base.height,
        style: { ...base.style, ...(args.style ?? {}), ...(args.color ? { color: args.color } : {}), ...(args.count ? { count: args.count } : {}), ...(args.spike !== undefined ? { spike: args.spike } : {}) },
        enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_scene', summary: 'Place a code scene: an animated graphic the agent wrote as React code (write_studio_scene compiles and keeps it; add_studio_scene places it). sceneId is the scene\'s id; the scene fills the box (default the whole frame), its frame 0 is the layer start, and its code runs only inside the layer\'s locked frame.',
    input: z.object({ sceneId: z.string().regex(/^[a-f0-9]{16}$/), name: z.string().min(1).max(100).optional(), props: SceneProps.optional(), fonts: z.array(z.string().max(80)).max(12).optional(),
      at: seconds, duration: seconds.optional(), x: fraction.optional(), y: fraction.optional(), width: z.number().min(0.02).max(3).optional(), height: z.number().min(0.02).max(3).optional(),
      clip: z.boolean().optional(), behind: z.boolean().optional(), enter: Animation.optional(), exit: Animation.optional() }).strict(),
    apply: (project, args, ctx) => { const [start, end] = span(args.at, args.duration, ctx, 4), base = createLayer('code', nextId(project, 'scene'), start, end, {}, ctx.fps);
      const layer = createLayer('code', base.id, start, end, { name: args.name ?? 'Scene', x: args.x ?? base.x, y: args.y ?? base.y, width: args.width ?? base.width, height: args.height ?? base.height, ...(args.behind ? { behind: true } : {}),
        style: { ...base.style, scene: { id: args.sceneId, name: args.name ?? 'scene', ...(args.props ? { props: args.props } : {}), ...(args.fonts?.length ? { fonts: args.fonts } : {}) }, ...(args.clip ? { clip: true } : {}) },
        enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_icons', summary: 'A row of icons popping in one after another (newest note in the accent colour). Icons: note, key, toggle (a cursor switches it on), bubbles (burst), dash (flies off), check, spark, play, film, cursor, mark (the Studio mark). Each gets its own sound: notes climb a little melody.',
    input: z.object({ items: z.array(z.enum(['note', 'key', 'toggle', 'bubbles', 'dash', 'check', 'spark', 'play', 'film', 'cursor', 'mark'])).min(1).max(10), at: seconds, duration: seconds.optional(), position: Position.optional(),
      width: z.number().min(0.05).max(1).optional(), height: z.number().min(0.02).max(0.6).optional(), color: z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/).optional(), accent: z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/).optional(),
      stagger: z.number().min(0).max(60).optional(), enter: Animation.optional(), exit: Animation.optional(), style: LayerStyleSchema.optional() }).strict(),
    apply: (project, args, ctx) => { const [start, end] = span(args.at, args.duration, ctx, 3), base = createLayer('icons', nextId(project, 'icons'), start, end, {}, ctx.fps), [x, y] = where(args.position, [base.x, base.y]);
      const layer = createLayer('icons', base.id, start, end, { name: `Icons · ${args.items.join(' ')}`.slice(0, 40), x, y, width: args.width ?? Math.min(0.8, 0.09 * args.items.length + 0.04), height: args.height ?? base.height,
        style: { ...base.style, ...(args.style ?? {}), items: args.items, ...(args.color ? { color: args.color } : {}), ...(args.accent ? { accent: args.accent } : {}), ...(args.stagger !== undefined ? { stagger: args.stagger } : {}) },
        enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_ring', summary: 'A dashed circle that draws itself in and spins, with an accent arc sweeping ahead — a reveal around a logo or icon (a riser into a bell). size = fraction of frame height.',
    input: z.object({ at: seconds, duration: seconds.optional(), position: Position.optional(), size: z.number().min(0.05).max(1).optional(), color: z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/).optional(),
      strokeWidth: z.number().min(1).max(16).optional(), enter: Animation.optional(), exit: Animation.optional(), style: LayerStyleSchema.optional() }).strict(),
    apply: (project, args, ctx) => { const [start, end] = span(args.at, args.duration, ctx, 3), base = createLayer('ring', nextId(project, 'ring'), start, end, {}, ctx.fps), [x, y] = where(args.position, [base.x, base.y]);
      const h = args.size ?? 0.36, w = h * project.output.height / project.output.width;
      const layer = createLayer('ring', base.id, start, end, { name: 'Ring', x, y, width: w, height: h,
        style: { ...base.style, ...(args.style ?? {}), ...(args.color ? { color: args.color } : {}), ...(args.strokeWidth ? { strokeWidth: args.strokeWidth } : {}) },
        enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_particles', summary: 'Dots that travel from shape to shape on springs — the connective tissue of a motion-graphics film: text bursting into dots (scatter over the text box, then a line), a wobbly line becoming a wave, then waveform bars, dots gathering on icon positions (points), swirling into a spinning ring (ring, spin, order "angle"), collapsing into a logo (point, opacity 0). forms[i].at = seconds from the layer start when the dots set off for that shape; duration/bounce = the spring; stagger = spread of start times across dots. Fast dots draw as streaks (motion blur). Covers the whole frame.',
    input: z.object({ forms: z.array(ParticleFormSchema).min(1).max(40), at: seconds, duration: seconds.optional(), count: z.number().int().min(4).max(120).optional(), motionBlur: z.number().min(0).max(3).optional(),
      enter: Animation.optional(), exit: Animation.optional(), name: z.string().min(1).max(100).optional() }).strict(),
    apply: (project, args, ctx) => { const [start, end] = span(args.at, args.duration, ctx, 4), base = createLayer('particles', nextId(project, 'particles'), start, end, {}, ctx.fps);
      const forms = [...args.forms].sort((a, b) => a.at - b.at);
      const layer = createLayer('particles', base.id, start, end, { name: args.name ?? `Particles · ${forms.map(f => f.shape).join(' → ')}`.slice(0, 100),
        style: { count: args.count ?? 40, forms, ...(args.motionBlur !== undefined ? { motionBlur: args.motionBlur } : {}) }, enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_image', summary: 'Put an image or video asset of the project on screen (logo, avatar, product shot, or a captured product component from capture-component — transparent .webm keeps its alpha and plays from the layer start); it pops in and can float gently (style.float ≈ 0.01). width/height = its box: keep the asset\'s aspect ratio.',
    input: z.object({ assetId: z.string(), at: seconds, duration: seconds.optional(), x: fraction, y: fraction, width: z.number().min(0.01).max(1.5), height: z.number().min(0.01).max(1.5), behind: z.boolean().optional(), 
      enter: Animation.optional(), exit: Animation.optional(), style: LayerStyleSchema.optional() }).strict(),
    apply: (project, args, ctx) => { if (!project.assets.some(asset => asset.id === args.assetId && (asset.kind === 'image' || asset.kind === 'video'))) throw new Error('assetId must be an image or video in this project');
      const [start, end] = span(args.at, args.duration, ctx), base = createLayer('image', nextId(project, 'image'), start, end, {}, ctx.fps);
      const layer = createLayer('image', base.id, start, end, { name: 'Image', assetId: args.assetId, ...(args.behind ? { behind: true } : {}), x: args.x, y: args.y, width: args.width, height: args.height, style: { ...base.style, ...(args.style ?? {}) },
        enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_background', summary: 'Fill the whole frame for a title beat between screens (or, with behind: true and a subject cut-out, replace the speaker\'s background): mesh (soft colour blobs on light), glow (dark with a coloured orb), gradient, solid, or image (a photo asset, optionally blurred). Put text on top with add_text.',
    input: z.object({ fill: z.enum(['mesh', 'glow', 'gradient', 'solid', 'image']), at: seconds, duration: seconds.optional(), color: z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/).optional(),
      color2: z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/).optional(), assetId: z.string().optional(), blur: z.number().min(0).max(120).optional(), behind: z.boolean().optional(), enter: Animation.optional(), exit: Animation.optional() }).strict(),
    apply: (project, args, ctx) => { if (args.fill === 'image' && !project.assets.some(asset => asset.id === args.assetId && asset.kind === 'image')) throw new Error('fill "image" needs assetId of an image in this project');
      const [start, end] = span(args.at, args.duration, ctx, 1.5), base = createLayer('background', nextId(project, 'background'), start, end, {}, ctx.fps);
      const layer = createLayer('background', base.id, start, end, { name: `Background · ${args.fill}`, ...(args.assetId ? { assetId: args.assetId } : {}), ...(args.behind ? { behind: true } : {}),
        style: { ...base.style, fill: args.fill, ...(args.color ? { color: args.color } : args.fill === 'glow' ? { color: '#2f6bff' } : {}), ...(args.color2 ? { color2: args.color2 } : {}), ...(args.blur !== undefined ? { blur: args.blur } : {}) },
        enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_arrow', summary: 'Add an arrow that draws itself in and points at a spot (tip x/y), starting from another spot.',
    input: z.object({ x: fraction, y: fraction, fromX: fraction.optional(), fromY: fraction.optional(), at: seconds, duration: seconds.optional(), color: z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/).optional(),
      curve: z.number().min(-1).max(1).optional(), enter: Animation.optional(), exit: Animation.optional() }).strict(),
    apply: (project, args, ctx) => { const [start, end] = span(args.at, args.duration, ctx), base = createLayer('arrow', nextId(project, 'arrow'), start, end, {}, ctx.fps);
      const layer = createLayer('arrow', base.id, start, end, { x: args.x, y: args.y, style: { ...base.style, fromX: args.fromX ?? Math.max(0.05, args.x - 0.18), fromY: args.fromY ?? Math.max(0.05, args.y - 0.18),
        ...(args.color ? { stroke: args.color } : {}), ...(args.curve !== undefined ? { curve: args.curve } : {}) }, enter: animation(args.enter, base.enter, ctx.fps), exit: animation(args.exit, base.exit, ctx.fps) }, ctx.fps);
      return { project: withLayer(project, layer), result: { id: layer.id } }; } }),
  op({ name: 'add_kinetic_captions', summary: 'Turn the spoken words into big word-by-word captions (TikTok style): one text layer per short phrase, each word landing as it is said. look "impact" + behind: true = two giant words at a time behind the speaker (needs a subject cut-out: the cutout command / POST /api/projects/:id/cutouts); grade the footage black and white with set_automation saturation 0 so the colour pops.',
    input: z.object({ from: seconds.optional(), to: seconds.optional(), wordsPerPhrase: z.number().int().min(1).max(8).optional(), look: z.enum(Object.keys(textLooks) as [TextLook, ...TextLook[]]).optional(),
      position: Position.optional(), style: LayerStyleSchema.optional(), replace: z.boolean().optional(), behind: z.boolean().optional() }).strict(),
    apply: (project, args, ctx) => {
      const from = toFrame(args.from ?? 0, ctx), to = args.to === undefined ? ctx.total : toFrame(args.to, ctx), per = args.wordsPerPhrase ?? (args.look === 'impact' ? 2 : 3);
      const words = transcriptWords(project).filter(word => word.timingReliable && word.startFrame >= from && word.startFrame < to);
      if (!words.length) throw new Error('No transcribed words in that range — transcribe the recording first');
      let next: EditorProject = args.replace === false ? project : { ...project, layers: (project.layers ?? []).filter(layer => !layer.id.startsWith('kinetic-')) };
      const [x, y] = where(args.position, args.look === 'impact' ? [0.5, 0.36] : [0.5, 0.78]), ids: string[] = [];
      // Phrases break on punctuation or every `per` words; each shows until the next starts (or ~0.6 s after its last word).
      const phrases: typeof words[] = [];
      for (const word of words) { const current = phrases.at(-1); if (!current || current.length >= per || /[.!?,;:]$/.test(current.at(-1)!.text) || word.startFrame - current.at(-1)!.endFrame > ctx.fps * 0.6) phrases.push([word]); else current.push(word); }
      phrases.forEach((phrase, index) => { const start = phrase[0]!.startFrame, nextStart = phrases[index + 1]?.[0]?.startFrame ?? ctx.total;
        const end = Math.max(start + 1, Math.min(nextStart, phrase.at(-1)!.endFrame + Math.round(ctx.fps * 0.6), ctx.total));
        const id = nextId(next, 'kinetic');
        const layer = createLayer('text', id, start, end, { name: 'Caption', track: 'captions', x, y, width: args.look === 'impact' ? 0.96 : 0.86, ...(args.behind ? { behind: true } : {}), style: { ...textLooks[args.look ?? 'caption'], ...(args.style ?? {}), text: phrase.map(word => word.text.replace(/[,;:]$/, '')).join(' '),
          wordFrames: phrase.map(word => word.startFrame - start) }, enter: { preset: 'words', frames: Math.max(1, end - start) }, exit: { preset: 'none', frames: 1 } }, ctx.fps);
        next = withLayer(next, layer); ids.push(id); });
      return { project: next, result: { added: ids.length, ids } }; } }),
  op({ name: 'update_layer', summary: 'Change a layer: text, timing (start/end seconds), position/size, look/style, in/out animation, opacity or rotation. Give only what changes: style merges into the layer\'s, a look replaces the keys it sets. For a relative change read the layer\'s current values first. x, y = its centre as fractions of the frame (0,0 top left; "a little up" ≈ y − 0.04); width, height = fractions of the frame (text wraps to width); style.size = text height as a fraction of the frame height (0.06 ≈ 65 px at 1080p; "bigger" ≈ ×1.25 the current size, "much bigger" ×1.5–2, and widen width to match); opacity 0–1; rotate degrees; enter/exit seconds = the animation\'s length.',
    input: z.object({ id: z.string(), text: z.string().min(1).max(2000).optional(), start: seconds.optional(), end: seconds.optional(), x: fraction.optional(), y: fraction.optional(),
      width: z.number().min(0.0005).max(3).optional(), height: z.number().min(0.0005).max(3).optional(), opacity: z.number().min(0).max(1).optional(), rotate: z.number().min(-360).max(360).optional(),
      look: z.enum(Object.keys(textLooks) as [TextLook, ...TextLook[]]).optional(), style: LayerStyleSchema.optional(), enter: Animation.optional(), exit: Animation.optional(), behind: z.boolean().optional(), name: z.string().min(1).max(100).optional() }).strict(),
    apply: (project, args, ctx) => { const layer = findLayer(project, args.id);
      const startFrame = args.start !== undefined ? toFrame(args.start, ctx) : layer.startFrame, endFrame = args.end !== undefined ? toFrame(args.end, ctx) : layer.endFrame;
      const style = { ...layer.style, ...(args.look ? textLooks[args.look] : {}), ...(args.style ?? {}), ...(args.text ? { text: args.text } : {}) };
      if (args.text && style.wordFrames && style.wordFrames.length !== args.text.trim().split(/\s+/).length) delete style.wordFrames;
      const updated: EditorLayer = { ...layer, startFrame, endFrame, style, enter: animation(args.enter, layer.enter, ctx.fps), exit: animation(args.exit, layer.exit, ctx.fps),
        ...Object.fromEntries((['x', 'y', 'width', 'height', 'opacity', 'rotate', 'name', 'behind'] as const).filter(key => args[key] !== undefined).map(key => [key, args[key]])) };
      return { project: replaceLayer(project, updated), result: describeLayer(updated, ctx.fps) }; } }),
  op({ name: 'remove_layer', summary: 'Delete a layer.', input: z.object({ id: z.string() }).strict(),
    apply: (project, args) => { findLayer(project, args.id); return { project: { ...project, layers: (project.layers ?? []).filter(layer => layer.id !== args.id) } }; } }),
  op({ name: 'set_automation', summary: `Write automation points. target "main" automates the whole picture (${mainParams.join(', ')}); target a layer id automates that layer (${layerParams.join(', ')}). mode "replace" swaps the lane; "splice" (default) rewrites only the span the points cover. Each point's curve shapes the segment ending at it: smooth (eased), linear or hold (step). Values are in each parameter's own unit (the automation catalog gives min, max and neutral: zoom 1 = the whole frame, volume 1 = as recorded and 2 ≈ +6 dB, a layer's scale 1 = its own size); for a relative change read the lane's current points first.`,
    input: z.object({ target: z.string(), param: z.string(), points: z.array(PointInput).min(1).max(2000), mode: z.enum(['splice', 'replace']).optional() }).strict(),
    apply: (project, args, ctx) => { const points: AutomationPoint[] = args.points.map(point => ({ frame: toFrame(point.time, ctx), value: point.value, ...(point.curve ? { curve: point.curve } : {}) }));
      const merge = (current: AutomationPoint[], info: { neutral: number; min: number; max: number }) => {
        if (args.mode === 'replace') return points;
        const lo = Math.min(...points.map(point => point.frame)), hi = Math.max(...points.map(point => point.frame));
        return hi === lo ? [...current.filter(point => point.frame !== lo), ...points] : spliceCurve(current, lo, hi, points, info.neutral, info.min, info.max);
      };
      if (args.target === 'main') { if (!(mainParams as string[]).includes(args.param)) throw new Error(`Main picture can automate: ${mainParams.join(', ')}`);
        const param = args.param as AutomationParam; return { project: setLanePoints(project, param, merge(lanePoints(project, param), paramInfo(param))) }; }
      const layer = findLayer(project, args.target); if (!(layerParams as readonly string[]).includes(args.param)) throw new Error(`Layers can automate: ${layerParams.join(', ')}`);
      const param = args.param as LayerParam;
      return { project: replaceLayer(project, setLayerLane(layer, param, merge(layerLanePoints(layer, param), layerParamInfo(layer, param)))) }; } }),
  op({ name: 'clear_automation', summary: 'Remove automation points from a lane (optionally only between from/to seconds). Omit param to clear every lane of the target.',
    input: z.object({ target: z.string(), param: z.string().optional(), from: seconds.optional(), to: seconds.optional() }).strict(),
    apply: (project, args, ctx) => { const from = args.from === undefined ? 0 : toFrame(args.from, ctx), to = args.to === undefined ? Number.MAX_SAFE_INTEGER : toFrame(args.to, ctx);
      if (args.target === 'main') { let next = project;
        for (const param of args.param ? [args.param as AutomationParam] : mainParams) { if (!(mainParams as string[]).includes(param)) throw new Error(`Main picture can automate: ${mainParams.join(', ')}`); next = setLanePoints(next, param, erasePoints(lanePoints(next, param), from, to)); }
        return { project: next }; }
      let layer = findLayer(project, args.target);
      for (const param of args.param ? [args.param as LayerParam] : layerParams) layer = setLayerLane(layer, param, erasePoints(layerLanePoints(layer, param), from, to));
      return { project: replaceLayer(project, layer) }; } }),
  op({ name: 'add_transition', summary: `Add a transition on the main picture centred at a time (usually a cut or shot change): ${transitionKinds.map(item => item.id).join(', ')}. Written as editable automation.`,
    input: z.object({ at: seconds, kind: z.enum(transitionKinds.map(item => item.id) as [TransitionKind, ...TransitionKind[]]), duration: z.number().min(0.1).max(3).optional() }).strict(),
    apply: (project, args, ctx) => ({ project: addTransition(project, toFrame(args.at, ctx), args.kind, ctx.total, args.duration ? Math.round(args.duration * ctx.fps) : undefined) }) }),
  op({ name: 'set_shot', summary: 'Choose what is on screen between two times. main = one source (screen, slides, camera, or an extra recorded window/camera id from show_project "sources", e.g. src-window-1 for iPhone Mirroring). layout = several at once: split (side by side; ratio = the first source\'s share: 0.5, 0.6, 0.75), stack (top/bottom), pip (first full, second in a corner), grid (3–4 sources). The first layout source is the main one; for pip, inset {x,y,width,height} (fractions of the picture) places the corner window. bubble shows or hides the round webcam. Times snap to clip boundaries where a cut is not possible.',
    input: z.object({ from: seconds, to: seconds, main: z.string().optional(), bubble: z.boolean().optional(),
      layout: z.object({ kind: z.enum(['split', 'stack', 'pip', 'grid']), sources: z.array(z.string()).min(2).max(4), ratio: z.number().min(0.15).max(0.85).optional(),
        inset: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.08).max(0.9), height: z.number().min(0.08).max(0.9) }).strict().optional() }).strict().optional() }).strict(),
    apply: (project, args, ctx) => { const patch: Partial<ClipView> = {};
      if (args.layout) { patch.layout = args.layout; patch.main = args.layout.sources[0]!; if (args.layout.sources.includes('camera')) patch.bubble = false; }
      else if (args.main) patch.main = args.main;
      if (args.bubble !== undefined) patch.bubble = args.bubble;
      if (!Object.keys(patch).length) throw new Error('Give main, layout or bubble');
      return { project: setShotRange(project, toFrame(args.from, ctx), Math.max(toFrame(args.to, ctx), toFrame(args.from, ctx) + 1), patch) }; } }),
  op({ name: 'list_shots', summary: 'The Layout track: each stretch of the timeline with what is on screen (one source or a layout of several).', input: z.object({}).strict(),
    apply: (project, _args, ctx) => ({ project, result: shotSegments(project).map(segment => ({ start: +(segment.from / ctx.fps).toFixed(2), end: +(segment.to / ctx.fps).toFixed(2), main: segment.view.main, bubble: segment.view.bubble, ...(segment.view.layout ? { layout: segment.view.layout } : {}) })) }) }),
  op({ name: 'add_zoom', summary: 'Zoom the picture in at a time, hold, and ease back out. x/y (0–1) is where to look (e.g. a click position on the screen recording). scale = magnification (1 = the whole frame; 1.8 by default; "closer" ≈ +0.4); hold = seconds held at full zoom. It writes the zoom automation lane (and panX, panY when x/y are given).',
    input: z.object({ at: seconds, hold: z.number().min(0).max(60).optional(), scale: z.number().min(1.05).max(4).optional(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional() }).strict(),
    apply: (project, args, ctx) => ({ project: addZoomBump(project, toFrame(args.at, ctx), ctx.total, args.scale ?? 1.8, args.hold ?? 1.5, args.x, args.y) }) }),
  op({ name: 'list_layers', summary: 'List the layers with their timing, position, animation and automated parameters.', input: z.object({}).strict(),
    apply: (project, _args, ctx) => ({ project, result: (project.layers ?? []).map(layer => describeLayer(layer, ctx.fps)) }) }),
  op({ name: 'storyboard', summary: 'The storyboard: every beat in order with its time, words (and the words its length can hold), picture source (camera:A/B…, screen, generated, scene, component), status, lock and notes. Placeholders are beats still waiting for their recording.',
    input: z.object({}).strict(), apply: (project, _args, ctx) => ({ project, result: { beats: board(project).beats.map(beat => describeBeat(beat, ctx.fps)), ...(project.storyboard?.inputs ? { inputs: project.storyboard.inputs } : {}), ...(project.storyboard?.cast?.length ? { cast: project.storyboard.cast } : {}),
      spentCredits: Math.round(board(project).beats.reduce((n, b) => n + (b.generation?.spentCredits ?? 0), 0) * 100) / 100 } }) }),
  op({ name: 'storyboard_from_script', summary: 'Start the storyboard from script lines laid end to end from `at` seconds (each line: text, seconds, label, source). Replaces the beats that are still planned and unlocked; recorded or locked beats stay.',
    input: z.object({ at: seconds.optional(), reference: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(), lines: z.array(z.object({ text: z.string().max(4000), seconds: z.number().min(0.3).max(600).optional(), label: z.string().max(80).optional(), source: BeatSourceSchema.optional(), shot: z.string().max(4000).optional() }).strict()).min(1).max(200) }).strict(),
    apply: (project, args, ctx) => { const kept = board(project).beats.filter(b => b.locked || b.status !== 'planned');
      if (kept.length) throw new Error(`Beats ${kept.map(b => b.label ?? b.id).join(', ')} are recorded or locked; edit beats one at a time instead`);
      const beats = beatsFromScript(args.lines, ctx.fps, { startFrame: toFrame(args.at ?? 0, ctx) }).map((beat, i) => ({ ...beat, ...(args.lines[i]!.source ? { source: args.lines[i]!.source! } : {}), ...(args.lines[i]!.shot ? { shot: args.lines[i]!.shot } : {}) }));
      return { project: withBoard(project, { ...board(project), beats, ...(args.reference ? { referenceAssetId: args.reference, blueprintId: args.reference } : {}) }), result: beats.map(b => describeBeat(b, ctx.fps)) }; } }),
  op({ name: 'add_beat', summary: 'Add a beat at a time (seconds) for a length. It must not overlap another beat: make room first with update_beat.',
    input: z.object({ at: seconds, seconds: z.number().min(0.1).max(600), ...BeatFields }).strict(),
    apply: (project, args, ctx) => { const beat: Beat = { id: newBeatId(project.storyboard), words: '', startFrame: toFrame(args.at, ctx), durationFrames: Math.max(1, Math.round(args.seconds * ctx.fps)), source: 'camera:A', status: 'planned', ...fieldsOf(args) };
      return { project: withBoard(project, { ...board(project), beats: [...board(project).beats, beat] }), result: { id: beat.id } }; } }),
  op({ name: 'update_beat', summary: 'Change a beat: words, label, source, shot notes, arrive/leave, stand-in layers, generation plan, or its timing (start/seconds). Locked beats are refused.',
    input: z.object({ id: z.string(), start: seconds.optional(), seconds: z.number().min(0.1).max(600).optional(), ...BeatFields }).strict(),
    apply: (project, args, ctx) => { const beat = unlocked(findBeat(project, args.id));
      const next: Beat = { ...beat, ...fieldsOf(args), ...(args.start !== undefined ? { startFrame: toFrame(args.start, ctx) } : {}), ...(args.seconds !== undefined ? { durationFrames: Math.max(1, Math.round(args.seconds * ctx.fps)) } : {}) };
      return { project: withBoard(project, { ...board(project), beats: board(project).beats.map(b => b.id === beat.id ? next : b) }), result: describeBeat(next, ctx.fps) }; } }),
  op({ name: 'split_beat', summary: 'Split a beat in two at a time (seconds); words are split at `wordIndex` (the first part keeps words before it).',
    input: z.object({ id: z.string(), at: seconds, wordIndex: z.number().int().min(0).max(2000).optional() }).strict(),
    apply: (project, args, ctx) => { const beat = unlocked(findBeat(project, args.id)), cut = toFrame(args.at, ctx);
      if (cut <= beat.startFrame || cut >= beatEnd(beat)) throw new Error('Split inside the beat');
      const words = beat.words.trim().split(/\s+/).filter(Boolean), k = args.wordIndex ?? Math.round(words.length * (cut - beat.startFrame) / beat.durationFrames);
      const first: Beat = { ...beat, durationFrames: cut - beat.startFrame, words: words.slice(0, k).join(' ') };
      const second: Beat = { ...beat, id: newBeatId(project.storyboard), label: beat.label ? `${beat.label} (2)`.slice(0, 80) : undefined, startFrame: cut, durationFrames: beatEnd(beat) - cut, words: words.slice(k).join(' '), takes: undefined };
      if (!second.label) delete second.label; delete second.takes;
      return { project: withBoard(project, { ...board(project), beats: [...board(project).beats.filter(b => b.id !== beat.id), first, second] }), result: { ids: [first.id, second.id] } }; } }),
  op({ name: 'reorder_beats', summary: 'Put planned beats in a new order (give every beat id); they are laid end to end. Beats with footage can\'t move this way.',
    input: z.object({ order: z.array(z.string()).min(1).max(300) }).strict(),
    apply: (project, args) => { const before = sortBeats(board(project).beats); const moved = before.find((b, i) => b.locked && args.order[i] !== b.id); if (moved) unlocked(moved);
      return { project: withBoard(project, reorderBeats(board(project), args.order)) }; } }),
  op({ name: 'remove_beat', summary: 'Delete a beat from the storyboard (its footage and layers stay on the timeline).',
    input: z.object({ id: z.string() }).strict(),
    apply: (project, args) => { const beat = unlocked(findBeat(project, args.id)); return { project: withBoard(project, { ...board(project), beats: board(project).beats.filter(b => b.id !== beat.id) }) }; } }),
  op({ name: 'set_cast', summary: 'Add or change a cast entry for generated shots: a person (only from their own photos, with their consent), a prop or a location, with reference images (asset ids in this project). Beats reference cast by id in generation.references.',
    input: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), name: z.string().min(1).max(80), kind: z.enum(['person', 'prop', 'location']), assetIds: z.array(z.string()).min(1).max(12), notes: z.string().max(2000).optional(), consent: z.boolean().optional() }).strict(),
    apply: (project, args) => { for (const a of args.assetIds) if (!project.assets.some(x => x.id === a && x.kind === 'image')) throw new Error(`${a} is not an image in this project`);
      if (args.kind === 'person' && !args.consent) throw new Error('A person in the cast needs their consent (consent: true): only use photos of someone who agreed');
      return { project: withBoard(project, { ...board(project), cast: [...(board(project).cast ?? []).filter(c => c.id !== args.id), args] }) }; } }),
  op({ name: 'remove_cast', summary: 'Remove a cast entry.', input: z.object({ id: z.string() }).strict(),
    apply: (project, args) => ({ project: withBoard(project, { ...board(project), cast: (board(project).cast ?? []).filter(c => c.id !== args.id) }) }) }),
  op({ name: 'set_style_pack', summary: 'Choose the film\'s look: a style pack from style-packs/ (clean-product, editorial-archival, paper-collage, …). Read its rules with project.ts pack <name> and use its scene templates.',
    input: z.object({ pack: z.string().regex(/^[a-z0-9-]{1,60}$/) }).strict(),
    apply: (project, args) => ({ project: withBoard(project, { ...board(project), stylePack: args.pack }), result: { stylePack: args.pack } }) }),
  op({ name: 'style_captions', summary: 'Caption style: fontSize (px at this output), how many words at a time, vertical position (0–1), word-by-word or line reveal. From a reference: fontSize = its text height × output height, maxWords = its words on screen. fontSize is pixels at this output\'s size (42 by default; "bigger" ≈ +8 to +12); y = the captions\' vertical centre, 0 top to 1 bottom (0.9 by default; "a little up" ≈ −0.05). Read the current values first.',
    input: z.object({ enabled: z.boolean().optional(), fontSize: z.number().min(8).max(200).optional(), maxWords: z.number().int().min(1).max(12).optional(), y: z.number().min(0).max(1).optional(), reveal: z.enum(['line', 'word']).optional(), font: z.enum(['sans', 'serif', 'mono']).optional() }).strict(),
    apply: (project, args) => { const captions = { ...project.captions, ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) }; return { project: { ...project, captions }, result: captions }; } }),
  op({ name: 'lock_beat', summary: 'Lock a beat so it stays as it is (only the person can unlock it).',
    input: z.object({ id: z.string() }).strict(),
    apply: (project, args) => { const beat = findBeat(project, args.id); return { project: withBoard(project, { ...board(project), beats: board(project).beats.map(b => b.id === beat.id ? { ...b, locked: true } : b) }) }; } }),
] as const;

export type OpCall = { op: string; args?: unknown };
export const opNames = ops.map(item => item.name);

/** Run commands in order against a project; the result must still be a valid project. Throws with the failing step. */
export function applyOps(project: EditorProject, calls: OpCall[]): { project: EditorProject; results: unknown[] } {
  let current = project; const results: unknown[] = [];
  calls.forEach((call, index) => {
    const definition = ops.find(item => item.name === call.op);
    if (!definition) throw new Error(`Step ${index + 1}: unknown command "${call.op}". Commands: ${opNames.join(', ')}`);
    const parsed = definition.input.safeParse(call.args ?? {});
    if (!parsed.success) throw new Error(`Step ${index + 1} (${call.op}): ${parsed.error.issues.slice(0, 6).map(issue => `${issue.path.join('.') || 'args'}: ${issue.message}`).join('; ')}`);
    const ctx = { fps: current.output.fps, total: projectDuration(current) };
    try { const out = (definition.apply as (p: EditorProject, a: unknown, c: Ctx) => { project: EditorProject; result?: unknown })(current, parsed.data, ctx); current = out.project; results.push(out.result ?? 'ok'); }
    catch (error) { throw new Error(`Step ${index + 1} (${call.op}): ${error instanceof Error ? error.message : String(error)}`); }
  });
  const checked = EditorProjectSchema.safeParse(current);
  if (!checked.success) throw new Error(`The edit would make the project invalid: ${checked.error.issues.slice(0, 6).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return { project: checked.data, results };
}

/** JSON Schema for each command (for the MCP server and the assistant guide). */
export function opSchemas() { return ops.map(item => ({ name: item.name, description: item.summary, inputSchema: z.toJSONSchema(item.input, { target: 'draft-7', io: 'input' }) })); }

/** What can be automated, for people and agents. */
export function automationCatalog() {
  return { main: automationParams.map(({ id, label, min, max, neutral, help, target }) => ({ param: id, label, min, max, neutral, help, appliesTo: target === 'audio' ? 'recording audio' : 'whole picture' })),
    layer: layerParams.map(param => { const info = layerParamInfo({ x: 0.5, y: 0.5, opacity: 1, rotate: 0 }, param); return { param, label: info.label, min: info.min, max: info.max, help: info.help }; }),
    animations: animationPresets, transitions: transitionKinds, textLooks: Object.keys(textLooks), layerKinds: Object.entries(layerKindInfo).map(([kind, info]) => ({ kind: kind as LayerKind, ...info })) };
}
