/**
 * The FFmpeg export: a video that is a recording with its camera bubble, cut and sped up, and nothing drawn by React,
 * composed by FFmpeg alone instead of screenshotted out of Chrome frame by frame. On a Mac the 20 s production-shaped
 * video took 14.5 s instead of 38.4 s and 60 % of the CPU; most of what is left is the sound (fast-export-run.ts).
 *
 * Default deny. `fastExportPlan` lets a project through only when every part of it is one this path was proven to draw
 * as Chrome draws it (test/fast-export-e2e.ts renders made-up projects both ways and compares every frame; the list is
 * in deploy/studio/README.md, "Export speed"); anything else, any key it does not know, any value outside what was
 * tested, and the whole export goes through Chrome as before, with the first reason in the job's log.
 *
 * What it draws, each piece imitating the composition (web/src/lib/studio/engine) with the engine's own functions:
 * - every frame of a clip is the source frame @remotion/media would show (remotionFrame: the latest frame at or before
 *   the clip's time, a millisecond's grace), realised by FFmpeg's fps filter from timestamps placed so it picks the
 *   same frames (realise), checked frame by frame against remotionFrame before anything runs;
 * - a jump cut inside one recording: the outgoing frame held while the next clip fades in over it (cutVideoPlan);
 * - the camera bubble (presenterPieces): the camera sampled bilinearly at the exact fractional place Chrome draws it
 *   (Chrome does not filter the scaled canvas), under a circle or rounded-square mask antialiased from the same
 *   geometry;
 * - the sound: Remotion's own mix of the same video without its silent pictures (soundOnly), rendered in stretches
 *   at once and joined to the sample (fast-export-run.ts, soundRanges).
 * One FFmpeg pass per clip, all encoded alike, joined without re-encoding. Labels as the Chrome path's file: BT.709
 * primaries and matrix, limited range, the sRGB transfer (render.ts, bt709WithSwscale).
 */
