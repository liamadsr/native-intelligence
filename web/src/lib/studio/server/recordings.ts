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
import { TraceSchema, type EditorAsset, type EditorProject, type EditorTranscript } from '../engine/contracts'
import { getAssets, importTimedTranscript } from './assets'
import { commitBlob, ownPendingUpload } from './blobs'
import { isUuid, must, type StudioContext } from './context'
import { conflictError, notFoundError, StudioError } from './errors'
import type { ImportInput } from './job-contract'
import { claimLiveTake, isLiveKey, retireLiveTake, stopLiveJobs, loadTake, parseLiveKey, reopenLiveTake, sealLiveTrack, sealStoppedTake, TRACK_MAX_PIECES, unclaimLiveTake, type SealedTrack, type TakeRecord } from './live-takes'
import { getRecord, putRecord } from './records'
import { createVideo, getVideoRow, openVideo, saveVideo } from './videos'
import { attachTakeTrack, buildTakeProject as buildTake, firstCut, parseSyncLabel, placeTake, resyncAudio, syncedAudioSegments, syncedPresenter, syncLabel, takeTitle, traceFocus, voiceAsset, wordsOnVoiceClock, type Placement, type SyncedAsset, type TakeMedia } from '../engine/take-project'
/** The engine's builder, its refusal (a screen that is not a video) answered as the Studio's own 400, as it was before it moved. */
function buildTakeProject(input: Parameters<typeof buildTake>[0]): ReturnType<typeof buildTake> {
  try {
    return buildTake(input)
  } catch (error) {
    throw new StudioError(error instanceof Error ? error.message : 'The take could not be built.')
  }
}
// The edit a take becomes is built by the engine's pure take-project.ts (the Mac app's page builds the same at Stop).
export { buildTakeProject, firstCut, parseSyncLabel, placeTake, resyncAudio, syncedAudioSegments, syncedPresenter, syncLabel, takeTitle, traceFocus, voiceAsset, wordsOnVoiceClock, type Placement, type SyncedAsset, type TakeMedia }


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
/** The recorder's own hash of the file as it wrote it (the Mac app): the import refuses bytes that do not match it. */
const fileSha256 = z.string().regex(/^[a-f0-9]{64}$/).optional()
const MainFileSchema = z.object({ uploadKey, name: fileName, pieces, partial, frameRate, sha256: fileSha256 }).strict()
const SyncedFileSchema = z.object({ uploadKey, name: fileName, offsetSeconds: offset, pieces, partial, frameRate, sha256: fileSha256 }).strict()
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
  /**
   * A new video's id, chosen by the recorder: the Mac app opens the take in the editor at Stop, under this id, before
   * the Studio has filed it (web/src/components/studio/record/provisional.ts). Only for a new video, never one that
   * exists already. The edit the Studio builds is its own, from the media it measured; the recorder's draft replaces
   * it only through an ordinary save over it.
   */
  projectId: projectId.optional(),
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
  .refine((r) => !(r.projectId && (r.punch || r.beats)), 'A video id is only chosen for a new video')
export type RecordingInput = z.infer<typeof RecordingInputSchema>

type Role = 'screen' | 'camera' | 'microphone' | 'systemAudio'
const ROLES: Role[] = ['screen', 'camera', 'microphone', 'systemAudio']


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
  /**
   * Moved on by one by each write that goes through moveRecording (attachTrack, settleAttached, addRecordingWords) or
   * queues a live job's fallback, so two such writers never cross. A build's claim, its end (endClaim) and a failed build's
   * write do not move it: each writer here also checks the status it read, which those writes change.
   */
  rev?: number
  /** Tracks whose job is the take's live job, and the ordinary import each would get if that job fails. */
  live?: { roles: Role[]; fallbacks: Partial<Record<Role, ImportInput>> }
  /** Once built: where it went and what it is made of. */
  projectId?: string
  placed?: 'new' | 'punch' | 'beats'
  media?: { screenAssetId: string; camera?: { assetId: string; offsetSeconds: number }; microphone?: { assetId: string; offsetSeconds: number }; systemAudio?: { assetId: string; offsetSeconds: number }; transcriptId?: string }
  voiceAssetId?: string
  note?: string
  error?: string
  /**
   * Tracks of the take that are not in the video: their import failed, or the bytes that reached the Studio were not the
   * recording's (`BYTES_DIFFER`). Why, in plain words. A recorder that kept its copy sends them again (attachTrack).
   */
  lost?: { role: Exclude<Role, 'screen'>; reason: string }[]
  /** What the Studio received for each track it imported: the hash and size of the bytes it read. A recorder lets its own copy go only when they are its file's. */
  received?: Partial<Record<Role, { sha256: string; bytes: number }>>
  /** Tracks sent again after the video was made: their import jobs, and the hash the recorder claimed for each (only ever a refusal). */
  attaching?: Partial<Record<Exclude<Role, 'screen'>, { jobId: string; sha256?: string }>>
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
  lost?: RecordingRecord['lost']
  received?: RecordingRecord['received']
  /** Tracks sent again after the video was made and still being imported. */
  attaching?: Exclude<Role, 'screen'>[]
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
  ...(record.lost?.length ? { lost: record.lost } : {}),
  ...(record.received ? { received: record.received } : {}),
  ...(record.attaching && Object.keys(record.attaching).length ? { attaching: Object.keys(record.attaching) as Exclude<Role, 'screen'>[] } : {}),
})

