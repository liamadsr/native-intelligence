import { z } from 'zod';
import { MotionSchema, MotionTrackSchema, MotionVisualSchema, neutralMotion } from './motion-contracts';
import { LayerSchema } from './layers';
import { StoryboardSchema } from './storyboard';
export type { EditorLayer } from './layers';
export { MotionSchema, MotionLayerSchema, MotionTrackSchema, MotionVisualSchema, motionPropertyBounds, neutralMotion } from './motion-contracts';
export type { EditorMotion, MotionLayer, MotionTrack, MotionVisual, MotionProperty, MotionKey } from './motion-contracts';

const frame = z.number().int().min(0).max(10_000_000);
const finite = z.number().finite();
const color = z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const TraceSchema = z.object({
  viewport: z.object({ x:finite.optional(),y:finite.optional(),width: finite.positive(), height: finite.positive(), scale: finite.positive() }).passthrough(),
  cursor: z.array(z.tuple([finite.nonnegative(), finite, finite])).max(1_000_000),
  actions: z.array(z.object({ t: finite.nonnegative(), end: finite.nonnegative(), kind: z.string(), label: z.string(),
    box: z.object({ x: finite, y: finite, w: finite.nonnegative(), h: finite.nonnegative() }).nullable() }).passthrough()).max(100_000),
}).passthrough();
export type EditorTrace = z.infer<typeof TraceSchema>;
export const EditorAssetSchema = z.object({ id, name: z.string().min(1).max(250), kind: z.enum(['video', 'image', 'audio']),
  file: z.string().regex(/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: finite.int().positive(),
  width: finite.int().positive().max(16384).optional(), height: finite.int().positive().max(16384).optional(),
  sourceFps: finite.positive().max(240).optional(), sourceFrames: frame.positive().optional(), durationSeconds: finite.positive().optional(),
  hasAudio: z.boolean(), waveform: z.array(finite.min(0).max(1)).max(2000).optional(),
  sourceCursorHidden: z.boolean(), trace: TraceSchema.optional(), provenance: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type EditorAsset = z.infer<typeof EditorAssetSchema>;
export const ZoomSchema = z.object({ id, startClipFrame: frame, endClipFrame: frame.positive(),
  x: finite.min(0).max(1), y: finite.min(0).max(1), scale: finite.min(1).max(4), transitionFrames: frame.max(180) }).strict()
  .refine((v) => v.endClipFrame > v.startClipFrame, 'Zoom end must follow start');
export type EditorZoom = z.infer<typeof ZoomSchema>;
/** Which synchronized source fills the frame for a clip, and whether the webcam bubble is shown over it. */
/** A picture source a shot can show: the main screen take, its slides, the main camera, or an extra recorded source (src-…). */
export const ShotSourceSchema = z.string().regex(/^(?:screen|slides|camera|src-[a-zA-Z0-9_-]{1,60})$/);
/** Several sources on screen at once: side by side, stacked, picture-in-picture or a grid. ratio = the first source's share. */
export const ShotLayoutSchema = z.object({ kind: z.enum(['split', 'stack', 'pip', 'grid']), sources: z.array(ShotSourceSchema).min(2).max(4), ratio: finite.min(0.15).max(0.85).optional(),
  /** Picture-in-picture window: top-left and size as fractions of the picture area. */
  inset: z.object({ x: finite.min(0).max(1), y: finite.min(0).max(1), width: finite.min(0.08).max(0.9), height: finite.min(0.08).max(0.9) }).strict().optional() }).strict()
  .refine(layout => new Set(layout.sources).size === layout.sources.length, 'A layout shows each source once');
export type ShotLayout = z.infer<typeof ShotLayoutSchema>;
export const ClipViewSchema = z.object({ main: ShotSourceSchema, bubble: z.boolean(), layout: ShotLayoutSchema.optional(),
  /** Why an automatic edit chose this shot ("facing the side camera", "click on screen"); shown when the shot is selected. */
  reason: z.string().max(200).optional(),
  /** Where a camera shot's crop centres (0–1 in the camera picture), so a crop follows the person (vertical cuts). */
  focus: z.object({ x: finite.min(0).max(1), y: finite.min(0).max(1) }).strict().optional() }).strict();
export type ClipView = z.infer<typeof ClipViewSchema>;
export const defaultClipView: ClipView = { main: 'screen', bubble: true };
/** How a clip comes in from the one before it (or, on the first clip, from nothing) and, on the last, how it goes out. */
export const ClipTransitionSchema = z.object({ kind: z.enum(['dissolve', 'dip-black', 'dip-white']), seconds: finite.min(0.05).max(5) }).strict();
export type ClipTransition = z.infer<typeof ClipTransitionSchema>;
export const EditorClipSchema = z.object({ id, assetId: id, trimStartSourceFrame: frame, trimEndSourceFrame: frame.positive(),
  audio: z.object({ muted: z.boolean(), gain: finite.min(0).max(2) }).strict(), holdEndFrames: frame, zooms: z.array(ZoomSchema).max(100),motion:MotionSchema.default(neutralMotion),
  playbackRate:finite.min(1).max(4).refine(value=>Math.round(value*4)===value*4,'Playback rate must use quarter steps').default(1),
  dismissedActionIndices:z.array(frame).max(100_000).default([]), view: ClipViewSchema.optional(),
  transitionIn: ClipTransitionSchema.optional(), transitionOut: ClipTransitionSchema.optional() }).strict()
  .refine((v) => v.trimEndSourceFrame > v.trimStartSourceFrame, 'Trim end must follow start');
export type EditorClip = z.infer<typeof EditorClipSchema>;
export const PresentationSchema = z.object({
  background: z.object({ kind: z.enum(['none', 'solid', 'gradient', 'image']), color, color2: color, angle: finite.min(0).max(360), assetId: id.nullable() }).strict(),
  blur: finite.min(0).max(100), padding: finite.min(0).max(500), inset: finite.min(0).max(200), radius: finite.min(0).max(300),
  shadow: z.object({ opacity: finite.min(0).max(1), blur: finite.min(0).max(200), distance: finite.min(0).max(200), angle: finite.min(0).max(360) }).strict(),
  /** Camera shots fill the whole frame instead of the screen recording's shape (films, talking heads, vertical cuts). */
  cameraFill: z.boolean().optional()}).strict();
export const CursorSchema = z.object({ style: z.enum(['none', 'glass', 'arrow']), size: finite.min(6).max(100), clickFeedback: z.boolean() }).strict();
export const TranscriptWordSchema = z.object({ id, text: z.string().min(1).max(500), startMs: finite.nonnegative(), endMs: finite.nonnegative() }).strict()
  .refine(w => w.endMs >= w.startMs, 'Word end precedes start');
export const TranscriptSchema = z.object({ id, assetId: id, sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), label: z.string().min(1).max(250),
  origin: z.enum(['elevenlabs-cache', 'elevenlabs-generated', 'imported', 'local-whisper']), text: z.string().max(200_000), words: z.array(TranscriptWordSchema).min(1).max(40_000),
  alignmentSha256: z.string().regex(/^[a-f0-9]{64}$/), voiceName: z.string().max(100).optional(),
}).strict().superRefine((t, ctx) => { const ids = new Set<string>(); t.words.forEach((w, i) => {
  if (ids.has(w.id) || (i > 0 && w.startMs < t.words[i - 1]!.startMs)) ctx.addIssue({ code: 'custom', message: 'Transcript words must have unique ids and ordered timestamps' }); ids.add(w.id);
}); });
export type EditorTranscript = z.infer<typeof TranscriptSchema>;
export const AudioSegmentSchema = z.object({ id, assetId: id, startFrame: frame, trimStartSeconds: finite.nonnegative(), trimEndSeconds: finite.positive(),
  /** Sound effects: the earshot bank id (or file:name), the cue it answers (auto:… from the sound pass) and what it is for. */
  sound: z.string().max(200).optional(), cue: z.string().max(200).optional(), label: z.string().max(200).optional(),
  /** This segment's own level (× on top of the track gain) and fades at its head and tail. */
  gain: finite.min(0).max(4).optional(), fadeInSeconds: finite.min(0).max(60).optional(), fadeOutSeconds: finite.min(0).max(60).optional() }).strict()
  .refine(s => s.trimEndSeconds > s.trimStartSeconds, 'Audio trim end must follow start');
export const AudioTrackSchema = z.object({ id, name: z.string().min(1).max(250), role: z.enum(['voiceover', 'music', 'sfx']), gain: finite.min(0).max(2), muted: z.boolean(), segments: z.array(AudioSegmentSchema).max(2000),
  /** Music only: dip under speech (sidechain ducking keyed by the aligned words). */
  duck: z.object({ depthDb: finite.min(1).max(40), attackMs: finite.min(0).max(2000), releaseMs: finite.min(0).max(5000) }).strict().optional() }).strict();
export type EditorAudioTrack = z.infer<typeof AudioTrackSchema>;
export const PresenterSegmentSchema=z.object({id,startFrame:frame,endFrame:frame.positive(),sourceStartFrame:frame,visual:MotionVisualSchema,
  tracks:z.array(MotionTrackSchema).max(32)}).strict().superRefine((segment,ctx)=>{
  if(segment.endFrame<=segment.startFrame)ctx.addIssue({code:'custom',message:'Presenter segment end must follow start'});
  if(segment.tracks.some(track=>track.target!=='presenter'))ctx.addIssue({code:'custom',message:'Presenter motion must target presenter'});
  if(new Set(segment.tracks.map(track=>track.id)).size!==segment.tracks.length||new Set(segment.tracks.map(track=>track.property)).size!==segment.tracks.length)ctx.addIssue({code:'custom',message:'Presenter motion tracks must be unique'});
});
export type PresenterSegment=z.infer<typeof PresenterSegmentSchema>;
/** A synced presenter follows the screen take's clock: camera time = screen source time - offsetSeconds.
 * Its first segment is then a master position track keyed in camera frames at the project rate. */
export const PresenterSyncSchema=z.object({screenAssetId:id,offsetSeconds:finite.min(-3600).max(3600)}).strict();
/** Bubble shape: a circle, or a square with rounded corners (radius as a fraction of the side, 0–0.5). */
export const PresenterStyleSchema=z.object({shape:z.enum(['circle','rounded']),radius:finite.min(0).max(.5)}).strict();
export type PresenterStyle=z.infer<typeof PresenterStyleSchema>;
export const PresenterTrackSchema=z.object({id,assetId:id,audio:z.object({muted:z.boolean(),gain:finite.min(0).max(2)}).strict(),
  segments:z.array(PresenterSegmentSchema).min(1).max(2000),sync:PresenterSyncSchema.optional(),style:PresenterStyleSchema.optional(),
  /** Punched-in takes: each extra screen take brings its own camera recording on its own clock. */
  takes:z.array(z.object({screenAssetId:id,assetId:id,offsetSeconds:finite.min(-3600).max(3600)}).strict()).max(500).optional()}).strict();
export type PresenterTrack=z.infer<typeof PresenterTrackSchema>;
/** Extra pictures recorded in the same take — another app window (iPhone Mirroring, a second app) or another camera
 * (Continuity Camera, a second webcam) — each synced to the screen take's clock like the main camera. */
export const RecordedSourceSchema=z.object({id:z.string().regex(/^src-[a-zA-Z0-9_-]{1,60}$/),kind:z.enum(['window','camera']),name:z.string().min(1).max(200),assetId:id,
  sync:PresenterSyncSchema,takes:z.array(z.object({screenAssetId:id,assetId:id,offsetSeconds:finite.min(-3600).max(3600)}).strict()).max(500).optional()}).strict();
export type RecordedSource=z.infer<typeof RecordedSourceSchema>;
/** Slides are rasterized PDF pages; changes are measured on the screen take's clock (ms since screen T0). */
export const SlideDeckSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(250), pageAssetIds: z.array(id).min(1).max(500),
  screenAssetId: id, changes: z.array(z.object({ ms: finite.nonnegative(), page: z.number().int().min(0).max(499) }).strict()).max(20_000),
  /** Punched-in takes that presented the same deck, each with its own slide timing. */
  takes: z.array(z.object({ screenAssetId: id, changes: z.array(z.object({ ms: finite.nonnegative(), page: z.number().int().min(0).max(499) }).strict()).max(20_000) }).strict()).max(500).optional() }).strict()
  .superRefine((deck, ctx) => { deck.changes.forEach((change, index) => {
    if (change.page >= deck.pageAssetIds.length) ctx.addIssue({ code: 'custom', message: 'Slide change references a missing page' });
    if (index && change.ms < deck.changes[index - 1]!.ms) ctx.addIssue({ code: 'custom', message: 'Slide changes must be ordered' });
  }); });