import { createRequire } from 'node:module'
import type { EditorAsset, EditorClip, EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'

const require = createRequire(import.meta.url)
// Each by its own literal path, so a bundler (scripts/build-local-runner.ts) takes exactly these files in.
const { scheduleProject } = require('../../web/src/lib/studio/engine/timeline.ts') as typeof import('../../web/src/lib/studio/engine/timeline.ts')
const { cutVideoPlan } = require('../../web/src/lib/studio/engine/cuts.ts') as typeof import('../../web/src/lib/studio/engine/cuts.ts')
const { clipView } = require('../../web/src/lib/studio/engine/shots.ts') as typeof import('../../web/src/lib/studio/engine/shots.ts')
const { presenterPieces, presenterRadius } = require('../../web/src/lib/studio/engine/presenter-pieces.ts') as typeof import('../../web/src/lib/studio/engine/presenter-pieces.ts')
const { outputRect, sourceCropRect } = require('../../web/src/lib/studio/engine/motion-render.ts') as typeof import('../../web/src/lib/studio/engine/motion-render.ts')
const { neutralMotion } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')

/** A stretch of one video shown frame by frame: `map[l]` is the source frame at output frame l. */
export interface StreamPlan { file: string; srcFps: number; rate: number; startSeconds: number; map: number[] }
export interface BubblePlan {
  /** Output frames (from the segment's start) the bubble shows from, and the camera's frames. */
  offset: number
  camera: StreamPlan & { width: number; height: number }
  /** The bubble's square in output pixels (fractional, as Chrome lays it out), its corner radius, and where the camera's
   *  scaled picture sits (crop: relative to the square, `scale` source pixels per output pixel). */
  square: { x: number; y: number; side: number }
  radius: number
  crop: { x: number; y: number; width: number; height: number }
}
export interface SegmentPlan {
  clipId: string
  startFrame: number
  frames: number
  screen: StreamPlan
  /** A jump cut's blend: the previous clip's last shown frame held under the first `frames` frames. */
  blend: { file: string; srcFps: number; index: number; frames: number } | null
  bubble: BubblePlan | null
}
export interface FastPlan { width: number; height: number; fps: number; frames: number; segments: SegmentPlan[] }

// ---- what is proven (each one has a case in test/fast-export-e2e.ts) -----------------------------------------------
const PROJECT_KEYS = new Set(['schemaVersion', 'id', 'title', 'output', 'assets', 'clips', 'presentation', 'cursor', 'audioTracks', 'presenterTrack',
  'transcripts', 'captions', 'captionCorrections', 'voiceoverDraft', 'slideDeck', 'automation', 'layers', 'sources', 'master', 'cutouts', 'delivery', 'storyboard'])
const CLIP_KEYS = new Set(['id', 'assetId', 'trimStartSourceFrame', 'trimEndSourceFrame', 'audio', 'holdEndFrames', 'zooms', 'motion', 'playbackRate',
  'dismissedActionIndices', 'view', 'transitionIn', 'transitionOut'])
const VIEW_KEYS = new Set(['main', 'bubble', 'layout', 'reason', 'focus'])
const PRESENTATION_KEYS = new Set(['background', 'blur', 'padding', 'inset', 'radius', 'shadow', 'cameraFill'])
const PRESENTER_KEYS = new Set(['id', 'assetId', 'audio', 'segments', 'sync', 'style', 'takes'])
const SEGMENT_KEYS = new Set(['id', 'startFrame', 'endFrame', 'sourceStartFrame', 'visual', 'tracks'])
const VISUAL_KEYS = new Set(['rect', 'crop', 'scale', 'tiltX', 'tiltY', 'rotateZ', 'opacity'])
/** Output rates, clip speeds, camera rates and bubble shapes tested. */
export const PROVEN = { fps: [30, 60],
  /** Clip speed in video rate. */
  rates: ['1@30', '1@60', '2@60'], shapes: ['circle', 'rounded'], backgrounds: ['none', 'solid', 'gradient'],
  /** Camera rate in video rate: a 30 fps camera in 60 and 30 fps videos, a 60 fps one in a 30 fps video. */
  camera: ['30@60', '30@30', '60@30'] } as const

const unknownKey = (value: object | undefined | null, known: Set<string>, where: string) => {
  const extra = Object.keys(value ?? {}).filter((k) => !known.has(k) && (value as Record<string, unknown>)[k] !== undefined)
  return extra.length ? `${where} has ${extra.join(', ')}, which this path does not know` : null
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const empty = (v: unknown) => v === undefined || v === null || (Array.isArray(v) && v.length === 0)

/**
 * The plan for composing `project` with FFmpeg, or the first reason it must go through Chrome. Pure: what the files
 * are made of (codec, colour, timing) is checked by `sourcesFit` once they are on disk.
 */
export function fastExportPlan(project: EditorProject): FastPlan | { reason: string } {
  const deny = (reason: string) => ({ reason })
  const p = project as EditorProject & Record<string, unknown>
  const unknown = unknownKey(p, PROJECT_KEYS, 'The video')
  if (unknown) return deny(unknown)
  const { width: W, height: H, fps } = project.output
  if (!(PROVEN.fps as readonly number[]).includes(fps)) return deny(`it is ${fps} fps`)
  if (project.delivery) return deny('it is reframed for a platform format')
  if (!empty(project.layers)) return deny('it has layers (text, callouts, scenes or other drawn parts)')
  if (project.captions.enabled) return deny('it has captions')
  if (!empty(project.cutouts)) return deny('it has subject cut-outs')
  if (!empty(project.sources)) return deny('it has extra recorded windows or cameras')
  if (project.slideDeck) return deny('it has a slide deck')
  if ((project.automation?.lanes ?? []).some((lane) => lane.points.length > 0)) return deny('it has automation (zoom, pan, slide, blur, volume…)')
  const pr = project.presentation
  const presentationUnknown = unknownKey(pr, PRESENTATION_KEYS, 'The look')
  if (presentationUnknown) return deny(presentationUnknown)
  if (pr.padding !== 0 || pr.inset !== 0 || pr.radius !== 0) return deny('its look has padding, an inset or rounded corners')
  if (pr.cameraFill) return deny('its look fills the frame with the camera')
  if (!(PROVEN.backgrounds as readonly string[]).includes(pr.background.kind)) return deny(`its background is ${pr.background.kind}`)

  const schedule = scheduleProject(project)
  const videoPlan = cutVideoPlan(project, schedule)
  const frames = schedule.at(-1)!.startFrame + schedule.at(-1)!.durationFrames
  const segments: SegmentPlan[] = []
  for (const [index, s] of schedule.entries()) {
    const { clip, asset } = s
    const c = clip as EditorClip & Record<string, unknown>
    const clipUnknown = unknownKey(c, CLIP_KEYS, `Clip ${index + 1}`)
    if (clipUnknown) return deny(clipUnknown)
    const view = clipView(clip)
    const viewUnknown = unknownKey(view, VIEW_KEYS, `Clip ${index + 1}'s shot`)
    if (viewUnknown) return deny(viewUnknown)
    if (view.main !== 'screen' || view.layout) return deny(`clip ${index + 1} shows ${view.layout ? 'a layout' : `the ${view.main}`}`)
    if (clip.transitionIn || clip.transitionOut) return deny(`clip ${index + 1} has a chosen transition`)
    if (clip.holdEndFrames) return deny(`clip ${index + 1} holds its last frame`)
    if (clip.zooms.length) return deny(`clip ${index + 1} has a zoom`)
    if (!same(clip.motion, neutralMotion())) return deny(`clip ${index + 1} has motion`)
    if (!(PROVEN.rates as readonly string[]).includes(`${clip.playbackRate}@${fps}`)) return deny(`clip ${index + 1} plays at ${clip.playbackRate}x in a ${fps} fps video`)
    if (videoPlan[index]!.playOn) return deny(`clip ${index + 1} plays on under a dissolve`)
    const a = screenProblem(asset, project)
    if (a) return deny(a)
    const trimBefore = clip.trimStartSourceFrame / asset.sourceFps! * fps
    const playback = s.durationFrames - clip.holdEndFrames
    const screen: StreamPlan = { file: asset.file, srcFps: asset.sourceFps!, rate: clip.playbackRate, startSeconds: trimBefore / fps,
      map: Array.from({ length: playback }, (_, l) => remotionFrame(l, fps, clip.playbackRate, trimBefore, asset.sourceFps!)) }
    if (screen.map.at(-1)! >= asset.sourceFrames!) return deny(`clip ${index + 1} runs past its recording's end`)
    const fadeIn = videoPlan[index]!.fadeIn
    let blend: SegmentPlan['blend'] = null
    if (fadeIn > 0) {
      const prev = segments[index - 1]!
      if (fadeIn >= s.durationFrames) return deny(`clip ${index + 1} is shorter than its blend`)
      blend = { file: prev.screen.file, srcFps: prev.screen.srcFps, index: prev.screen.map.at(-1)!, frames: fadeIn }
    }
    segments.push({ clipId: clip.id, startFrame: s.startFrame, frames: s.durationFrames, screen, blend, bubble: null })
  }

  const track = project.presenterTrack
  if (track) {
    const t = track as typeof track & Record<string, unknown>
    const trackUnknown = unknownKey(t, PRESENTER_KEYS, 'The camera')
    if (trackUnknown) return deny(trackUnknown)
    if (!track.sync) return deny('its camera is not synced to the recording')
    if (!empty(track.takes)) return deny('its camera has punched-in takes')
    if (!track.audio.muted && project.assets.find((x) => x.id === track.assetId)?.hasAudio) return deny("its camera's own sound is on")
    if (track.segments.length !== 1) return deny('its camera has more than one position segment')
    const seg = track.segments[0]!
    const segUnknown = unknownKey(seg, SEGMENT_KEYS, "The camera's segment") ?? unknownKey(seg.visual, VISUAL_KEYS, "The camera's look")
    if (segUnknown) return deny(segUnknown)
    if (seg.tracks.length) return deny('its camera moves')
    const v = seg.visual
    if (v.scale !== 1 || v.tiltX || v.tiltY || v.rotateZ || v.opacity !== 1) return deny('its camera is scaled, tilted, turned or faded')
    if (!same(v.crop, { x: 0, y: 0, width: 1, height: 1 })) return deny("its camera's picture is cropped")
    if (v.rect.x < 0 || v.rect.y < 0 || v.rect.x + v.rect.width > 1 + 1e-9 || v.rect.y + v.rect.height > 1 + 1e-9) return deny('its camera bubble reaches past the frame')
    const shape = track.style?.shape ?? 'circle'
    if (!(PROVEN.shapes as readonly string[]).includes(shape)) return deny(`its camera bubble is ${shape}`)
    const camera = project.assets.find((x) => x.id === track.assetId)
    for (const piece of presenterPieces(project)) {
      const media = project.assets.find((x) => x.id === piece.assetId)
      if (!media || media.id !== camera?.id) return deny('its camera plays a take other than its own')
      if (media.kind !== 'video' || !media.width || !media.height || !media.sourceFps || !media.sourceFrames || !/\.mp4$/.test(media.file)) return deny('its camera is not an MP4 video')
      if (!(PROVEN.camera as readonly string[]).includes(`${media.sourceFps}@${fps}`)) return deny(`its camera is ${media.sourceFps} fps in a ${fps} fps video`)
      if (!piece.view(0).bubble) continue // drawn with opacity 0: nothing shows
      const segment = segments.find((x) => piece.from >= x.startFrame && piece.from + piece.duration <= x.startFrame + x.frames)
      if (!segment || segment.bubble) return deny("its camera's timing does not follow its clips")
      const rect = outputRect(v, W, H), side = Math.min(rect.width, rect.height)
      const square = { x: rect.x + (rect.width - side) / 2, y: rect.y + (rect.height - side) / 2, side }
      const radiusCss = presenterRadius(track.style, side)
      const radius = radiusCss === '50%' ? side / 2 : Math.min(side / 2, Number(radiusCss))
      // Square corners: the mask's distance below is a rounded square's for a radius of half a pixel and more (not tested under one).
      if (!(radius >= 1)) return deny("its camera bubble's corners are square")
      const map = Array.from({ length: piece.duration }, (_, l) => remotionFrame(l, fps, piece.playbackRate, piece.sourceStartSeconds * fps, media.sourceFps!))
      if (map[0]! < 0 || map.at(-1)! >= media.sourceFrames) return deny("its camera's take is shorter than its bubble")
      segment.bubble = {
        offset: piece.from - segment.startFrame,
        camera: { file: media.file, srcFps: media.sourceFps, rate: piece.playbackRate, startSeconds: piece.sourceStartSeconds, map, width: media.width, height: media.height },
        square, radius,
        crop: sourceCropRect(media.width, media.height, v.crop, side, side),
      }
    }
  }
  if (!audible(project)) return deny('it has no sound (that case is not tested)')
  for (const seg of segments) {
    const why = realiseProblem(seg.screen, fps) ?? (seg.bubble ? realiseProblem(seg.bubble.camera, fps) : null)
    if (why) return deny(why)
  }
  return { width: W, height: H, fps, frames, segments }
}

function screenProblem(asset: EditorAsset, project: EditorProject): string | null {
  const { width, height, fps } = project.output
  if (asset.kind !== 'video' || !/\.mp4$/.test(asset.file) || !asset.sourceFrames) return 'its recording is not an MP4 video'
  if (asset.width !== width || asset.height !== height) return 'its recording is not the size of the video'
  if (asset.sourceFps !== fps) return 'its recording is not at the video\'s frame rate'
  if (asset.sourceCursorHidden && (asset.trace?.cursor?.length ?? 0) > 0 && project.cursor.style !== 'none') return 'it draws a pointer'
  return null
}

/** Whether anything in it makes a sound (the Chrome path writes no audio track otherwise; not tested here). */
function audible(project: EditorProject): boolean {
  const hasAudio = (id: string) => project.assets.some((a) => a.id === id && a.hasAudio !== false)
  return project.clips.some((c) => !c.audio.muted && c.playbackRate <= 1 && hasAudio(c.assetId))
    || project.audioTracks.some((t) => !t.muted && t.segments.length > 0)
    || (!!project.presenterTrack && !project.presenterTrack.audio.muted && hasAudio(project.presenterTrack.assetId))
}

/**
 * The source frame @remotion/media shows at local frame `l` of a video started at `trimBefore` (project frames) and
 * played at `rate`: its time is l / fps × rate + trimBefore / fps, and the frame is the latest whose timestamp, rounded
 * to the millisecond, is at or before that time rounded alike, or within a millisecond after it
 * (@remotion/media 4.0.534, getFrameFromTimestamp). Pure; the arithmetic is the library's own, in the same order.
 */
export function remotionFrame(l: number, fps: number, rate: number, trimBefore: number, srcFps: number): number {
  const t = (l / fps) * rate + trimBefore / fps
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  let i = Math.max(0, Math.floor(t * srcFps) + 2)
  while (i > 0 && !(r3(i / srcFps) <= r3(t) || Math.abs(i / srcFps - t) <= 0.001)) i--
  return i
}

/**
 * The output frame a source frame `i` first appears at, as the FFmpeg graph places it (realise): the slot whose time,
 * plus a millisecond, reaches the frame's timestamp. The fps filter then shows, at every slot, the latest frame placed
 * at or before it. Pure.
 */
export function placedSlot(i: number, s: Pick<StreamPlan, 'srcFps' | 'rate' | 'startSeconds'>, fps: number): number {
  return Math.ceil((i / s.srcFps - s.startSeconds - 0.001) * fps / s.rate)
}

/** Whether FFmpeg's frames would be exactly remotionFrame's: every slot compared, and no placement a hair from a boundary. Pure. */
export function realiseProblem(s: StreamPlan, fps: number): string | null {
  const first = s.map[0]!, last = s.map.at(-1)!
  let shown = Math.max(0, first - 1) - 1
  const slotOf = new Map<number, number>()
  for (let i = Math.max(0, first - 1); i <= last + 1; i++) {
    const x = (i / s.srcFps - s.startSeconds - 0.001) * fps / s.rate
    if (Math.abs(x - Math.round(x)) < 1e-6) return 'a frame lands exactly between two output frames'
    slotOf.set(i, placedSlot(i, s, fps))
  }
  if (slotOf.get(first)! > 0) return 'the first frame would come late'
  for (let l = 0; l < s.map.length; l++) {
    for (let i = shown + 1; i <= last + 1 && (slotOf.get(i) ?? Infinity) <= l; i++) shown = i
    if (Math.max(shown, first) !== s.map[l]) return `FFmpeg would show frame ${Math.max(shown, first)} where Chrome shows ${s.map[l]}`
  }
  return null
}

// ---- FFmpeg ---------------------------------------------------------------------------------------------------------
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(9).replace(/0+$/, ''))

/**
 * The filter chain that turns a decoded input (seeked a little before the stream's first frame, timestamps kept)
 * into exactly `s.map`, `count` frames at `fps`, starting at time 0: each frame placed at placedSlot, the fps filter
 * repeating it until the next, the stretch before the first slot dropped, the last frame repeated if the source ends.
 */
export function realise(s: StreamPlan, fps: number, count: number, after = ''): string {
  const slot = `ceil((round(PTS*TB*${s.srcFps})/${s.srcFps}-${num(s.startSeconds)}-0.001)*${fps}/${s.rate})`
  return `settb=1/90000,setpts='${slot}*90000/${fps}'${after},fps=${fps},trim=start=0,setpts=PTS-STARTPTS,tpad=stop=-1:stop_mode=clone,trim=end_frame=${count}`
}

/** Where to seek an input so its first decoded frame is `index` (half a frame before), and how long to read. */
export const seekArgs = (s: Pick<StreamPlan, 'srcFps'>, first: number, last: number) =>
  ['-ss', num(Math.max(0, (first - 0.5) / s.srcFps)), '-t', num((last - first + 3) / s.srcFps), '-copyts']

/** The bubble's pixels: the box (even, around the fractional square) and the perspective that samples the camera there. */
export function bubbleGeometry(b: BubblePlan) {
  const { square: q, crop } = b
  const bx = Math.floor(q.x / 2) * 2, by = Math.floor(q.y / 2) * 2
  const bw = Math.ceil((q.x + q.side - bx) / 2) * 2, bh = Math.ceil((q.y + q.side - by) / 2) * 2
  const left = q.x + crop.x, top = q.y + crop.y, sc = b.camera.width / crop.width
  // Output pixel (i, j) of the box samples the camera at ((bx + i + 0.5 - left) × sc − 0.5, …), bilinear, as Chrome does.
  const x0 = (bx + 0.5 - left) * sc - 0.5, y0 = (by + 0.5 - top) * sc - 0.5
  const x1 = x0 + sc * b.camera.width, y2 = y0 + sc * b.camera.height
  // The clip as Chrome draws it: the bubble's square snapped to whole pixels (each side to the nearest pixel edge: its
  // straight sides are hard, no partial pixels), its corners rounded with the radius, at most half a side, antialiased.
  // Measured on flat colours (test/mask-e2e.ts): the corners' coverage within 0.010-0.020 RMS of Chrome's, the sides
  // exact; the fractional square's had 0.03-0.06.
  const sx0 = Math.round(q.x), sx1 = Math.round(q.x + q.side), sy0 = Math.round(q.y), sy1 = Math.round(q.y + q.side)
  const cx = (sx0 + sx1) / 2, cy = (sy0 + sy1) / 2, hx = (sx1 - sx0) / 2, hy = (sy1 - sy0) / 2, r = Math.min(b.radius, hx, hy)
  // A pixel's signed distance from the rounded rectangle's edge (below 0 inside), from its centre; coverage 0.5 - d.
  const qx = `abs(X+${bx}+0.5-${num(cx)})-${num(hx - r)}`, qy = `abs(Y+${by}+0.5-${num(cy)})-${num(hy - r)}`
  const d = `hypot(max(${qx}\\,0)\\,max(${qy}\\,0))+min(max(${qx}\\,${qy})\\,0)-${num(r)}`
  const mask = `255*clip(0.5-(${d})\\,0\\,1)`
  return { bx, by, bw, bh, x0, y0, x1, y2, mask }
}

/**
 * Frames whose pictures, as the graph has them before anything is drawn over them, are written as MD5s (FFmpeg's
 * framemd5) beside the clip: `screen` output frames of the recording, `camera` frames of the camera's stretch (after its
 * sampling, before the mask), each list ascending. The run compares them with the source frames the plan says they are.
 */
export interface FrameHashes { screen: number[]; camera: number[]; screenOut: string; cameraOut: string }

const selectFrames = (frames: number[]) => `select='${frames.map((l) => `eq(n\\,${l})`).join('+')}'`

/**
 * The filters that sample the camera into the bubble's box (bilinear, at the exact fractional place), in the camera's
 * own yuv420p: pinned, or FFmpeg may add the alpha plane the mask needs before the sampling (the same pixels, a plane
 * more to sample).
 */
export const bubbleSampling = (g: ReturnType<typeof bubbleGeometry>) =>
  `format=yuv420p,perspective=x0=${num(g.x0)}:y0=${num(g.y0)}:x1=${num(g.x1)}:y1=${num(g.y0)}:x2=${num(g.x0)}:y2=${num(g.y2)}:x3=${num(g.x1)}:y3=${num(g.y2)}:interpolation=linear,crop=${g.bw}:${g.bh}:0:0,format=yuv420p`

/** One clip's FFmpeg arguments (inputs as files under `dir`, the asset cache's parent), writing `out`. */
export function segmentArgs(seg: SegmentPlan, fps: number, path: (file: string) => string, out: string, hashes?: FrameHashes, encoder: string[] = FAST_ENCODER): string[] {
  const inputs: string[] = [], graph: string[] = [], extra: string[] = []
  let n = 0
  const input = (file: string, srcFps: number, first: number, last: number) => { inputs.push(...seekArgs({ srcFps }, first, last), '-i', path(file)); return n++ }
  const scr = input(seg.screen.file, seg.screen.srcFps, seg.screen.map[0]!, seg.screen.map.at(-1)!)
  graph.push(`[${scr}:v]${realise(seg.screen, fps, seg.frames)}[scr0]`)
  if (hashes?.screen.length) {
    graph.push(`[scr0]split[scr0k][scrh]`, `[scrh]${selectFrames(hashes.screen)}[scrhash]`)
    extra.push('-map', '[scrhash]', '-fps_mode', 'passthrough', '-f', 'framemd5', hashes.screenOut)
  }
  let screenOut = hashes?.screen.length ? 'scr0k' : 'scr0'
  if (seg.blend) {
    const b = seg.blend, f = b.frames
    const held = input(b.file, b.srcFps, b.index, b.index)
    // The frame's number from its time, both inputs on one 1/fps clock (blend's own N counts from 1): the k-th blended frame is (k + 1) / (f + 1) in, as SourceClip fades it.
    const a = `min(1\\,(round(T*${fps})+1)/${f + 1})`
    graph.push(`[${held}:v]trim=end_frame=1,setpts=0,loop=loop=${f - 1}:size=1:start=0,settb=1/${fps},setpts=N[held]`,
      `[${screenOut}]split[sa][sb]`, `[sa]trim=end_frame=${f},settb=1/${fps},setpts=N[head]`, `[sb]trim=start_frame=${f},setpts=PTS-STARTPTS[tail]`,
      `[head][held]blend=all_expr='A*${a}+B*(1-${a})'[mixed]`, `[mixed][tail]concat=n=2:v=1:a=0[scr1]`)
    screenOut = 'scr1'
  }
  // Every stream counted in whole frames on one clock, so the overlay pairs frames by number, not by rounded times.
  graph.push(`[${screenOut}]settb=1/${fps},setpts=N[scrN]`)
  screenOut = 'scrN'
  if (seg.bubble) {
    const b = seg.bubble, g = bubbleGeometry(b), cam = input(b.camera.file, b.camera.srcFps, b.camera.map[0]!, b.camera.map.at(-1)!)
    const persp = `,${bubbleSampling(g)}`
    graph.push(`color=c=black:s=${g.bw}x${g.bh}:r=1:d=1,format=gray,geq=lum='${g.mask}',loop=loop=-1:size=1,settb=1/${fps},setpts=N[mask]`)
    if (hashes?.camera.length) {
      graph.push(`[${cam}:v]${realise(b.camera, fps, b.camera.map.length, persp)},split[camr][camh]`, `[camh]${selectFrames(hashes.camera)}[camhash]`)
      extra.push('-map', '[camhash]', '-fps_mode', 'passthrough', '-f', 'framemd5', hashes.cameraOut)
    } else graph.push(`[${cam}:v]${realise(b.camera, fps, b.camera.map.length, persp)}[camr]`)
    graph.push(`[camr]settb=1/${fps},setpts=N+${b.offset},format=yuva420p[cam]`,
      `[cam][mask]alphamerge=shortest=1[bub]`, `[${screenOut}][bub]overlay=x=${g.bx}:y=${g.by}:eof_action=pass:format=yuv420[scr2]`)
    screenOut = 'scr2'
  }
  graph.push(`[${screenOut}]format=yuv420p,setsar=1,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv[v]`)
  return ['-nostdin', '-v', 'error', '-y', ...inputs, '-filter_complex', graph.join(';'), '-map', '[v]', '-frames:v', String(seg.frames), '-an',
    ...encoder, '-r', String(fps), '-video_track_timescale', '90000', '-f', 'mp4', out, ...extra]
}

/**
 * The Chrome path's encoder settings (render.ts, EXPORT_ENCODING), so the two paths make the same kind of file: the
 * default of segmentArgs. The encoder is a parameter (encoders.ts, kept out of the render version: an encoder is not
 * what is drawn), and encoders.ts's `x264` is these.
 */
export const FAST_ENCODER = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv']

/** A video file as ffprobe describes it (its first video stream), for sourcesFit. */
export interface SourceProbe {
  file: string; codec?: string; pixFmt?: string; colorSpace?: string; colorRange?: string; colorPrimaries?: string; colorTransfer?: string
  startTime?: number; sar?: string; rotation?: number
}

/**
 * Colour as tagged (or not) in what was proven against Chrome (test/fast-export-e2e.ts): BT.709 matrix, primaries and
 * transfer or none of them said, limited range or none said. The worker's own conform keeps what its source said, so a
 * browser's untagged take arrives untagged.
 */
export const PROVEN_COLOUR = { space: ['bt709', 'unknown'], primaries: ['bt709', 'unknown'], transfer: ['bt709', 'unknown'], range: ['tv', 'unknown'] }

/**
 * What the files must be for the plan to hold (after staging, from ffprobe): H.264 in yuv420p, colour as PROVEN_COLOUR,
 * square pixels, not turned, starting at 0. Pure.
 */
export function sourcesFit(streams: SourceProbe[]): string | null {
  const said = (v: string | undefined) => v ?? 'unknown'
  for (const s of streams) {
    if (s.codec !== 'h264') return `${s.file} is ${s.codec ?? 'not video'}, not H.264`
    if (s.pixFmt !== 'yuv420p') return `${s.file} is ${s.pixFmt}`
    if (!PROVEN_COLOUR.space.includes(said(s.colorSpace))) return `${s.file}'s colour is ${s.colorSpace}`
    if (!PROVEN_COLOUR.primaries.includes(said(s.colorPrimaries))) return `${s.file}'s primaries are ${s.colorPrimaries}`
    if (!PROVEN_COLOUR.transfer.includes(said(s.colorTransfer))) return `${s.file}'s transfer is ${s.colorTransfer}`
    if (!PROVEN_COLOUR.range.includes(said(s.colorRange))) return `${s.file} is ${s.colorRange} range`
    if (s.sar && !['1:1', '0:1'].includes(s.sar)) return `${s.file}'s pixels are not square (${s.sar})`
    if (s.rotation) return `${s.file} is turned ${s.rotation}°`
    if (Math.abs(s.startTime ?? 0) > 1e-6) return `${s.file} does not start at 0`
  }
  return null
}

/**
 * Whether a stream's frames `first`…`last` sit on its frame grid, as the plan assumes (realise numbers frames from their
 * times; Chrome picks them by their times): each present, once, within a quarter of a millisecond of i / fps.
 * `stamps`: packet times (seconds, any order) read around those frames. Null when they do, else why. Pure.
 */
export function stampsFit(stamps: number[], srcFps: number, first: number, last: number): string | null {
  const seen = new Set<number>()
  // The same packet read twice (overlapping reads) is one frame; two packets for one frame are not.
  for (const t of new Set(stamps)) {
    const i = Math.round(t * srcFps)
    if (i < first || i > last) continue
    if (Math.abs(t - i / srcFps) > 0.00025) return `frame ${i} is at ${t.toFixed(6)} s, off its place by ${((t - i / srcFps) * 1000).toFixed(2)} ms`
    if (seen.has(i)) return `frame ${i} is there twice`
    seen.add(i)
  }
  for (let i = first; i <= last; i++) if (!seen.has(i)) return `frame ${i} is missing`
  return null
}

/** The files a plan reads. */
export const planFiles = (plan: FastPlan) => [...new Set(plan.segments.flatMap((s) => [s.screen.file, ...(s.bubble ? [s.bubble.camera.file] : [])]))]

/**
 * The same video for Remotion to mix its sound from, without the pictures that make no sound: every clip shows
 * nothing (its sound plays from the composition's own audio layer, never from the picture), and a camera whose sound
 * is muted is left out. On one Mac this took a 20 s sound-only render from 65 s to 6 s (the pictures' frames were
 * still being read); on another it made no difference. Pure.
 */
export function soundOnly(project: EditorProject): EditorProject {
  const track = project.presenterTrack, camera = track && project.assets.find((a) => a.id === track.assetId)
  return {
    ...project,
    clips: project.clips.map((c) => ({ ...c, view: { main: 'slides', bubble: false } })),
    presenterTrack: track && !track.audio.muted && camera?.hasAudio ? track : null,
  }
}
