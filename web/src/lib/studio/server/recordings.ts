// Recordings: a finished take's files, uploaded by the browser or the Mac app, become a video that is ready to edit.
//
//   POST /recordings     {screen, camera?, microphone?, systemAudio?, trace?, transcript?, punch? | beats?}
//   GET  /recordings/:id
//
// A browser take arrives as tracks uploaded while it recorded (`live/<take>/<role>`, live-takes.ts), sealed here; a
// take whose window closed mid-way is brought back from what arrived (recoverTake).
//
// Each file is imported by the worker (an `import` job): the screen conformed to 60 fps (30 when it was recorded at 45
// fps or fewer) with its input trace, the camera to 30 fps, the microphone and the system sound as audio. The app
// waits for those jobs (up to ~100 s on the POST, a few seconds on each GET), and the worker's end of the last one
// builds it too (recordingImportEnded), so a take is finished even when nobody waits on it. The edit is built exactly
// as a finished take always opened:
//
//   - one clip of the whole screen take (the first cut by what was shown, from the trace's focus changes, when the
//     take has a source to cut to),
//   - the camera as the presenter bubble, synced to the screen clock (camera time = screen time - its offset),
//   - the microphone (and the system sound, when it is its own file) as voiceover tracks that follow the screen
//     clips on the same clock: every clip of the screen take has its piece of narration under it,
//   - the transcript the Mac heard, when it gave one (else the editor transcribes the voice when it opens the take).
//
// A take recorded for an open video (punch-in, or into storyboard beats) is placed into that video instead, with
// the digest guard and a version kept from before it ("Before take <id>"), which is what removing the take restores.
//
// A recording's state is one record (collection `recordings`, key = its id): what was sent, the jobs, and once
// built, the video and the assets, so a beat can later switch back to this take.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EditorProjectSchema, TraceSchema, defaultCaptions, defaultPresentation, neutralMotion, type EditorAsset, type EditorAudioTrack, type EditorClip, type EditorProject, type EditorTranscript, type PresenterTrack } from '../engine/contracts'
import { neutralMotionVisual } from '../engine/motion-contracts'
import { punchIn } from '../engine/punch'
import { recordIntoBeats, useTakeForBeat as takeForBeat, type PrompterMark } from '../engine/record-take'
import { clipsFromShots, recordedShotTimeline } from '../engine/shots'
import { scheduleProject } from '../engine/timeline'
import type { CameraSlot } from '../engine/storyboard'
import { getAssets, importTimedTranscript } from './assets'
import { commitBlob } from './blobs'
import { isUuid, must, type StudioContext } from './context'
import { conflictError, notFoundError, StudioError } from './errors'
import type { ImportInput } from './job-contract'
import { claimLiveTake, isLiveKey, retireLiveTake, loadTake, parseLiveKey, reopenLiveTake, sealLiveTrack, sealStoppedTake, TRACK_MAX_PIECES, unclaimLiveTake, type SealedTrack, type TakeRecord } from './live-takes'
import { getRecord, putRecord } from './records'
import { createVideo, openVideo, saveVideo } from './videos'

// ---- what the recorder sends ----------------------------------------------------------------------------------

/**
 * An upload of this person's, as POST /uploads named it, or a track of a take uploaded while it was recorded
 * (`live/<take>/<role>`, live-takes.ts).
 */
const uploadKey = z.string().refine((key) => /^uploads\/[0-9a-f-]{36}$/.test(key) || isLiveKey(key), 'Upload the file first')
const fileName = z.string().trim().min(1).max(240)
const offset = z.number().finite().min(-3600).max(3600)
/**
 * A live track: how many pieces the recorder sent (every one must be in storage before the take is queued), and
 * `partial` when it stopped sending before the recording's end (the Studio refused the rest).
 */
