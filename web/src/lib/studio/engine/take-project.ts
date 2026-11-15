// A finished take as an edit, and a take placed into another video: pure, shared by the Studio's server (which builds
// the edit it files, server/recordings.ts) and the Mac app's page (which opens the same edit at Stop from the files on
// the computer, before the Studio has filed them: components/studio/record/provisional.ts).
import { EditorProjectSchema, defaultCaptions, defaultPresentation, neutralMotion, type EditorAsset, type EditorAudioTrack, type EditorClip, type EditorProject, type EditorTranscript, type PresenterTrack } from './contracts'
import { neutralMotionVisual } from './motion-contracts'
import { punchIn } from './punch'
import { recordIntoBeats, useTakeForBeat as takeForBeat, type PrompterMark } from './record-take'
import { clipsFromShots, recordedShotTimeline } from './shots'
import { scheduleProject } from './timeline'
import type { CameraSlot } from './storyboard'

/** A synced file once it is in the library. */
export type SyncedAsset = { asset: EditorAsset; offsetSeconds: number }
/** The take's media once imported. */
export type TakeMedia = { screen: EditorAsset; camera: SyncedAsset | null; microphone: SyncedAsset | null; systemAudio: SyncedAsset | null }


const even = (n: number) => Math.max(64, Math.min(8192, Math.round(n / 2) * 2))
const shortId = () => globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)

/** A label for a take: "Recording · 12 Nov 2026, 09:41". */
export function takeTitle(at: Date): string {
  return `Recording · ${at.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`
}

/** Focus changes in a trace, as recordedShotTimeline reads them: `trace.focus` [{t|ms, slides}] or focus actions. */
export function traceFocus(trace: EditorAsset['trace']): { ms: number; slides: boolean }[] {
  if (!trace) return []
  const raw = (trace as Record<string, unknown>).focus
  const out: { ms: number; slides: boolean }[] = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const ms = typeof e.ms === 'number' ? e.ms : typeof e.t === 'number' ? e.t : NaN
      if (Number.isFinite(ms)) out.push({ ms, slides: e.slides === true || e.focus === 'slides' })
    }
  }
  for (const action of trace.actions) {
    if (action.kind !== 'focus') continue
    const a = action as Record<string, unknown>
    out.push({ ms: action.t, slides: a.slides === true || a.focus === 'slides' })
  }
  return out.sort((a, b) => a.ms - b.ms)
}

/**
 * The first cut by what was shown: the whole take as one clip, split where the trace says the focus moved to a
 * source the edit can show. Today that source is the slides window (`slides`); with no deck in the take, every shot
 * is the screen and the take stays one clip, its webcam bubble on when there is a camera.
 */
export function firstCut(clip: EditorClip, screen: EditorAsset, options: { camera: boolean; slides: boolean }): EditorClip[] {
  const fps = screen.sourceFps!
  const durationMs = (screen.sourceFrames! / fps) * 1000
  const focus = traceFocus(screen.trace)
  if (options.slides && focus.length) {
    const appInput = (screen.trace?.actions ?? []).filter((a) => a.kind === 'click').map((a) => a.t)
    const shots = recordedShotTimeline({ focus, slideChanges: [], appInput, durationMs })
    if (shots.length > 1) return clipsFromShots(clip, fps, shots, options.camera)
  }
  return [{ ...clip, view: { main: 'screen', bubble: options.camera } }]
}