export type SlideDeck = z.infer<typeof SlideDeckSchema>;
export const CaptionSchema = z.object({ enabled: z.boolean(), fontSize: finite.min(1).max(200), font: z.enum(['sans', 'serif', 'mono']),
  color: z.enum(['light', 'dark']), reveal: z.enum(['line', 'word']), lineGrowth: z.enum(['full', 'expanding', 'centered']), wordAnimation: z.enum(['appear', 'fade', 'slide']),
  x: finite.min(0).max(1), y: finite.min(0).max(1), maxWords: z.number().int().min(1).max(12) }).strict();
export const defaultCaptions: z.infer<typeof CaptionSchema> = { enabled: false, fontSize: 42, font: 'sans', color: 'light', reveal: 'line', lineGrowth: 'full', wordAnimation: 'appear', x: .5, y: .9, maxWords: 6 };
const EditorProjectV4Schema = z.object({ schemaVersion: z.literal(4), id, title: z.string().min(1).max(250),
  output: z.object({ width: finite.int().min(64).max(8192), height: finite.int().min(64).max(8192), fps: finite.int().min(1).max(60) }).strict()
    .refine((o) => o.width % 2 === 0 && o.height % 2 === 0, 'MP4 dimensions must be even'),
  assets: z.array(EditorAssetSchema).max(1000), clips: z.array(EditorClipSchema).min(1).max(2000), presentation: PresentationSchema, cursor: CursorSchema,
  audioTracks: z.array(AudioTrackSchema).max(16), presenterTrack:PresenterTrackSchema.nullable(), transcripts: z.array(TranscriptSchema).max(100), captions: CaptionSchema,
  captionCorrections: z.record(z.string(), z.string().max(500)), voiceoverDraft: z.object({ text: z.string().max(20_000), targetClipIds: z.array(id).max(2000) }).strict(),
  slideDeck: SlideDeckSchema.nullable().optional(),
  /** Timeline-wide automation curves for the main picture (zoom, pan, slide, rotation, blur, opacity) and the recording's volume. */
  automation: z.object({ lanes: z.array(z.object({ param: z.enum(['zoom', 'panX', 'panY', 'shiftX', 'shiftY', 'rotate', 'tiltX', 'tiltY', 'blur', 'opacity', 'saturation', 'contrast', 'volume', 'camZoom', 'camX', 'camY', 'camRotate']), points: z.array(z.object({ frame: z.number().int().nonnegative(), value: finite, curve: z.enum(['smooth', 'linear', 'hold']).optional() }).strict()).max(5000) }).strict()).max(16) }).strict().optional(),
  /** Text, callouts and spotlights on the timeline above the picture, each with in/out animation and its own automation. */
  layers: z.array(LayerSchema).max(200).optional(),
  /** Extra windows and cameras recorded in the same take. */
  sources: z.array(RecordedSourceSchema).max(8).optional(),
  /** Subject cut-outs (macOS Vision): a transparent video of just the person/subject in a recording, frame for frame. Layers marked
   *  `behind` are drawn under it, so text sits behind the speaker. */
  /** Master the soundtrack to a loudness target on export (web: -14 LUFS, true peak -1 dBTP). */
  master: z.object({ lufs: finite.min(-30).max(-6), truePeak: finite.min(-6).max(0) }).strict().optional(),
  cutouts: z.array(z.object({ assetId: id, cutoutAssetId: id, mode: z.enum(['person', 'subject']) }).strict()).max(16).optional(),
  /** The platform format shown and exported (youtube, tiktok, instagram-feed, …). The edit itself stays at its own size
   *  (output); every format is a reframed view of it, so switching back and forth never changes the edit. focus = where
   *  each camera clip's crop centres (the person's face), measured once when a narrower format is chosen. */
  delivery: z.object({ format: z.string().regex(/^[a-z0-9-]{1,40}$/), focus: z.record(z.string(), z.object({ x: finite.min(0).max(1), y: finite.min(0).max(1) }).strict()).optional() }).strict().optional(),
  /** The storyboard: the film's beats in order (words, picture source, status, lock); placeholders are recorded into. */
  storyboard: StoryboardSchema.optional(),
}).strict().superRefine((p, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const ids = new Set<string>();
  if (p.layers && new Set(p.layers.map(layer => layer.id)).size !== p.layers.length) issue('Layer ids must be unique');
  if (p.sources && new Set(p.sources.map(source => source.id)).size !== p.sources.length) issue('Source ids must be unique');
  for (const cut of p.cutouts ?? []) { const source = p.assets.find(a => a.id === cut.assetId), cutout = p.assets.find(a => a.id === cut.cutoutAssetId);
    if (!source || source.kind !== 'video' || !cutout || cutout.kind !== 'video') issue('A subject cut-out references a missing video');
    else if (Math.abs((cutout.sourceFrames ?? 0) - (source.sourceFrames ?? 0)) > 1) issue('A subject cut-out does not match its recording frame for frame'); }
  if (p.cutouts && new Set(p.cutouts.map(cut => cut.assetId)).size !== p.cutouts.length) issue('One cut-out per recording');
  for (const source of p.sources ?? []) for (const assetId of [source.assetId, ...(source.takes ?? []).map(take => take.assetId)]) if (!p.assets.some(a => a.id === assetId && a.kind === 'video')) issue(`Source ${source.name} references a missing video`);
  const known = new Set(['screen', 'slides', 'camera', ...(p.sources ?? []).map(source => source.id)]);
  for (const c of p.clips) for (const shown of [c.view?.main, ...(c.view?.layout?.sources ?? [])]) if (shown && !known.has(shown)) issue(`A shot shows ${shown}, which this project does not have`);
  for (const a of p.assets) { if (ids.has(a.id)) issue('Duplicate asset id'); ids.add(a.id);
    if (a.file.split('/')[1]?.split('.')[0] !== a.sha256) issue('Asset filename differs from digest');
    if (a.kind === 'video' && (!a.sourceFps || !a.sourceFrames || !a.width || !a.height)) issue('Video metadata missing'); }
  const clips = new Set<string>(); let accumulatedSeconds = 0, previousBoundary = 0;
  for (const c of p.clips) { const a = p.assets.find((v) => v.id === c.assetId);
    if (clips.has(c.id)) issue('Duplicate clip id'); clips.add(c.id);
    if (!a || a.kind !== 'video' || c.trimEndSourceFrame > (a.sourceFrames ?? 0)) issue('Clip references invalid video or trim');
    if (a?.sourceFps) { const seconds = (c.trimEndSourceFrame - c.trimStartSourceFrame) / a.sourceFps;
      accumulatedSeconds += seconds / c.playbackRate + c.holdEndFrames / p.output.fps; const boundary = Math.round(accumulatedSeconds * p.output.fps), duration = boundary - previousBoundary; previousBoundary = boundary;
      if (seconds / c.playbackRate * p.output.fps < 1 - 1e-8 || duration < 1) issue('Clip shorter than one project frame');
      if(c.playbackRate>1){
        const measured=a.trace?.actions.some(action=>action.kind==='type'&&action.end>action.t&&Math.round(action.t/1000*a.sourceFps!)<=c.trimStartSourceFrame&&Math.round(action.end/1000*a.sourceFps!)>=c.trimEndSourceFrame);
        if(!measured||c.holdEndFrames)issue('Accelerated clips must stay inside a measured typing interval without a hold');
        const transcript=p.transcripts.find(item=>item.assetId===a.id);
        if(a.hasAudio&&!c.audio.muted&&!transcript)issue('Transcribe audio-bearing footage before accelerating it');
        const from=c.trimStartSourceFrame/a.sourceFps*1000,to=c.trimEndSourceFrame/a.sourceFps*1000;
        if(transcript?.words.some(word=>from<Math.max(word.endMs,word.startMs+1)&&word.startMs<to))issue('Accelerated typing overlaps spoken source audio');
      }
      for (const zoom of c.zooms) if (zoom.endClipFrame > duration) issue('Zoom extends beyond clip');
      for(const layer of c.motion.layers){if(layer.endFrame>duration)issue('Motion layer extends beyond clip');if(layer.kind==='video'){const source=p.assets.find(asset=>asset.id===layer.assetId);if(!source||source.kind!=='video'||layer.sourceStartFrame>=(source.sourceFrames??0))issue('Motion layer references invalid video source');}}
      for(const track of c.motion.tracks)if(track.keys.some(key=>key.frame>duration))issue('Motion curve extends beyond clip'); }
  }
  if (p.presentation.background.kind === 'image' && !p.assets.some((a) => a.id === p.presentation.background.assetId && a.kind === 'image')) issue('Background image missing');
  const trackIds = new Set<string>(), segmentIds = new Set<string>();
  for (const track of p.audioTracks) { if (trackIds.has(track.id)) issue('Duplicate audio track id'); trackIds.add(track.id);
    for (const segment of track.segments) { const a = p.assets.find(v => v.id === segment.assetId);
      if (segmentIds.has(segment.id)) issue('Duplicate audio segment id'); segmentIds.add(segment.id);
      if (!a || a.kind !== 'audio' || segment.trimEndSeconds > (a.durationSeconds ?? 0) + .02) issue('Invalid audio segment'); }
  }
  if(p.presenterTrack){const presenter=p.presenterTrack,asset=p.assets.find(a=>a.id===presenter.assetId);if(!asset||asset.kind!=='video')issue('Presenter video asset is unavailable');
    if(new Set(presenter.segments.map(segment=>segment.id)).size!==presenter.segments.length)issue('Presenter segment IDs must be unique');
    if(presenter.sync&&(presenter.segments.length!==1||!p.assets.some(a=>a.id===presenter.sync!.screenAssetId&&a.kind==='video')))issue('Synced presenter needs one master segment and its screen take');
    for(const take of presenter.takes??[])if(!presenter.sync||!p.assets.some(a=>a.id===take.assetId&&a.kind==='video')||!p.assets.some(a=>a.id===take.screenAssetId&&a.kind==='video'))issue('Punched-in camera take is missing its media');
    let last=0;for(const segment of presenter.segments){if(!presenter.sync&&(segment.startFrame<last||segment.endFrame>previousBoundary))issue('Presenter segments overlap or exceed the project');last=segment.endFrame;
      if(asset?.sourceFps&&asset.sourceFrames&&segment.sourceStartFrame+Math.ceil((segment.endFrame-segment.startFrame)*asset.sourceFps/p.output.fps)>asset.sourceFrames+1)issue('Presenter segment exceeds source video');
      if(segment.tracks.some(track=>track.keys.some(key=>key.frame>segment.endFrame-segment.startFrame)))issue('Presenter motion extends beyond its segment');}}
  const transcriptIds = new Set<string>(), wordIds = new Set<string>();
  for (const t of p.transcripts) { const a = p.assets.find(v => v.id === t.assetId);
    if (transcriptIds.has(t.id)) issue('Duplicate transcript id'); transcriptIds.add(t.id);
    if (!a || a.sha256 !== t.sourceSha256 || !a.hasAudio) issue('Transcript does not match audio-bearing asset');
    if (t.words.some(w => w.endMs > (a?.durationSeconds ?? 0) * 1000 + 50)) issue('Transcript timing exceeds its source');
    for (const w of t.words) wordIds.add(w.id);
  }
  if (Object.keys(p.captionCorrections).some(word => !wordIds.has(word))) issue('Caption correction references unknown word');
  if (p.voiceoverDraft.targetClipIds.some(clip => !clips.has(clip))) issue('Voiceover targets a missing clip');
  if (p.slideDeck) { const deck = p.slideDeck;
    if (deck.pageAssetIds.some(page => !p.assets.some(a => a.id === page && a.kind === 'image'))) issue('Slide page image is unavailable');
    if (!p.assets.some(a => a.id === deck.screenAssetId && a.kind === 'video')) issue('Slides reference a missing screen take'); }
  for (const c of p.clips) { if (c.view?.main === 'slides' && !p.slideDeck) issue('Clip shows slides but the project has no slide deck');
    if (c.view?.main === 'camera' && !p.presenterTrack) issue('Clip shows the camera but the project has no presenter'); }
});
function migrateEditorProject(value:unknown):unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const old = value as Record<string, unknown>;
  if(old.schemaVersion===4)return value;
  if(old.schemaVersion===3){if(!Array.isArray(old.clips)||old.clips.some(clip=>!clip||typeof clip!=='object'||Array.isArray(clip)||'playbackRate' in clip||'dismissedActionIndices' in clip))return value;
    return {...old,schemaVersion:4,presenterTrack:null,clips:old.clips.map(clip=>({...clip,playbackRate:1,dismissedActionIndices:[]}))};}
  if(old.schemaVersion===2){if(!Array.isArray(old.clips)||old.clips.some(clip=>!clip||typeof clip!=='object'||Array.isArray(clip)||'motion' in clip))return value;
    return {...old,schemaVersion:4,presenterTrack:null,clips:old.clips.map(clip=>({...clip,motion:neutralMotion(),playbackRate:1,dismissedActionIndices:[]}))};}
  if(old.schemaVersion!==1)return value;
  const allowed = new Set(['schemaVersion', 'id', 'title', 'output', 'assets', 'clips', 'presentation', 'cursor', 'audio']);
  if (Object.keys(old).some(key => !allowed.has(key))) return value;
  if (Array.isArray(old.clips) && old.clips.some(c => c && typeof c === 'object' && 'holdEndFrames' in c)) return value;
  const { audio, ...rest } = old;
  const result=z.object({ assetId: id, startFrame: frame, trimStartSeconds: finite.nonnegative(), trimEndSeconds: finite.positive(), gain: finite.min(0).max(2), muted: z.boolean() }).strict().nullable().safeParse(audio);
  if(!result.success)return value;const legacy=result.data;
  return { ...rest, schemaVersion: 4,presenterTrack:null,
    clips: Array.isArray(old.clips) ? old.clips.map(c => ({ ...c, holdEndFrames: 0,motion:neutralMotion(),playbackRate:1,dismissedActionIndices:[] })) : old.clips,
    audioTracks: legacy ? [{ id: 'legacy-audio', name: 'Imported audio', role: 'voiceover', gain: legacy.gain, muted: legacy.muted,
      segments: [{ id: 'legacy-audio-segment', assetId: legacy.assetId, startFrame: legacy.startFrame, trimStartSeconds: legacy.trimStartSeconds, trimEndSeconds: legacy.trimEndSeconds }] }] : [],
    transcripts: [], captions: defaultCaptions, captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] },
  };
}
export const EditorProjectSchema=z.preprocess(migrateEditorProject,EditorProjectV4Schema);
export type EditorProject = z.infer<typeof EditorProjectSchema>;
/** In-memory V1/V2 migration. Store saves V3 only and backs up exact older bytes first. */
export function parseEditorProject(value:unknown):EditorProject{
  if(value&&typeof value==='object'&&!Array.isArray(value)&&(value as Record<string,unknown>).schemaVersion===1){
    const old=value as Record<string,unknown>,allowed=new Set(['schemaVersion','id','title','output','assets','clips','presentation','cursor','audio']);
    if(Object.keys(old).some(key=>!allowed.has(key)))throw new Error('Unknown v1 editor project field');
    if(Array.isArray(old.clips)&&old.clips.some(clip=>clip&&typeof clip==='object'&&'holdEndFrames' in clip))throw new Error('Unknown v1 clip field holdEndFrames');
  }
  return EditorProjectSchema.parse(value);
}
export type EditorPreset = { id: string; name: string; presentation: EditorProject['presentation']; cursor: EditorProject['cursor'] };
export const defaultPresentation: EditorProject['presentation'] = { background: { kind: 'none', color: '#111118', color2: '#7756be', angle: 135, assetId: null },
  blur: 0, padding: 0, inset: 0, radius: 0, shadow: { opacity: 0, blur: 40, distance: 10, angle: 90 } };