/** Why a track is not in the video when the bytes that reached the Studio were not the recording's. */
export const BYTES_DIFFER = 'the copy that reached the Studio is not the one on your computer (its bytes differ)'
/** What the Studio read for an imported asset: the upload's hash and size (the asset's own when it kept it byte for byte). */
function receivedOf(asset: EditorAsset): { sha256: string; bytes: number } {
  const p = (asset.provenance ?? {}) as { rawSha256?: unknown; rawBytes?: unknown }
  return { sha256: typeof p.rawSha256 === 'string' ? p.rawSha256 : asset.sha256, bytes: typeof p.rawBytes === 'number' ? p.rawBytes : asset.bytes }
}
const roleWord = (role: Role) => (role === 'systemAudio' ? 'system sound' : role)
/** The note a recording carries for its lost tracks, in plain words. */
function lostNote(lost: NonNullable<RecordingRecord['lost']>): string | undefined {
  if (!lost.length) return undefined
  return lost.map((l) => `The ${roleWord(l.role)} could not be added to this take: ${l.reason.replace(/\.$/, '')}.`).join(' ').slice(0, 600)
}

async function loadRecord(ctx: StudioContext, id: string): Promise<RecordingRecord> {
  if (!isUuid(id)) throw notFoundError('Recording not found')
  const record = await getRecord<RecordingRecord>(ctx, COLLECTION, id)
  if (!record) throw notFoundError('Recording not found')
  return record
}

/**
 * How long a build may hold its claim before another caller may take it over. A build is a handful of database writes
 * (a transcript registered, a video saved or placed with a version kept), seconds in practice; this is far past the
 * longest one could take, and past every request's own time limit (300 s), so a build still running is never built a
 * second time beside it. A claim held this long was lost (its process stopped) and is taken over.
 */
export const BUILD_CLAIM_MS = 10 * 60_000

/**
 * Take the right to build: the record moves from importing to building only if nobody else holds it (or the one who
 * did has held it BUILD_CLAIM_MS). Answers the claimed record, or null.
 */