/** The camera as the presenter bubble (bottom right), synced to the screen take's clock. */
export function syncedPresenter(project: EditorProject, screen: EditorAsset, camera: SyncedAsset): PresenterTrack | null {
  const asset = camera.asset
  if (asset.kind !== 'video' || !asset.sourceFps || !asset.sourceFrames) return null
  const fps = project.output.fps
  const total = Math.round((screen.sourceFrames! / screen.sourceFps!) * fps)
  const start = Math.max(0, Math.round(camera.offsetSeconds * fps))
  // The master segment cannot run past the camera's own frames (in project frames).
  const frames = Math.min(total - start, Math.floor((asset.sourceFrames / asset.sourceFps) * fps))
  if (frames < 1) return null
  const side = Math.min(project.output.width * 0.22, project.output.height * 0.28)
  const width = side / project.output.width
  const height = side / project.output.height
  return {
    id: `presenter-${shortId()}`,
    assetId: asset.id,
    audio: { muted: true, gain: 1 },
    segments: [{
      id: `presenter-segment-${shortId()}`,
      startFrame: start,
      endFrame: start + frames,
      sourceStartFrame: 0,
      visual: { ...structuredClone(neutralMotionVisual), rect: { x: 1 - width - 0.04, y: 1 - height - 0.04, width, height } },
      tracks: [],
    }],
    sync: { screenAssetId: screen.id, offsetSeconds: camera.offsetSeconds },
  }
}

/** The label that marks an audio segment as following a screen take's clock: `sync:<screen asset>@<offset s>`. */
export const syncLabel = (screenAssetId: string, offsetSeconds: number) => `sync:${screenAssetId}@${Math.round(offsetSeconds * 1000) / 1000}`
const SYNC_LABEL = /^sync:([a-zA-Z0-9_-]{1,100})@(-?\d+(?:\.\d+)?)$/

/** Read a sync label back. */
export function parseSyncLabel(label: string | undefined): { screenAssetId: string; offsetSeconds: number } | null {
  const match = label ? SYNC_LABEL.exec(label) : null
  return match ? { screenAssetId: match[1]!, offsetSeconds: Number(match[2]) } : null
}

/**
 * The pieces of a synced audio file under every clip of its screen take, on the timeline: each clip's source time,
 * moved by the offset (audio time = screen time - offset), clamped to the audio's length. Clips played faster than
 * real time get no piece (sped-up typing is silent).
 */
export function syncedAudioSegments(project: EditorProject, screenAssetId: string, audio: EditorAsset, offsetSeconds: number): EditorAudioTrack['segments'] {
  const fps = project.output.fps
  const length = audio.durationSeconds ?? 0
  const label = syncLabel(screenAssetId, offsetSeconds)
  const out: EditorAudioTrack['segments'] = []
  for (const s of scheduleProject(project)) {
    if (s.asset.id !== screenAssetId || s.clip.playbackRate !== 1 || !s.asset.sourceFps) continue
    const from = s.clip.trimStartSourceFrame / s.asset.sourceFps - offsetSeconds
    const to = s.clip.trimEndSourceFrame / s.asset.sourceFps - offsetSeconds
    const start = Math.max(0, from)
    const end = Math.min(length, to)
    if (end - start < 1 / fps) continue
    out.push({
      id: `sync-${shortId()}`,
      assetId: audio.id,
      startFrame: s.startFrame + Math.round((start - from) * fps),
      trimStartSeconds: Math.round(start * 1e6) / 1e6,
      trimEndSeconds: Math.round(end * 1e6) / 1e6,
      label,
    })
  }
  return out
}

/**
 * Rebuild every synced audio piece from the clips it follows. Run after anything that moves clips around (a
 * punch-in, a take into beats): the narration lands under its picture again. Other segments are left alone.
 */
export function resyncAudio(project: EditorProject): EditorProject {
  let changed = false
  const audioTracks = project.audioTracks.map((track) => {
    const synced = new Map<string, { assetId: string; screenAssetId: string; offsetSeconds: number }>()
    for (const segment of track.segments) {
      const sync = parseSyncLabel(segment.label)
      if (sync) synced.set(`${segment.assetId}|${segment.label}`, { assetId: segment.assetId, ...sync })
    }
    if (!synced.size) return track
    changed = true
    const kept = track.segments.filter((segment) => !parseSyncLabel(segment.label))
    const rebuilt = [...synced.values()].flatMap(({ assetId, screenAssetId, offsetSeconds }) => {
      const asset = project.assets.find((a) => a.id === assetId)
      return asset && asset.kind === 'audio' ? syncedAudioSegments(project, screenAssetId, asset, offsetSeconds) : []
    })
    return { ...track, segments: [...kept, ...rebuilt].sort((a, b) => a.startFrame - b.startFrame) }
  })
  return changed ? { ...project, audioTracks } : project
}