const pieces = z.number().int().min(1).max(TRACK_MAX_PIECES).optional()
const partial = z.literal(true).optional()
/** The frame rate the recorder asked for or the device said it gives (getSettings().frameRate): the most it is conformed to. */
const frameRate = z.number().finite().positive().max(240).optional()
const MainFileSchema = z.object({ uploadKey, name: fileName, pieces, partial, frameRate }).strict()
const SyncedFileSchema = z.object({ uploadKey, name: fileName, offsetSeconds: offset, pieces, partial, frameRate }).strict()
const WordSchema = z.object({ text: z.string().trim().min(1).max(500), startMs: z.number().finite().nonnegative(), endMs: z.number().finite().nonnegative() }).strict()
const projectId = z.string().refine(isUuid, 'Not a video id')

export const RecordingInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  recorder: z.enum(['browser', 'desktop']).default('browser'),
  screen: MainFileSchema,
  camera: SyncedFileSchema.optional(),
  microphone: SyncedFileSchema.optional(),
  systemAudio: SyncedFileSchema.optional(),
  trace: TraceSchema.optional(),
  sourceCursorHidden: z.boolean().default(false),
  /** Words heard in the take, in ms on the screen file's clock. */
  transcript: z.object({ words: z.array(WordSchema).min(1).max(40_000) }).strict().optional(),
  durationSeconds: z.number().finite().nonnegative().max(24 * 3600).optional(),
  /** Punch-in: the take replaces fromFrame..toFrame of the video (equal frames: inserted there). */
  punch: z.object({ projectId, fromFrame: z.number().int().nonnegative(), toFrame: z.number().int().nonnegative() }).strict()
    .refine((p) => p.toFrame >= p.fromFrame, 'The punch range ends before it starts').optional(),
  /** Recording into storyboard beats: these beats get the take, split by the teleprompter's Next/Retake marks. */
  beats: z.object({
    projectId,
    beatIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).min(1).max(100),
    marks: z.array(z.object({ ms: z.number().finite().nonnegative(), beat: z.number().int().nonnegative().optional(), retake: z.number().int().nonnegative().optional() }).strict()).max(2000).default([]),
    extraCameraSlots: z.array(z.enum(['B', 'C', 'D'])).max(3).optional(),
  }).strict().optional(),
}).strict().refine((r) => !(r.punch && r.beats), 'A take goes into a punch range or into beats, not both')
export type RecordingInput = z.infer<typeof RecordingInputSchema>

type Role = 'screen' | 'camera' | 'microphone' | 'systemAudio'
const ROLES: Role[] = ['screen', 'camera', 'microphone', 'systemAudio']

/** A synced file once it is in the library. */
export type SyncedAsset = { asset: EditorAsset; offsetSeconds: number }
/** The take's media once imported. */
export type TakeMedia = { screen: EditorAsset; camera: SyncedAsset | null; microphone: SyncedAsset | null; systemAudio: SyncedAsset | null }

// ---- building the edit (pure) ---------------------------------------------------------------------------------

const even = (n: number) => Math.max(64, Math.min(8192, Math.round(n / 2) * 2))
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12)

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
  if (screen.kind !== 'video' || !screen.sourceFps || !screen.sourceFrames || !screen.width || !screen.height) throw new StudioError('The screen recording could not be read as a video.')
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

// ---- the recording's record ------------------------------------------------------------------------------------

const COLLECTION = 'recordings'

type RecordingRecord = {
  id: string
  createdAt: string
  /** Who recorded it: the video is built as theirs, also when the worker's finished import builds it. */
  ownerId?: string | null
  /** The take it came from, when it was uploaded while it was recorded (live-takes.ts). */
  takeId?: string
  /** True when it was brought back after the recording stopped unexpectedly (its end may be missing). */
  recovered?: boolean
  status: 'importing' | 'building' | 'done' | 'failed'
  /** Who is building it right now (a token), so two polls don't build twice. */
  claim: string | null
  claimedAt: string | null
  input: RecordingInput
  jobs: Partial<Record<Role, string>>
  /** Once built: where it went and what it is made of. */
  projectId?: string
  placed?: 'new' | 'punch' | 'beats'
  media?: { screenAssetId: string; camera?: { assetId: string; offsetSeconds: number }; microphone?: { assetId: string; offsetSeconds: number }; systemAudio?: { assetId: string; offsetSeconds: number }; transcriptId?: string }
  voiceAssetId?: string
  note?: string
  error?: string
}