async function claim(ctx: StudioContext, record: RecordingRecord): Promise<RecordingRecord | null> {
  const stale = record.status === 'building' && (!record.claimedAt || Date.now() - Date.parse(record.claimedAt) > BUILD_CLAIM_MS)
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
  // A video id the recorder chose must not name a video that exists (it would stand for the take without holding it).
  if (input.projectId && (await getVideoRow(ctx, input.projectId))) throw conflictError('That video exists already. Record again.', 'PROJECT_TAKEN')
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
    return await queueRecording(ctx, input, sealed, id, takeId, options, queueJob, waitMs, take)
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
  options: { recovered?: boolean }, queueJob: Jobs['queueJob'], waitMs: number, take: TakeRecord | null = null,
): Promise<RecordingAnswer> {
  const jobs: Partial<Record<Role, string>> = {}
  // The tracks prepared while they recorded: their live job is the track's import, and the import it would otherwise
  // have is kept, to be queued if that job fails (the live path is only ever a head start).
  const live: NonNullable<RecordingRecord['live']> = { roles: [], fallbacks: {} }
  // Which live jobs become their track's import, decided first; the others stop BEFORE any import is queued, so a
  // workspace near its job cap is not refused for jobs about to go.
  // What each track's import is asked to make. The screen at 60 fps when its frames came that fast while it moved,
  // else 30 (no frame is made up to fill 60); never above the rate the recorder asked for.
  const ceiling = input.screen.frameRate ?? sealed.screen?.frameRate
  const asked: Record<Role, Partial<ImportInput>> = {
    screen: { conform: { fps: 60, fit: true, ...(ceiling ? { ceiling } : {}) }, sourceCursorHidden: input.sourceCursorHidden, ...(input.trace ? { trace: input.trace } : {}) },
    camera: { conform: { fps: 30 }, sourceCursorHidden: false },
    microphone: { sourceCursorHidden: false },
    systemAudio: { sourceCursorHidden: false },
  }
  const reusable: Partial<Record<Role, string>> = {}
  if (take?.liveJobs && !input.trace) {
    for (const role of ['screen', 'camera'] as const) {
      const liveJob = take.liveJobs[role]
      if (liveJob && input[role] && (await reusableLiveJob(ctx, liveJob, asked[role]))) reusable[role] = liveJob
    }
  }
  if (take?.liveJobs) for (const jobId of Object.values(take.liveJobs)) if (jobId && !Object.values(reusable).includes(jobId)) await stopLiveJobs(ctx, { liveJobs: { screen: jobId } })
  const queue = async (role: Role, extra: Partial<ImportInput>) => {
    const file = input[role]
    if (!file) return
    const sealedTrack = sealed[role]
    const hint = sealedTrack?.seconds || input.durationSeconds
    const importInput: ImportInput = {
      uploadKey: file.uploadKey,
      name: file.name,
      provenance: { recording: id, role, recorder: input.recorder, ...(sealedTrack ? { live: true } : {}) },
      ...(sealedTrack && !sealedTrack.complete ? { partial: true } : {}),
      ...(hint ? { durationHint: Math.round(hint) } : {}),
      ...(file.sha256 ? { expectSha256: file.sha256 } : {}),
      ...extra,
    }
    const liveJob = reusable[role]
    if (liveJob) {
      await joinLiveJob(ctx, liveJob, { recording: id, role, recorder: input.recorder, live: true })
      jobs[role] = liveJob
      live.roles.push(role)
      live.fallbacks[role] = importInput
      return
    }
    const row = await queueJob(ctx, 'import', importInput)
    jobs[role] = row.id
  }
  for (const role of ROLES) await queue(role, asked[role])
  const record: RecordingRecord = {
    id, createdAt: new Date().toISOString(), ownerId: ctx.userId, ...(takeId ? { takeId } : {}), ...(options.recovered ? { recovered: true } : {}),
    status: 'importing', claim: null, claimedAt: null, input, jobs, rev: 0, ...(live.roles.length ? { live } : {}),
  }
  await putRecord(ctx, COLLECTION, id, record)
  return advanceRecording(ctx, id, waitMs)
}

/**
 * Bring back a take whose recording stopped before it was finished (the window closed, the app or the machine
 * crashed): every track is sealed from the pieces that arrived and the take becomes a new video, as a finished take
 * does. The camera and the sound keep the place on the screen's clock they said when they started.
 */