/** A voiceover track that follows the screen take. */
function syncedTrack(project: EditorProject, name: string, screen: EditorAsset, audio: SyncedAsset): EditorAudioTrack | null {
  if (audio.asset.kind !== 'audio') return null
  const segments = syncedAudioSegments(project, screen.id, audio.asset, audio.offsetSeconds)
  return segments.length ? { id: `track-${shortId()}`, name, role: 'voiceover', gain: 1, muted: false, segments } : null
}

/** The asset that carries the take's voice: the microphone when it was recorded, else the screen file if it has sound. */
export function voiceAsset(media: TakeMedia): SyncedAsset | null {
  if (media.microphone?.asset.hasAudio) return media.microphone
  if (media.screen.hasAudio) return { asset: media.screen, offsetSeconds: 0 }
  return null
}

/** Words on the screen clock moved onto the voice file's own clock, kept inside it. */
export function wordsOnVoiceClock(words: { text: string; startMs: number; endMs: number }[], voice: SyncedAsset): { text: string; startMs: number; endMs: number }[] {
  const shift = voice.offsetSeconds * 1000
  const length = (voice.asset.durationSeconds ?? 0) * 1000
  let last = 0
  return words.flatMap((w) => {
    const startMs = Math.max(last, Math.round(w.startMs - shift))
    const endMs = Math.min(length, Math.round(w.endMs - shift))
    if (endMs <= 0 || startMs >= length) return []
    last = startMs
    return [{ text: w.text, startMs, endMs: Math.max(startMs, endMs) }]
  })
}

/** The edit a finished take opens as (or the take that is placed into another video). */
export function buildTakeProject(input: { id: string; title: string; media: TakeMedia; transcript?: EditorTranscript | null }): EditorProject {
  const { screen, camera, microphone, systemAudio } = input.media
  if (screen.kind !== 'video' || !screen.sourceFps || !screen.sourceFrames || !screen.width || !screen.height) throw new Error('The screen recording could not be read as a video.')
  const fps = Math.max(1, Math.min(60, Math.round(screen.sourceFps)))
  const whole: EditorClip = {
    id: `clip-${shortId()}`,
    assetId: screen.id,
    trimStartSourceFrame: 0,
    trimEndSourceFrame: screen.sourceFrames,
    audio: { muted: !screen.hasAudio, gain: 1 },
    holdEndFrames: 0,
    zooms: [],
    motion: neutralMotion(),
    playbackRate: 1,
    dismissedActionIndices: [],
  }
  let project: EditorProject = {
    schemaVersion: 4,
    id: input.id,
    title: input.title.slice(0, 250),
    output: { width: even(screen.width), height: even(screen.height), fps },
    assets: [screen],
    clips: [whole],
    presentation: structuredClone(defaultPresentation),
    // With a trace the editor draws its own cursor where the real one was hidden.
    cursor: screen.trace && screen.sourceCursorHidden ? { style: 'glass', size: 18, clickFeedback: true } : { style: 'none', size: 18, clickFeedback: false },
    audioTracks: [],
    presenterTrack: null,
    transcripts: [],
    captions: structuredClone(defaultCaptions),
    captionCorrections: {},
    voiceoverDraft: { text: '', targetClipIds: [] },
  }
  const presenter = camera ? syncedPresenter(project, screen, camera) : null
  if (presenter && camera) project = { ...project, assets: [...project.assets, camera.asset], presenterTrack: presenter }
  project = { ...project, clips: firstCut(whole, screen, { camera: !!presenter, slides: !!project.slideDeck }) }
  for (const [name, audio] of [['Microphone', microphone], ['Screen sound', systemAudio]] as const) {
    if (!audio) continue
    const track = syncedTrack(project, name, screen, audio)
    if (!track) continue
    project = { ...project, assets: project.assets.some((a) => a.id === audio.asset.id) ? project.assets : [...project.assets, audio.asset], audioTracks: [...project.audioTracks, track] }
  }
  if (input.transcript && project.assets.some((a) => a.id === input.transcript!.assetId)) project = { ...project, transcripts: [input.transcript] }
  return EditorProjectSchema.parse(project)
}