/** What the recorder's client reads back. */
export type RecordingView = {
  id: string
  status: 'processing' | 'done' | 'failed'
  progress: number
  step: string
  projectId?: string
  placed?: 'new' | 'punch' | 'beats'
  screenAssetId?: string
  voiceAssetId?: string
  note?: string
  error?: string
}
export type RecordingAnswer = { recording: RecordingView; project?: EditorProject; projectDigest?: string }

const view = (record: RecordingRecord, progress: number, step: string): RecordingView => ({
  id: record.id,
  status: record.status === 'done' ? 'done' : record.status === 'failed' ? 'failed' : 'processing',
  progress,
  step,
  ...(record.projectId ? { projectId: record.projectId } : {}),
  ...(record.placed ? { placed: record.placed } : {}),
  ...(record.media ? { screenAssetId: record.media.screenAssetId } : {}),
  ...(record.voiceAssetId ? { voiceAssetId: record.voiceAssetId } : {}),
  ...(record.note ? { note: record.note } : {}),
  ...(record.error ? { error: record.error } : {}),
})

async function loadRecord(ctx: StudioContext, id: string): Promise<RecordingRecord> {
  if (!isUuid(id)) throw notFoundError('Recording not found')
  const record = await getRecord<RecordingRecord>(ctx, COLLECTION, id)
  if (!record) throw notFoundError('Recording not found')
  return record
}

/**
 * Take the right to build: the record moves from importing to building only if nobody else holds it (or the one who
 * did has been gone two minutes). Answers the claimed record, or null.
 */
async function claim(ctx: StudioContext, record: RecordingRecord): Promise<RecordingRecord | null> {
  const stale = record.status === 'building' && (!record.claimedAt || Date.now() - Date.parse(record.claimedAt) > 120_000)
  if (record.status !== 'importing' && !stale) return null
  const token = randomUUID()
  const next: RecordingRecord = { ...record, status: 'building', claim: token, claimedAt: new Date().toISOString() }
  let query = ctx.supabase.from('studio_record').update({ value: next, updated_at: new Date().toISOString() })
    .eq('workspace_id', ctx.workspaceId).eq('collection', COLLECTION).eq('key', record.id)
  query = record.claim ? query.eq('value->>claim', record.claim) : query.is('value->>claim', null)
  const { data, error } = await query.select('key')
  if (error) {
    console.error('[studio] claiming a recording:', error.message?.slice(0, 300))
    return null
  }
  return data?.length ? next : null
}

// ---- the service -----------------------------------------------------------------------------------------------

type Jobs = typeof import('./jobs')
const jobsModule = (): Promise<Jobs> => import('./jobs')

/**
 * Queue the imports of a finished take and answer once it is an edit (or still processing after `waitMs`). A file is
 * an upload (committed here: every part in storage) or a track of a take uploaded while it was recorded (sealed
 * here: every piece the recorder says it sent in storage at its length; one take, the person's own, each track under
 * its own role).
 */