export async function recoverTake(ctx: StudioContext, takeId: string, waitMs = 0, now = Date.now(), projectId?: string, sha256: Partial<Record<Role, string>> = {}): Promise<RecordingAnswer> {
  const { take, tracks } = await sealStoppedTake(ctx, takeId, now)
  const at = new Date(take.createdAt)
  const file = (role: Role) => tracks.find((track) => track.role === role)
  // A track the Studio stopped taking pieces of, sent whole afterwards and bound to this take (live-takes.ts
  // bindWholeUpload): that upload replaces the pieces it holds. The recorder's hash of a file, when it sends one, only
  // ever refuses (a track whose bytes differ does not go into the video).
  const keyOf = (role: Role, track: SealedTrack) => take.whole?.[role] ?? track.key
  const hash = (role: Role) => (sha256[role] && /^[a-f0-9]{64}$/.test(sha256[role]!) ? { sha256: sha256[role]! } : {})
  const synced = (role: Exclude<Role, 'screen'>) => {
    const track = file(role)
    return track ? { [role]: { uploadKey: keyOf(role, track), name: track.name, offsetSeconds: Math.max(-3600, Math.min(3600, track.offsetSeconds ?? 0)), ...hash(role) } } : {}
  }
  const screen = file('screen')!
  return startRecording(ctx, {
    title: `${takeTitle(at)} (recovered)`,
    recorder: take.recorder,
    screen: { uploadKey: keyOf('screen', screen), name: screen.name, ...(screen.frameRate ? { frameRate: screen.frameRate } : {}), ...hash('screen') },
    ...synced('camera'),
    ...synced('microphone'),
    ...synced('systemAudio'),
    ...(screen.seconds ? { durationSeconds: screen.seconds } : {}),
    ...(projectId ? { projectId } : {}),
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
    // A made recording whose lost track was sent again is still waiting for that import.
    const attaching = record?.status === 'done' && !!record.attaching && Object.keys(record.attaching).length > 0
    if (!record || (!attaching && (record.status === 'done' || record.status === 'failed'))) return
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
  if (record.status === 'done') return answerDone(ctx, record.attaching && Object.keys(record.attaching).length ? await settleAttached(ctx, record) : record)
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
  // A live job that failed (or was handed out again with no live worker left to take it): its track falls back to
  // the ordinary import it would have had.
  for (const role of record.live?.roles ?? []) {
    const row = rows.get(role)
    if (!row) continue
    // Queued again after Stop (its worker went quiet): it gains nothing from being live any more.
    if (row.status === 'failed' || row.status === 'cancelled' || row.status === 'queued') {
      try {
        record = await fallBack(ctx, record, role, row.status === 'queued' ? row.id : null)
        rows.set(role, await jobRow(ctx, record.jobs[role]!))
      } catch (error) {
        // Refused at the workspace's job cap, say: asked again on the next look (the sweep looks every hour), for
        // FALLBACK_GIVE_UP_MS after the recording started. Then the track ends as its live job did (failed), so the
        // recording is settled without it (a screen that never came fails it) instead of waiting for ever.
        console.error('[studio] a recording’s track could not fall back to its import yet:', error instanceof Error ? error.message : error)
        if (Date.now() - Date.parse(record.createdAt) > FALLBACK_GIVE_UP_MS) {
          record = await fallBack(ctx, record, role, null, { giveUp: true })
          rows.set(role, await jobRow(ctx, record.jobs[role]!))
        }
      }
    }
  }
  // A track whose live job ended without it and whose ordinary import could not be queued yet is still to come.
  const stillLive = new Set(record.live?.roles ?? [])
  const finished = (status: string) => status === 'completed' || status === 'failed' || status === 'cancelled'
  for (const role of stillLive) {
    const row = rows.get(role)
    if (row && row.status !== 'completed' && finished(row.status)) rows.set(role, { ...row, status: 'running' })
  }
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
    // The recorder's own hash of each file (the Mac app) only ever refuses: an import whose bytes hash otherwise (a live
    // job's too, which the import's own check never sees) does not go into the video.
    const refused = new Set<Role>()
    const assetOf = (role: Role) => {
      const row = rows.get(role)
      const asset = row?.status === 'completed' ? ((row.result as { asset?: EditorAsset } | null)?.asset ?? null) : null
      const claimedSha = claimed.input[role]?.sha256
      if (asset && claimedSha && receivedOf(asset).sha256 !== claimedSha) {
        refused.add(role)
        return null
      }
      return asset
    }
    const screen = assetOf('screen')
    if (!screen) throw new StudioError(refused.has('screen') ? `The screen recording could not be imported: ${BYTES_DIFFER}. It is kept on your computer: send it again.` : 'The screen recording could not be imported.')
    const synced = (role: Exclude<Role, 'screen'>): SyncedAsset | null => {
      const asset = assetOf(role)
      return asset ? { asset, offsetSeconds: claimed.input[role]!.offsetSeconds } : null
    }
    const media: TakeMedia = { screen, camera: synced('camera'), microphone: synced('microphone'), systemAudio: synced('systemAudio') }
    const lost = (['camera', 'microphone', 'systemAudio'] as const).filter((role) => claimed.jobs[role] && !media[role])
      .map((role) => ({ role, reason: refused.has(role) ? BYTES_DIFFER : String(rows.get(role)?.error || 'its import did not finish').slice(0, 300) }))
    const note = lostNote(lost)
    const received: NonNullable<RecordingRecord['received']> = {}
    for (const role of ROLES) {
      const asset = role === 'screen' ? screen : media[role]?.asset
      if (asset) received[role] = receivedOf(asset)
    }
    // Built as the person who recorded it: only while they are still a member of the workspace, not a guest.
    if (claimed.ownerId && !(await activeMember(ctx, claimed.ownerId))) throw new StudioError(NOT_A_MEMBER)
    const built = await buildRecording(ctx, claimed, media)
    const done: RecordingRecord = { ...claimed, ...built, status: 'done', claim: null, claimedAt: null, received, ...(lost.length ? { lost } : {}), ...(note ? { note } : {}) }
    if (!(await endClaim(ctx, claimed, done))) return answerDone(ctx, await loadRecord(ctx, id))
    await settleTake(ctx, done)
    return answerDone(ctx, done)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The recording could not be put together.'
    const failed: RecordingRecord = { ...claimed, status: 'failed', claim: null, claimedAt: null, error: message.slice(0, 1000) }
    if (!(await endClaim(ctx, claimed, failed))) return { recording: view(await loadRecord(ctx, id), 1, 'Failed') }
    await settleTake(ctx, failed)
    return { recording: view(failed, 1, 'Failed') }
  }
}

/**
 * Whether a take's live job can be its track's import: done or running, nobody asked it to stop, and asked to make
 * exactly what the import would (the same conform: the screen's rate ceiling is the one known at Stop, which can differ
 * from the one the take started with; the same cursor flag). How far along it is is not weighed here: the worker
 * judges that at the seal, where its threads and speed are known, and hands over to the import when finishing the
 * live job would take longer (studio-worker/src/jobs/live-import.ts handOver).
 */
async function reusableLiveJob(ctx: StudioContext, jobId: string, wanted: Partial<ImportInput>): Promise<boolean> {
  const { jobRow } = await jobsModule()
  const row = await jobRow(ctx, jobId).catch(() => null)
  if (!row || row.cancel_requested || (row.status !== 'completed' && row.status !== 'running')) return false
  const read = must(await ctx.supabase.from('studio_job').select('input').eq('workspace_id', ctx.workspaceId).eq('id', jobId).maybeSingle(), 'read that job') as { input?: Partial<ImportInput> } | null
  const had = read?.input ?? {}
  const same = (a: ImportInput['conform'], b: ImportInput['conform']) => a?.fps === b?.fps && !!a?.fit === !!b?.fit && a?.ceiling === b?.ceiling
  return same(had.conform, wanted.conform) && !!had.sourceCursorHidden === !!wanted.sourceCursorHidden
}

/** Name the recording on a live job's input, so its end is followed up as the recording's (jobs.ts settleRecording). */
async function joinLiveJob(ctx: StudioContext, jobId: string, provenance: Record<string, unknown>): Promise<void> {
  const row = must(await ctx.supabase.from('studio_job').select('input').eq('workspace_id', ctx.workspaceId).eq('id', jobId).maybeSingle(), 'save the recording') as { input: Record<string, unknown> } | null
  if (!row) return
  const input = { ...row.input, provenance: { ...((row.input.provenance as Record<string, unknown> | undefined) ?? {}), ...provenance } }
  must(await ctx.supabase.from('studio_job').update({ input }).eq('workspace_id', ctx.workspaceId).eq('id', jobId), 'save the recording')
}

/**
 * Queue a track's ordinary import in place of its failed live job, once: the record moves on only from the revision it
 * was read at (a second caller at once cancels the import it queued and reads the first one's).
 */
/** How long after a recording starts a track whose live job ended keeps asking for its ordinary import. */
export const FALLBACK_GIVE_UP_MS = 24 * 3_600_000

/** A live track's ordinary import in place of its live job (cancelled first), or with `giveUp`, none: it ends as the live job did. */
async function fallBack(ctx: StudioContext, record: RecordingRecord, role: Role, stop: string | null, options: { giveUp?: boolean } = {}): Promise<RecordingRecord> {
  const { queueJob, cancelJob } = await jobsModule()
  if (stop) await cancelJob(ctx, stop).catch(() => undefined)
  const input = record.live?.fallbacks[role]
  if (!input) return record
  const row = options.giveUp ? null : await queueJob(ctx, 'import', input)
  const next: RecordingRecord = {
    ...record,
    jobs: row ? { ...record.jobs, [role]: row.id } : record.jobs,
    live: { roles: record.live!.roles.filter((r) => r !== role), fallbacks: record.live!.fallbacks },
    rev: (record.rev ?? 0) + 1,
  }
  let query = ctx.supabase.from('studio_record').update({ value: next, updated_at: new Date().toISOString() })
    .eq('workspace_id', ctx.workspaceId).eq('collection', COLLECTION).eq('key', record.id)
  query = record.rev === undefined ? query.is('value->>rev', null) : query.eq('value->>rev', String(record.rev))
  const moved = must(await query.select('key'), 'save the recording') as { key: string }[] | null
  if (moved?.length) return next
  if (row) await cancelJob(ctx, row.id).catch(() => undefined)
  return loadRecord(ctx, record.id)
}

/**
 * Write `next` over a recording only while its `rev` is still `before`'s (every write through here moves it on): two
 * such writers never lose each other's change. False when it changed meanwhile. The writes that do not move `rev` (a
 * build's claim, endClaim, a failed build) change the status, so a caller must also check the status it read.
 */
async function moveRecording(ctx: StudioContext, before: RecordingRecord, next: RecordingRecord): Promise<boolean> {
  const value: RecordingRecord = { ...next, rev: (before.rev ?? 0) + 1 }
  let query = ctx.supabase.from('studio_record').update({ value, updated_at: new Date().toISOString() })
    .eq('workspace_id', ctx.workspaceId).eq('collection', COLLECTION).eq('key', before.id)
  query = before.rev === undefined ? query.is('value->>rev', null) : query.eq('value->>rev', String(before.rev))
  const moved = must(await query.select('key'), 'save the recording') as { key: string }[] | null
  return !!moved?.length
}

/** What a recording by someone no longer in the workspace answers. */
export const NOT_A_MEMBER = 'The person who recorded this is no longer a member of this workspace, so it was not made into a video.'

/** Whether someone is a member of the workspace who is not a guest. */
async function activeMember(ctx: StudioContext, userId: string): Promise<boolean> {
  const row = must(await ctx.supabase.from('member').select('role').eq('workspace_id', ctx.workspaceId).eq('user_id', userId).maybeSingle(), 'check who recorded it') as { role?: string | null } | null
  return !!row && row.role !== 'guest'
}

/** Write a build's end only while it still holds its claim (one taken over after BUILD_CLAIM_MS does not). */
async function endClaim(ctx: StudioContext, claimed: RecordingRecord, next: RecordingRecord): Promise<boolean> {
  const moved = must(
    await ctx.supabase.from('studio_record').update({ value: next, updated_at: new Date().toISOString() })
      .eq('workspace_id', ctx.workspaceId).eq('collection', COLLECTION).eq('key', claimed.id).eq('value->>claim', claimed.claim!)
      .select('key'),
    'save the recording',
  ) as { key: string }[] | null
  return !!moved?.length
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
    // The sweep's week-old pass settles the take on its own (live-takes.ts recordingSettled), whatever failed here.
    console.error('[studio] settling a recording’s take failed (the sweep settles it later):', error instanceof Error ? error.message : error)
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
  const project = buildTakeProject({ id: input.projectId ?? record.id, title: input.title ?? takeTitle(at), media, transcript })
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

/**
 * A made recording's tracks sent again (attachTrack), once their imports ended: each that came in (and whose bytes are
 * the ones the recorder claimed) is placed into the video and leaves `lost`; one that did not stays lost, with why.
 * Placing is idempotent (a video that has the asset is left as it is), so two looks at once do no harm.
 */
async function settleAttached(ctx: StudioContext, record: RecordingRecord): Promise<RecordingRecord> {
  const { jobRow } = await jobsModule()
  let next = record
  for (const [role, sent] of Object.entries(record.attaching ?? {}) as [Exclude<Role, 'screen'>, { jobId: string; sha256?: string }][]) {
    const row = await jobRow(ctx, sent.jobId).catch(() => null)
    if (!row || !['completed', 'failed', 'cancelled'].includes(row.status)) continue
    const asset = row.status === 'completed' ? ((row.result as { asset?: EditorAsset } | null)?.asset ?? null) : null
    const same = !!asset && (!sent.sha256 || receivedOf(asset).sha256 === sent.sha256)
    const offsetSeconds = next.input[role]?.offsetSeconds ?? 0
    const placed = same && !!next.projectId && !!next.media && (await placeAttached(ctx, next.projectId, next.media.screenAssetId, role, asset!, offsetSeconds))
    const { [role]: _done, ...attaching } = next.attaching ?? {}
    void _done
    const lost = (next.lost ?? []).filter((l) => l.role !== role)
    if (!placed) lost.push({ role, reason: asset && !same ? BYTES_DIFFER : asset ? 'it could not be placed into the video' : String(row.error || 'its import did not finish').slice(0, 300) })
    const media = placed ? { ...next.media!, [role]: { assetId: asset!.id, offsetSeconds } } : next.media
    const note = lostNote(lost)
    const { note: _note, lost: _lost, ...rest } = next
    void _note
    void _lost
    next = {
      ...rest, attaching, ...(media ? { media } : {}), ...(lost.length ? { lost } : {}), ...(note ? { note } : {}),
      ...(placed ? { received: { ...next.received, [role]: receivedOf(asset!) }, ...(role === 'microphone' && asset!.hasAudio ? { voiceAssetId: asset!.id } : {}) } : {}),
    }
  }
  // Written only over the record as it was read: another writer meanwhile wins, and its record is answered.
  if (next !== record && !(await moveRecording(ctx, record, next))) return loadRecord(ctx, record.id)
  return next
}

/** Put a track sent again into the video, under the digest guard. False when the video no longer shows the take. */
async function placeAttached(ctx: StudioContext, videoId: string, screenAssetId: string, role: Exclude<Role, 'screen'>, asset: EditorAsset, offsetSeconds: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const opened = await openVideo(ctx, videoId).catch(() => null)
    if (!opened) return false
    const next = attachTakeTrack(opened.project, screenAssetId, role, asset, offsetSeconds)
    if (!next) return false
    if (next === opened.project) return true
    try {
      await saveVideo(ctx, next, opened.projectDigest)
      return true
    } catch (error) {
      if (error instanceof StudioError && error.code === 'DIGEST_CONFLICT') continue
      throw error
    }
  }
  return false
}

const AttachSchema = z.object({
  role: z.enum(['camera', 'microphone', 'systemAudio']),
  uploadKey: z.string().regex(/^uploads\/[0-9a-f-]{36}$/, 'Upload the file first'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()

/**
 * Send a lost track of a made recording again (POST /recordings/:id/tracks): the person's own recording, made, the
 * track one it lost, the file a fresh upload of theirs (committed: every part there). Its import is queued (with the
 * recorder's hash, which only ever refuses) and the track goes into the video once it is in (settleAttached).
 */
export async function attachTrack(ctx: StudioContext, id: string, body: unknown): Promise<RecordingAnswer> {
  if (!ctx.userId) throw new StudioError('Only the person recording can send a recording.', 403, 'FORBIDDEN')
  const input = AttachSchema.parse(body)
  const record = await loadRecord(ctx, id)
  if (record.ownerId && record.ownerId !== ctx.userId) throw notFoundError('Recording not found')
  if (record.status !== 'done') throw conflictError('The recording is not made yet. Try again in a moment.', 'NOT_DONE')
  if (record.attaching?.[input.role]) return advanceRecording(ctx, id, 0)
  if (!record.lost?.some((l) => l.role === input.role)) throw conflictError(`The ${roleWord(input.role)} is in the video already.`, 'NOT_LOST')
  // Only the person's own upload, not used yet (never another person's file in the workspace).
  if (!(await ownPendingUpload(ctx, input.uploadKey))) throw new StudioError('Upload the file first.')
  await commitBlob(ctx, input.uploadKey)
  const { queueJob, cancelJob } = await jobsModule()
  const name = record.input[input.role]?.name ?? `${roleWord(input.role)}.${input.role === 'camera' ? 'mp4' : 'm4a'}`
  const row = await queueJob(ctx, 'import', {
    uploadKey: input.uploadKey, name, sourceCursorHidden: false,
    provenance: { recording: id, role: input.role, recorder: record.input.recorder, attached: true },
    ...(input.role === 'camera' ? { conform: { fps: 30 } } : {}),
    ...(input.sha256 ? { expectSha256: input.sha256 } : {}),
  })
  if (!(await moveRecording(ctx, record, { ...record, attaching: { ...record.attaching, [input.role]: { jobId: row.id, ...(input.sha256 ? { sha256: input.sha256 } : {}) } } }))) {
    await cancelJob(ctx, row.id).catch(() => undefined)
    throw conflictError('The recording changed meanwhile. Try again in a moment.', 'BUSY')
  }
  return advanceRecording(ctx, id, 0)
}

const LateWordsSchema = z.object({ words: z.array(WordSchema).min(1).max(40_000) }).strict()

/**
 * The words the Mac heard, arriving after the take was handed over (the editor opens at Stop, before them): set once
 * on the recording. Not made yet: they go with it (its build registers them on the voice, as at Stop). Made: they are
 * registered on the Studio's own voice asset and put into the video when it has no transcript of that voice yet.
 */
export async function addRecordingWords(ctx: StudioContext, id: string, body: unknown): Promise<RecordingAnswer> {
  if (!ctx.userId) throw new StudioError('Only the person recording can send a recording.', 403, 'FORBIDDEN')
  const { words } = LateWordsSchema.parse(body)
  const record = await loadRecord(ctx, id)
  if (record.ownerId && record.ownerId !== ctx.userId) throw notFoundError('Recording not found')
  if (record.input.transcript) return advanceRecording(ctx, id, 0)
  const input = { ...record.input, transcript: { words } }
  if (record.status === 'importing') {
    // Only over the record as it was read, unclaimed: a build that took it meanwhile reads the words on the next try.
    const moved = must(
      await (record.rev === undefined ? ctx.supabase.from('studio_record').update({ value: { ...record, input, rev: 1 }, updated_at: new Date().toISOString() }).is('value->>rev', null) : ctx.supabase.from('studio_record').update({ value: { ...record, input, rev: record.rev + 1 }, updated_at: new Date().toISOString() }).eq('value->>rev', String(record.rev)))
        .eq('workspace_id', ctx.workspaceId).eq('collection', COLLECTION).eq('key', id).eq('value->>status', 'importing').is('value->>claim', null).select('key'),
      'save the recording',
    ) as { key: string }[] | null
    if (moved?.length) return advanceRecording(ctx, id, 0)
    throw conflictError('The recording is being put together. Try again in a moment.', 'BUSY')
  }
  if (record.status !== 'done') throw conflictError('The recording is being put together. Try again in a moment.', 'BUSY')
  const media = record.media
  let transcriptId = media?.transcriptId
  if (media && !transcriptId && record.voiceAssetId) {
    const voiceAsset = (await getAssets(ctx, [record.voiceAssetId])).get(record.voiceAssetId)
    const offsetSeconds = record.voiceAssetId === media.microphone?.assetId ? media.microphone.offsetSeconds : record.voiceAssetId === media.systemAudio?.assetId ? media.systemAudio.offsetSeconds : 0
    const onVoice = voiceAsset ? wordsOnVoiceClock(words, { asset: voiceAsset, offsetSeconds }) : []
    if (voiceAsset && onVoice.length) {
      const transcript = await importTimedTranscript(ctx, voiceAsset.id, { words: onVoice, text: onVoice.map((w) => w.text).join(' ') })
      transcriptId = transcript.id
      if (record.projectId) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const opened = await openVideo(ctx, record.projectId).catch(() => null)
          if (!opened || opened.project.transcripts.some((t) => t.assetId === voiceAsset.id) || !opened.project.assets.some((a) => a.id === voiceAsset.id)) break
          try {
            await saveVideo(ctx, { ...opened.project, transcripts: [...opened.project.transcripts, transcript] }, opened.projectDigest)
            break
          } catch (error) {
            if (!(error instanceof StudioError && error.code === 'DIGEST_CONFLICT')) throw error
          }
        }
      }
    }
  }
  if (!(await moveRecording(ctx, record, { ...record, input, ...(media ? { media: { ...media, ...(transcriptId ? { transcriptId } : {}) } } : {}) }))) throw conflictError('The recording changed meanwhile. Try again in a moment.', 'BUSY')
  return advanceRecording(ctx, id, 0)
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