/**
 * A track of a take that reached the Studio after the take was made a video (its import failed and the computer sent
 * it again): the camera as the bubble (when the video has none), or the microphone or the screen's sound as a track
 * that follows the take's screen. A video that has it already (by asset) is answered as it is. Pure; null when the
 * video no longer shows the take's screen (nothing to follow).
 */
export function attachTakeTrack(project: EditorProject, screenAssetId: string, role: 'camera' | 'microphone' | 'systemAudio', asset: EditorAsset, offsetSeconds: number): EditorProject | null {
  if (project.assets.some((a) => a.id === asset.id)) return project
  const screen = project.assets.find((a) => a.id === screenAssetId)
  if (!screen || screen.kind !== 'video') return null
  if (role === 'camera') {
    if (project.presenterTrack) return null
    const presenter = syncedPresenter(project, screen, { asset, offsetSeconds })
    return presenter ? EditorProjectSchema.parse({ ...project, assets: [...project.assets, asset], presenterTrack: presenter }) : null
  }
  const track = syncedTrack(project, role === 'microphone' ? 'Microphone' : 'Screen sound', screen, { asset, offsetSeconds })
  return track && project.audioTracks.length < 16 ? EditorProjectSchema.parse({ ...project, assets: [...project.assets, asset], audioTracks: [...project.audioTracks, track] }) : null
}

/** The take's synced audio tracks carried into a video it was placed in (punchIn and recordIntoBeats leave them out). */
function carryTakeAudio(placed: EditorProject, take: EditorProject): EditorProject {
  let audioTracks = placed.audioTracks
  for (const track of take.audioTracks) {
    const synced = track.segments.filter((segment) => parseSyncLabel(segment.label))
    if (!synced.length) continue
    const home = audioTracks.find((t) => t.role === 'voiceover' && t.name === track.name)
    if (home) audioTracks = audioTracks.map((t) => (t.id === home.id ? { ...t, segments: [...t.segments, ...synced] } : t))
    else if (audioTracks.length < 16) audioTracks = [...audioTracks, { ...track, id: audioTracks.some((t) => t.id === track.id) ? `track-${shortId()}` : track.id, segments: synced }]
  }
  const assets = [...placed.assets, ...take.assets.filter((a) => !placed.assets.some((b) => b.id === a.id))]
  return { ...placed, assets, audioTracks }
}

export type Placement =
  | { kind: 'punch'; fromFrame: number; toFrame: number }
  | { kind: 'beats'; beatIds: string[]; marks: PrompterMark[]; extraCameraSlots: CameraSlot[] }
  | { kind: 'use-take'; beatId: string }

/** Put a take into a video: a punch-in, a recording into beats, or a beat switched back to this take. */
export function placeTake(target: EditorProject, take: EditorProject, placement: Placement, info: { sessionId: string; at: string; screenAssetId: string }): EditorProject {
  let placed: EditorProject
  if (placement.kind === 'punch') placed = punchIn(target, take, placement.fromFrame, placement.toFrame)
  else if (placement.kind === 'beats') placed = recordIntoBeats(target, take, placement.beatIds, { ...info, marks: placement.marks, extraCameraSlots: placement.extraCameraSlots })
  else placed = takeForBeat(target, take, placement.beatId, info.sessionId)
  return EditorProjectSchema.parse(resyncAudio(carryTakeAudio(placed, take)))
}