export async function startRecording(ctx: StudioContext, body: unknown, waitMs = 100_000, options: { recovered?: boolean } = {}): Promise<RecordingAnswer> {
  const input = RecordingInputSchema.parse(body)
  const keys = ROLES.flatMap((role) => (input[role] ? [input[role]!.uploadKey] : []))
  if (new Set(keys).size !== keys.length) throw new StudioError('Each file of a take is its own upload.')
  const takes = new Set<string>()
  for (const role of ROLES) {
    const live = input[role] ? parseLiveKey(input[role]!.uploadKey) : null
    if (!live) continue
    if (live.role !== role) throw new StudioError('Each track of a take goes under its own role.')
    takes.add(live.takeId)
  }
  if (takes.size > 1) throw new StudioError('The tracks of a take come from one recording.')
  const takeId = [...takes][0]
  // A take is made into one recording: asked again (the answer was lost, "Try again"), the one it became answers.
  const take: TakeRecord | null = takeId ? await loadTake(ctx, takeId) : null
  if (take?.status === 'finished' && take.recordingId) return existingRecording(ctx, take.recordingId, waitMs)
  // Every upload must be complete before anything is queued.
  const sealed: Partial<Record<Role, SealedTrack>> = {}
  for (const role of ROLES) {
    const file = input[role]
    if (!file) continue
    if (isLiveKey(file.uploadKey)) {
      const track = await sealLiveTrack(ctx, file.uploadKey, options.recovered ? undefined : (file.pieces ?? 'all'), { cut: file.partial === true })
      if (!track) throw new StudioError(`Nothing of the ${role === 'systemAudio' ? 'system sound' : role} was saved.`)
      sealed[role] = track
    } else await commitBlob(ctx, file.uploadKey)
  }
  const { queueJob } = await jobsModule()
  const id = randomUUID()
  // Take the take for this recording before anything is queued: of two requests at once, one queues, the other answers its recording.
  if (take && !(await claimLiveTake(ctx, take, id))) {
    const now = await loadTake(ctx, take.id)
    if (now.status === 'finished' && now.recordingId) return existingRecording(ctx, now.recordingId, waitMs)
    throw conflictError('This recording changed while it was being saved. Try again.')
  }
  try {
    return await queueRecording(ctx, input, sealed, id, takeId, options, queueJob, waitMs)
  } catch (error) {
    if (take) await unclaimLiveTake(ctx, take, id).catch(() => undefined)
    throw error
  }
}

/** The answer for a recording a take already became (one being made may not be written yet: it is being prepared). */
async function existingRecording(ctx: StudioContext, recordingId: string, waitMs: number): Promise<RecordingAnswer> {
  try {
    return await advanceRecording(ctx, recordingId, Math.min(waitMs, 4_000))
  } catch (error) {
    if (error instanceof StudioError && error.status === 404) return { recording: { id: recordingId, status: 'processing', progress: 0, step: 'Preparing your recording' } }
    throw error
  }
}

async function queueRecording(
  ctx: StudioContext, input: RecordingInput, sealed: Partial<Record<Role, SealedTrack>>, id: string, takeId: string | undefined,
  options: { recovered?: boolean }, queueJob: Jobs['queueJob'], waitMs: number,
): Promise<RecordingAnswer> {
  const jobs: Partial<Record<Role, string>> = {}
  const queue = async (role: Role, extra: Partial<ImportInput>) => {
    const file = input[role]
    if (!file) return
    const live = sealed[role]
    const hint = live?.seconds || input.durationSeconds
    const row = await queueJob(ctx, 'import', {
      uploadKey: file.uploadKey,
      name: file.name,
      provenance: { recording: id, role, recorder: input.recorder, ...(live ? { live: true } : {}) },
      ...(live && !live.complete ? { partial: true } : {}),
      ...(hint ? { durationHint: Math.round(hint) } : {}),
      ...extra,
    })
    jobs[role] = row.id
  }
  // The screen at 60 fps when its frames came that fast while it moved, else 30 (no frame is made up to fill 60); never
  // above the rate the recorder asked for.
  const ceiling = input.screen.frameRate ?? sealed.screen?.frameRate
  await queue('screen', { conform: { fps: 60, fit: true, ...(ceiling ? { ceiling } : {}) }, sourceCursorHidden: input.sourceCursorHidden, ...(input.trace ? { trace: input.trace } : {}) })
  await queue('camera', { conform: { fps: 30 }, sourceCursorHidden: false })
  await queue('microphone', { sourceCursorHidden: false })
  await queue('systemAudio', { sourceCursorHidden: false })
  const record: RecordingRecord = {
    id, createdAt: new Date().toISOString(), ownerId: ctx.userId, ...(takeId ? { takeId } : {}), ...(options.recovered ? { recovered: true } : {}),
    status: 'importing', claim: null, claimedAt: null, input, jobs,
  }
  await putRecord(ctx, COLLECTION, id, record)
  return advanceRecording(ctx, id, waitMs)
}

/**
 * Bring back a take whose recording stopped before it was finished (the window closed, the app or the machine
 * crashed): every track is sealed from the pieces that arrived and the take becomes a new video, as a finished take
 * does. The camera and the sound keep the place on the screen's clock they said when they started.
 */
export async function recoverTake(ctx: StudioContext, takeId: string, waitMs = 0, now = Date.now()): Promise<RecordingAnswer> {
  const { take, tracks } = await sealStoppedTake(ctx, takeId, now)
  const at = new Date(take.createdAt)
  const file = (role: Role) => tracks.find((track) => track.role === role)
  const synced = (role: Exclude<Role, 'screen'>) => {
    const track = file(role)
    return track ? { [role]: { uploadKey: track.key, name: track.name, offsetSeconds: Math.max(-3600, Math.min(3600, track.offsetSeconds ?? 0)) } } : {}
  }
  const screen = file('screen')!
  return startRecording(ctx, {
    title: `${takeTitle(at)} (recovered)`,
    recorder: take.recorder,
    screen: { uploadKey: screen.key, name: screen.name, ...(screen.frameRate ? { frameRate: screen.frameRate } : {}) },
    ...synced('camera'),
    ...synced('microphone'),
    ...synced('systemAudio'),
    ...(screen.seconds ? { durationSeconds: screen.seconds } : {}),
  }, waitMs, { recovered: true })
}

/** The person's recordings of the last day, newest first: those still being prepared show where they stand. */
export async function listRecordings(ctx: StudioContext, now = Date.now()): Promise<{ recordings: RecordingView[] }> {
  if (!ctx.userId) return { recordings: [] }
  const rows = must(
    await ctx.supabase.from('studio_record').select('key, value').eq('workspace_id', ctx.workspaceId).eq('collection', COLLECTION).eq('value->>ownerId', ctx.userId)
      .gte('updated_at', new Date(now - 24 * 3600_000).toISOString()).order('updated_at', { ascending: false }).limit(10),
    'read your recordings',
  ) as { key: string; value: RecordingRecord }[] | null
  const out: RecordingView[] = []
  for (const { value } of rows ?? []) {
    if (value.status === 'done' || value.status === 'failed') out.push(view(value, 1, value.status === 'done' ? 'Ready' : 'Failed'))
    else out.push((await advanceRecording(ctx, value.id, 0).catch(() => ({ recording: view(value, 0, 'Preparing your recording') }))).recording)
  }
  return { recordings: out }
}

/**
 * One of a recording's imports ended (the worker completed or failed it): when it was the last, the video is built
 * now, so a take finishes even when nobody is waiting on it (the person closed the dialog, or the page). Never throws.
 */
export async function recordingImportEnded(supabase: StudioContext['supabase'], storage: StudioContext['storage'], workspaceId: string, recordingId: unknown): Promise<void> {
  try {
    if (!isUuid(recordingId)) return
    const base: StudioContext = { supabase, storage, workspaceId, userId: null }
    const record = await getRecord<RecordingRecord>(base, COLLECTION, recordingId)
    if (!record || record.status === 'done' || record.status === 'failed') return
    await advanceRecording({ ...base, userId: record.ownerId ?? null }, recordingId, 0)
  } catch (error) {
    console.error('[studio] finishing a recording after its import failed:', error instanceof Error ? error.message : error)
  }
}

/**
 * Where a recording stands; builds its edit once the imports are done. `waitMs`: how long to wait for them here. A
 * person reaches only their own recording (another's answers not found); the worker's follow-up and the sweep act for
 * nobody. It is always built as the person who recorded it.
 */
export async function advanceRecording(ctx: StudioContext, id: string, waitMs = 4_000): Promise<RecordingAnswer> {
  let record = await loadRecord(ctx, id)
  if (ctx.userId && record.ownerId && record.ownerId !== ctx.userId) throw notFoundError('Recording not found')
  if (record.ownerId) ctx = { ...ctx, userId: record.ownerId }
  if (record.status === 'done') return answerDone(ctx, record)
  if (record.status === 'failed') return { recording: view(record, 1, 'Failed') }
  const { waitForJob, jobRow } = await jobsModule()
  const until = Date.now() + waitMs
  const rows = new Map<Role, Awaited<ReturnType<Jobs['jobRow']>>>()
  for (const role of ROLES) {
    const jobId = record.jobs[role]
    if (!jobId) continue
    const left = until - Date.now()
    rows.set(role, left > 1200 ? await waitForJob(ctx, jobId, { timeoutMs: left, everyMs: 1000 }) : await jobRow(ctx, jobId))
  }
  const finished = (status: string) => status === 'completed' || status === 'failed' || status === 'cancelled'
  const all = [...rows.values()]
  const progress = all.length ? all.reduce((sum, row) => sum + (finished(row.status) ? 1 : Number(row.progress) || 0), 0) / all.length : 0
  const screenRow = rows.get('screen')
  if (screenRow && (screenRow.status === 'failed' || screenRow.status === 'cancelled')) {
    record = { ...record, status: 'failed', error: screenRow.error || 'The screen recording could not be imported.' }
    await putRecord(ctx, COLLECTION, id, record)
    await settleTake(ctx, record)
    return { recording: view(record, 1, 'Failed') }
  }
  if (!all.every((row) => finished(row.status))) {
    const waiting = all.find((row) => !finished(row.status))
    const step = waiting?.status === 'queued' ? 'Waiting for the Studio worker' : waiting?.logs?.at(-1) || 'Preparing your recording'
    return { recording: view(record, Math.min(0.99, progress), String(step).slice(0, 200)) }
  }
  const claimed = await claim(ctx, record)
  if (!claimed) {
    const latest = await loadRecord(ctx, id)
    return latest.status === 'done' ? answerDone(ctx, latest) : { recording: view(latest, 0.99, 'Putting your recording together') }
  }
  try {
    const assetOf = (role: Role) => {
      const row = rows.get(role)
      return row?.status === 'completed' ? ((row.result as { asset?: EditorAsset } | null)?.asset ?? null) : null
    }
    const screen = assetOf('screen')
    if (!screen) throw new StudioError('The screen recording could not be imported.')
    const synced = (role: Exclude<Role, 'screen'>): SyncedAsset | null => {
      const asset = assetOf(role)
      return asset ? { asset, offsetSeconds: claimed.input[role]!.offsetSeconds } : null
    }
    const media: TakeMedia = { screen, camera: synced('camera'), microphone: synced('microphone'), systemAudio: synced('systemAudio') }
    const lost = (['camera', 'microphone', 'systemAudio'] as const).filter((role) => claimed.jobs[role] && !media[role])
    const note = lost.length ? `The ${lost.map((role) => (role === 'systemAudio' ? 'system sound' : role)).join(' and ')} could not be added to this take.` : undefined
    const built = await buildRecording(ctx, claimed, media)
    const done: RecordingRecord = { ...claimed, ...built, status: 'done', claim: null, claimedAt: null, ...(note ? { note } : {}) }
    await putRecord(ctx, COLLECTION, id, done)
    await settleTake(ctx, done)
    return answerDone(ctx, done)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The recording could not be put together.'
    const failed: RecordingRecord = { ...claimed, status: 'failed', claim: null, claimedAt: null, error: message.slice(0, 1000) }
    await putRecord(ctx, COLLECTION, id, failed)
    await settleTake(ctx, failed)
    return { recording: view(failed, 1, 'Failed') }
  }
}

/**
 * A recording made from a take ended. Made: the take's pieces go (the video holds the recording now; a track whose
 * import failed goes too, and the recording's note says so). Not made: every piece is kept and the take is offered
 * back, to be brought back again or thrown away; that keeps the person's footage when the Studio failed it. Never throws.
 */
async function settleTake(ctx: StudioContext, record: RecordingRecord): Promise<void> {
  if (!record.takeId) return
  try {
    if (record.status === 'failed') return await reopenLiveTake(ctx, record.takeId, record.id)
    const take = await getRecord<TakeRecord>(ctx, 'live-takes', record.takeId)
    if (take && take.recordingId === record.id) await retireLiveTake(ctx, take)
  } catch (error) {
    console.error('[studio] removing a recording’s pieces failed (the sweep retries):', error instanceof Error ? error.message : error)
  }
}

/** Register the transcript the Mac heard, on the voice file's own clock; null when there is none to register. */
async function registerHeard(ctx: StudioContext, input: RecordingInput, media: TakeMedia): Promise<EditorTranscript | null> {
  const voice = voiceAsset(media)
  if (!input.transcript || !voice) return null
  const words = wordsOnVoiceClock(input.transcript.words, voice)
  if (!words.length) return null
  try {
    return await importTimedTranscript(ctx, voice.asset.id, { words, text: words.map((w) => w.text).join(' ') })
  } catch (error) {
    console.error('[studio] registering a recording transcript failed:', error instanceof Error ? error.message : error)
    return null
  }
}

/** Build the take and save it as a new video, or place it into the video it was recorded for. */
async function buildRecording(ctx: StudioContext, record: RecordingRecord, media: TakeMedia): Promise<Pick<RecordingRecord, 'projectId' | 'placed' | 'media' | 'voiceAssetId' | 'note'>> {
  const input = record.input
  const transcript = await registerHeard(ctx, input, media)
  const at = new Date(record.createdAt)
  const stored = {
    screenAssetId: media.screen.id,
    ...(media.camera ? { camera: { assetId: media.camera.asset.id, offsetSeconds: media.camera.offsetSeconds } } : {}),
    ...(media.microphone ? { microphone: { assetId: media.microphone.asset.id, offsetSeconds: media.microphone.offsetSeconds } } : {}),
    ...(media.systemAudio ? { systemAudio: { assetId: media.systemAudio.asset.id, offsetSeconds: media.systemAudio.offsetSeconds } } : {}),
    ...(transcript ? { transcriptId: transcript.id } : {}),
  }
  const voiceAssetId = voiceAsset(media)?.asset.id
  const target = input.punch ?? input.beats
  if (target) {
    try {
      const take = buildTakeProject({ id: record.id, title: input.title ?? takeTitle(at), media, transcript })
      const placement: Placement = input.punch
        ? { kind: 'punch', fromFrame: input.punch.fromFrame, toFrame: input.punch.toFrame }
        : { kind: 'beats', beatIds: input.beats!.beatIds, marks: input.beats!.marks, extraCameraSlots: input.beats!.extraCameraSlots ?? ['B', 'C', 'D'] }
      await placeIntoVideo(ctx, target.projectId, take, placement, { sessionId: record.id, at: record.createdAt, screenAssetId: media.screen.id })
      return { projectId: target.projectId, placed: input.punch ? 'punch' : 'beats', media: stored, ...(voiceAssetId ? { voiceAssetId } : {}) }
    } catch (error) {
      // As before: a take that cannot go where it was meant to opens as its own video, and says why.
      console.error('[studio] placing a take failed; it opens as its own video:', error instanceof Error ? error.message : error)
      const project = buildTakeProject({ id: record.id, title: input.title ?? takeTitle(at), media, transcript })
      await saveNew(ctx, project)
      return {
        projectId: project.id, placed: 'new', media: stored, ...(voiceAssetId ? { voiceAssetId } : {}),
        note: `The take could not go into that video (${error instanceof Error ? error.message : 'it changed'}), so it opened as its own.`.slice(0, 300),
      }
    }
  }
  const project = buildTakeProject({ id: record.id, title: input.title ?? takeTitle(at), media, transcript })
  await saveNew(ctx, project)
  return { projectId: project.id, placed: 'new', media: stored, ...(voiceAssetId ? { voiceAssetId } : {}) }
}

/** Save a new video; one already saved under that id (an earlier attempt) is kept. */
async function saveNew(ctx: StudioContext, project: EditorProject) {
  try {
    await createVideo(ctx, project)
  } catch (error) {
    if (error instanceof StudioError && error.status === 409) {
      await openVideo(ctx, project.id)
      return
    }
    throw error
  }
}

/** Place a take into a video under the digest guard, keeping a version from before it (what "remove take" restores). */
async function placeIntoVideo(ctx: StudioContext, videoId: string, take: EditorProject, placement: Placement, info: { sessionId: string; at: string; screenAssetId: string }) {
  const { saveVersion } = await import('./versions')
  for (let attempt = 0; attempt < 3; attempt++) {
    const opened = await openVideo(ctx, videoId)
    if (placement.kind !== 'use-take' && opened.project.clips.some((clip) => clip.assetId === info.screenAssetId)) return opened
    const next = placeTake(opened.project, take, placement, info)
    await saveVersion(ctx, videoId, 'project', placement.kind === 'use-take' ? `Before switching beat ${placement.beatId} to take ${info.sessionId}` : `Before take ${info.sessionId}`, opened.project).catch(() => null)
    try {
      return await saveVideo(ctx, next, opened.projectDigest)
    } catch (error) {
      // Saved by someone else in between: place it again on their version.
      if (error instanceof StudioError && error.code === 'DIGEST_CONFLICT') continue
      throw error
    }
  }
  throw conflictError('That video kept changing while the take was placed. Try again.')
}

async function answerDone(ctx: StudioContext, record: RecordingRecord): Promise<RecordingAnswer> {
  if (!record.projectId) return { recording: view(record, 1, 'Ready') }
  try {
    const { project, projectDigest } = await openVideo(ctx, record.projectId)
    return { recording: view(record, 1, 'Ready'), project, projectDigest }
  } catch {
    return { recording: view(record, 1, 'Ready') }
  }
}

/** Switch a storyboard beat back to an earlier take of it (the take is rebuilt from its recording's media). */
export async function switchBeatTake(ctx: StudioContext, videoId: string, beatId: string, sessionId: unknown) {
  if (typeof sessionId !== 'string' || !isUuid(sessionId)) throw new StudioError('Unknown take')
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(beatId)) throw notFoundError('No such beat')
  const record = await loadRecord(ctx, sessionId).catch(() => null)
  if (!record?.media) throw new StudioError("That take's recording is not in the Studio's library.")
  const stored = record.media
  const ids = [stored.screenAssetId, stored.camera?.assetId, stored.microphone?.assetId, stored.systemAudio?.assetId].filter((value): value is string => !!value)
  const assets = await getAssets(ctx, ids)
  const screen = assets.get(stored.screenAssetId)
  if (!screen) throw new StudioError("That take's screen recording is no longer in the media library")
  const synced = (entry?: { assetId: string; offsetSeconds: number }): SyncedAsset | null => {
    const asset = entry ? assets.get(entry.assetId) : undefined
    return asset && entry ? { asset, offsetSeconds: entry.offsetSeconds } : null
  }
  const media: TakeMedia = { screen, camera: synced(stored.camera), microphone: synced(stored.microphone), systemAudio: synced(stored.systemAudio) }
  const take = buildTakeProject({ id: record.id, title: record.input.title ?? takeTitle(new Date(record.createdAt)), media })
  return placeIntoVideo(ctx, videoId, take, { kind: 'use-take', beatId }, { sessionId, at: record.createdAt, screenAssetId: screen.id })
}
