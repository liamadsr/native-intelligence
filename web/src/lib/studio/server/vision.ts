// Vision in the Studio: the person cut out of a recording (so graphics can sit behind them), where their face is
// over time, and what that feeds: a narrower format's crops that keep the face in frame, and the director pass that
// cuts a multi-camera take. The seeing itself is the Studio worker's (job-contract.ts kinds `cutout` and `faces`):
// Swift helpers over Apple's Vision framework, so only a worker on a Mac can (capabilities `cutouts`, `faces`). The
// production container is Linux and has neither: there, cut-outs are refused with a sentence, crops stay centred,
// and the director picks cameras without knowing where the person faces.
//
//   startCutouts      queue a cut-out of a video's camera recordings (or the ones named)
//   fileCutout        a finished cut-out job: the transparent recordings registered and attached to the video, as one
//                     undoable step (a version "Before the cut-out" kept, re-applied on the fresh edit if it moved)
//   fileFaces         a finished faces job: each recording's track cached by its bytes (studio_record `faces`)
//   gatherFaces       the tracks of some recordings: cached ones at once, the rest from a faces job waited on briefly
//   directVideo       the director pass, a dry run (the plan) or for real (saved, a version kept first)
//   checklistFaces    the cached tracks the readiness checklist reads (never starts a job)
import { z } from 'zod'
import { EditorAssetSchema, type EditorAsset, type EditorProject } from '../engine/contracts'
import { applyDirector, timelineSentences, type DirectorOptions, type DirectorReport, type FaceSample, type FaceTracks } from '../engine/director'
import { registerAsset } from './assets'
import { requireCapability, workerCan } from './capabilities'
import { must, type StudioContext } from './context'
import { conflictError, StudioError } from './errors'
import type { CutoutInput, CutoutMade, CutoutMode, FacesInput } from './job-contract'
import { ownAsset, queueJob, toEditorJob, waitForJob, type JobRow } from './jobs'
import { getRecords, putRecord } from './records'
import { saveVersion } from './versions'
import { openVideo, saveVideo } from './videos'

/** The studio_record collection of face tracks, keyed by the recording's sha256. */
export const FACES_COLLECTION = 'faces'

/** How long a route waits on a faces job before answering without it. */
export const FACES_WAIT_MS = 90_000

/** What the director pass answers when there are no words to cut on. */
export const NEEDS_TRANSCRIPT = 'The director pass needs a transcript of the recording. Transcribe it first.'

/** What a route answers when the faces job is still running at the end of its wait. */
export const FACES_PENDING = 'Still finding faces in the recordings (about a minute for a long one). Ask again shortly.'

const videoAsset = (project: EditorProject, id: string) => {
  const asset = project.assets.find((a) => a.id === id)
  return asset && asset.kind === 'video' ? asset : null
}

const unique = (assets: (EditorAsset | null)[]) => [...new Map(assets.filter((a): a is EditorAsset => !!a).map((a) => [a.id, a])).values()]

/** An asset as a job's input carries it: without its pointer trace and waveform, which the worker never reads. Pure. */
export const leanAsset = (asset: EditorAsset): EditorAsset => Object.fromEntries(Object.entries(asset).filter(([key]) => key !== 'trace' && key !== 'waveform')) as EditorAsset

/** Every camera recording an edit shows: the main camera, extra cameras, and their punched-in takes. Pure. */
export function cameraAssets(project: EditorProject): EditorAsset[] {
  const ids: string[] = []
  const track = project.presenterTrack
  if (track) ids.push(track.assetId, ...(track.takes ?? []).map((t) => t.assetId))
  for (const source of project.sources ?? []) if (source.kind === 'camera') ids.push(source.assetId, ...(source.takes ?? []).map((t) => t.assetId))
  return unique(ids.map((id) => videoAsset(project, id)))
}

/** The recordings a cut-out takes when none are named: the main camera and the extra cameras with their takes. Pure. */
export function cutoutCandidates(project: EditorProject): EditorAsset[] {
  const ids: string[] = []
  if (project.presenterTrack) ids.push(project.presenterTrack.assetId)
  for (const source of project.sources ?? []) if (source.kind === 'camera') ids.push(source.assetId, ...(source.takes ?? []).map((t) => t.assetId))
  return unique(ids.map((id) => videoAsset(project, id)))
}

/**
 * The footage a narrower format centres on a face: the cameras, and any other video on the timeline that has no
 * pointer trace (a generated shot, an imported clip), never a blank canvas. Pure.
 */
export function focusFootage(project: EditorProject): EditorAsset[] {
  const clips = project.clips.map((clip) => videoAsset(project, clip.assetId)).filter((a) => a && !a.trace?.cursor?.length && !/^Blank canvas/.test(a.name))
  return unique([...cameraAssets(project), ...clips])
}

// ---- face tracks ---------------------------------------------------------------------------------------------

/** One recording's track as cached. */
export type FaceRecord = { assetId: string; sha256: string; every: number; samples: FaceSample[]; at: string }

const coordinate = z.number().finite().min(-1).max(2)
const FaceSchema = z.object({ x: coordinate, y: coordinate, w: coordinate, h: coordinate, confidence: z.number().finite().min(0).max(1), yaw: z.number().finite().optional(), pitch: z.number().finite().optional() })
const SampleSchema = z.object({ t: z.number().finite().min(0).max(7300), faces: z.array(FaceSchema).max(20) })
/** A faces job's result: at most 40,000 samples a recording (two hours at five a second). */
const FacesResultSchema = z.object({
  tracks: z.array(z.object({ assetId: z.string().min(1).max(100), sha256: z.string().regex(/^[a-f0-9]{64}$/), every: z.number().finite().min(0.01).max(10), samples: z.array(SampleSchema).max(40_000) })).max(50),
})

/** The cached tracks of these recordings (by their bytes, under each asset's id), and the ones not tracked yet. */
export async function cachedFaces(ctx: StudioContext, assets: EditorAsset[]): Promise<{ tracks: FaceTracks; missing: EditorAsset[] }> {
  const records = await getRecords<FaceRecord>(ctx, FACES_COLLECTION, assets.map((a) => a.sha256))
  const tracks: FaceTracks = {}
  const missing: EditorAsset[] = []
  for (const asset of assets) {
    const record = records.get(asset.sha256)
    if (record && Array.isArray(record.samples)) tracks[asset.id] = record.samples
    else missing.push(asset)
  }
  return { tracks, missing }
}

/** What gathering faces came to: every track found, none to be had here, the job still running, or the job failed. */
export type FacesState = 'measured' | 'unavailable' | 'pending' | 'failed'
export type GatheredFaces = { tracks: FaceTracks; state: FacesState; logs: string[]; jobId?: string }

/** The queued and running faces jobs of this workspace, each with the recordings (by sha256) it tracks. */
async function runningFacesJobs(ctx: StudioContext): Promise<{ id: string; shas: Set<string> }[]> {
  const rows = must(
    await ctx.supabase.from('studio_job').select('id, input').eq('workspace_id', ctx.workspaceId).eq('kind', 'faces').in('status', ['queued', 'running']).order('created_at', { ascending: false }).limit(20),
    'read jobs',
  ) as { id: string; input: FacesInput }[] | null
  return (rows ?? []).map((row) => ({ id: row.id, shas: new Set((row.input?.assets ?? []).map((a) => a.sha256)) }))
}

/**
 * The face tracks of these recordings: cached ones at once; the rest from faces jobs (the ones already running for
 * them, and a new one for any recording none is tracking) waited on up to `waitMs` in all. Without a worker that
 * finds faces, whatever is cached ('unavailable').
 */
export async function gatherFaces(ctx: StudioContext, videoId: string | null, assets: EditorAsset[], options: { waitMs?: number } = {}): Promise<GatheredFaces> {
  const footage = unique(assets.filter((a) => a.kind === 'video'))
  const first = await cachedFaces(ctx, footage)
  if (!first.missing.length) return { tracks: first.tracks, state: 'measured', logs: [] }
  if (!workerCan('faces')) {
    return { tracks: first.tracks, state: 'unavailable', logs: ['Faces are not found here: that needs the Studio worker running on a Mac (macOS Vision).'] }
  }
  const relevant = (await runningFacesJobs(ctx)).filter((job) => first.missing.some((a) => job.shas.has(a.sha256)))
  const uncovered = first.missing.filter((a) => !relevant.some((job) => job.shas.has(a.sha256)))
  const ids = relevant.map((job) => job.id)
  if (uncovered.length) ids.push((await queueJob(ctx, 'faces', { assets: uncovered.map(leanAsset) }, videoId)).id)
  const logs = first.missing.map((a) => `Finding the face in ${a.name}`)
  const until = Date.now() + (options.waitMs ?? FACES_WAIT_MS)
  const failures: string[] = []
  for (const id of ids) {
    const row = await waitForJob(ctx, id, { timeoutMs: Math.max(0, until - Date.now()) })
    if (row.status === 'failed' || row.status === 'cancelled') failures.push(row.error ?? row.status)
  }
  const now = await cachedFaces(ctx, footage)
  if (!now.missing.length) return { tracks: now.tracks, state: 'measured', logs, jobId: ids[0] }
  if (failures.length) return { tracks: now.tracks, state: 'failed', logs: [...logs, `Finding faces failed: ${failures.join('; ')}`], jobId: ids[0] }
  return { tracks: now.tracks, state: 'pending', logs, jobId: ids[0] }
}

/** The cached tracks of an edit's footage, for the readiness checklist, or undefined when none is cached. Never starts a job. */
export async function checklistFaces(ctx: StudioContext, project: EditorProject): Promise<FaceTracks | undefined> {
  const cameras = cameraAssets(project)
  if (!cameras.length) return undefined
  const { tracks } = await cachedFaces(ctx, cameras)
  return Object.keys(tracks).length ? tracks : undefined
}

/** A finished faces job: each recording's track cached by its bytes. Answers what to keep on the job (counts only). */
export async function fileFaces(ctx: StudioContext, row: Pick<JobRow, 'input'>, raw: unknown): Promise<Record<string, unknown>> {
  const result = FacesResultSchema.parse(raw)
  const input = row.input as FacesInput
  const at = new Date().toISOString()
  const kept: { assetId: string; samples: number; withFaces: number }[] = []
  for (const track of result.tracks) {
    if (!(input.assets ?? []).some((a) => a.id === track.assetId && a.sha256 === track.sha256)) throw new StudioError('The worker tracked a recording this job did not ask for.')
    const record: FaceRecord = { assetId: track.assetId, sha256: track.sha256, every: track.every, samples: track.samples, at }
    await putRecord(ctx, FACES_COLLECTION, track.sha256, record)
    kept.push({ assetId: track.assetId, samples: track.samples.length, withFaces: track.samples.filter((s) => s.faces.length).length })
  }
  return { tracks: kept }
}

// ---- cut-outs ------------------------------------------------------------------------------------------------

const CutoutBody = z.object({ assetIds: z.array(z.string().min(1).max(100)).max(16).optional(), mode: z.enum(['person', 'subject']).optional() })

/**
 * Queue a cut-out of a video's recordings (the ones named, else its cameras) that are not cut out in this mode yet.
 * Refused (503) when no worker on a Mac is running. Answers the job as the editor reads it.
 */
export async function startCutouts(ctx: StudioContext, videoId: string, body: unknown) {
  const request = CutoutBody.parse(body ?? {})
  const mode: CutoutMode = request.mode ?? 'person'
  requireCapability(ctx, 'cutouts')
  const { project } = await openVideo(ctx, videoId)
  const targets = request.assetIds?.length
    ? request.assetIds.map((id) => {
        const asset = videoAsset(project, id)
        if (!asset) throw new StudioError(`Asset ${id} is not a video in this project`)
        return asset
      })
    : cutoutCandidates(project)
  if (!targets.length) throw new StudioError('This video has no camera footage to cut out: name the recording to cut out.')
  const todo = unique(targets).filter((asset) => !project.cutouts?.some((cut) => cut.assetId === asset.id && cut.mode === mode))
  if (!todo.length) throw new StudioError(`Already cut out: every recording asked for has a ${mode} cut-out.`)
  const row = await queueJob(ctx, 'cutout', { assets: todo.map(leanAsset), mode }, project.id)
  return { job: toEditorJob(row) }
}

/** A cut-out the worker made, checked against what its job asked: one of its recordings, its mode, a transparent video frame for frame with it. Pure. */
export function checkCutout(input: CutoutInput, value: unknown): CutoutMade {
  const made = z.object({ assetId: z.string(), cutoutAssetId: z.string(), mode: z.enum(['person', 'subject']), asset: EditorAssetSchema }).parse(value)
  const source = (input.assets ?? []).find((a) => a.id === made.assetId)
  if (!source) throw new StudioError('The worker cut out a recording this job did not ask for.')
  if (made.mode !== input.mode) throw new StudioError('The cut-out was made in another mode than asked.')
  if (made.asset.id !== made.cutoutAssetId || made.asset.kind !== 'video') throw new StudioError('A cut-out is a video asset.')
  if (!/\.webm$/.test(made.asset.file)) throw new StudioError('A cut-out is a transparent WebM.')
  if (Math.abs((made.asset.sourceFrames ?? 0) - (source.sourceFrames ?? 0)) > 1) throw new StudioError(`The cut-out of ${source.name} does not match it frame for frame.`)
  return made
}

/**
 * The edit with these cut-outs attached: each cut-out asset added once, one cut-out per recording (a new one replaces
 * the old). A recording no longer in the edit is skipped. Only `cutouts` and `assets` change. Pure.
 */
export function applyCutouts(project: EditorProject, made: CutoutMade[]): { project: EditorProject; applied: CutoutMade[] } {
  const applied = made.filter((m) => project.assets.some((a) => a.id === m.assetId))
  if (!applied.length) return { project, applied }
  const assets = [...project.assets]
  for (const m of applied) if (!assets.some((a) => a.id === m.asset.id)) assets.push(m.asset)
  const cutouts = [
    ...(project.cutouts ?? []).filter((cut) => !applied.some((m) => m.assetId === cut.assetId)),
    ...applied.map((m) => ({ assetId: m.assetId, cutoutAssetId: m.cutoutAssetId, mode: m.mode })),
  ]
  return { project: { ...project, assets, cutouts }, applied }
}

/** Attach cut-outs to a video as one undoable step, against its latest edit (tried again when it moved meanwhile). */
export async function attachCutouts(ctx: StudioContext, videoId: string, made: CutoutMade[]): Promise<{ applied: number; projectDigest?: string }> {
  let versioned = false
  for (let attempt = 0; attempt < 4; attempt++) {
    let opened: Awaited<ReturnType<typeof openVideo>>
    try {
      opened = await openVideo(ctx, videoId)
    } catch (error) {
      // Trashed or gone while the worker cut: the cut-outs stay in the library.
      if (error instanceof StudioError && error.status === 404) return { applied: 0 }
      throw error
    }
    const { project, applied } = applyCutouts(opened.project, made)
    if (!applied.length) return { applied: 0 }
    if (!versioned) {
      await saveVersion(ctx, videoId, 'project', 'Before the cut-out', opened.project).catch(() => null)
      versioned = true
    }
    try {
      const saved = await saveVideo(ctx, project, opened.projectDigest)
      return { applied: applied.length, projectDigest: saved.projectDigest }
    } catch (error) {
      if (error instanceof StudioError && error.code === 'DIGEST_CONFLICT') continue
      throw error
    }
  }
  throw conflictError('The video kept changing while its cut-out was attached. The cut-out is in the library; ask for it again.')
}

/** A finished cut-out job: each cut-out checked and registered, then attached to the job's video. Answers what to keep on the job. */
export async function fileCutout(ctx: StudioContext, row: Pick<JobRow, 'input' | 'video_id'>, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!Array.isArray(raw.cutouts) || !raw.cutouts.length) throw new StudioError('A cut-out job makes at least one cut-out.')
  const input = row.input as CutoutInput
  const made: CutoutMade[] = []
  // Every cut-out checked against what the job stored before any is registered.
  const checked: CutoutMade[] = []
  for (const value of raw.cutouts) {
    const one = checkCutout(input, value)
    checked.push({ ...one, asset: await ownAsset(ctx, one.asset, 'cut-out') })
  }
  for (const one of checked) made.push({ ...one, asset: await registerAsset(ctx, one.asset) })
  const attached = row.video_id ? await attachCutouts(ctx, row.video_id, made) : { applied: 0 }
  return { cutouts: made.map(({ assetId, cutoutAssetId, mode }) => ({ assetId, cutoutAssetId, mode })), applied: attached.applied, ...(attached.projectDigest ? { projectDigest: attached.projectDigest } : {}) }
}

// ---- the director pass ---------------------------------------------------------------------------------------

const DirectorOptionsSchema = z
  .object({
    minShot: z.number().finite().min(0.5).max(30),
    maxShot: z.number().finite().min(1).max(120),
    minGap: z.number().finite().min(0).max(10),
    cutDeadAir: z.boolean(),
    deadAir: z.number().finite().min(0.2).max(10),
    falseStarts: z.boolean(),
    screen: z.boolean(),
  })
  .partial()
  .strict()

/** The director's options as given (each optional), checked. */
export const directorOptions = (value: unknown): DirectorOptions => DirectorOptionsSchema.parse(value ?? {})

/** The pass on an edit with these tracks: refused without words to cut on. Pure. */
export function directPlan(project: EditorProject, faces: FaceTracks, options: DirectorOptions): { project: EditorProject; report: DirectorReport } {
  if (!timelineSentences(project).length) throw new StudioError(NEEDS_TRANSCRIPT, 400, 'NO_TRANSCRIPT')
  return applyDirector(project, faces, options)
}

/**
 * The director pass on a video: false starts and dead air cut, then a picture chosen for each stretch with its
 * reason. Face tracks of its cameras come from the cache or a faces job. A dry run answers the plan and saves
 * nothing; a real run keeps the edit as a version "Before the director pass" and saves against the digest it read.
 */
export async function directVideo(ctx: StudioContext, videoId: string, body: { options?: unknown; dryRun?: unknown }, waitMs = FACES_WAIT_MS) {
  const options = directorOptions(body.options)
  const opened = await openVideo(ctx, videoId)
  if (!timelineSentences(opened.project).length) throw new StudioError(NEEDS_TRANSCRIPT, 400, 'NO_TRANSCRIPT')
  const cameras = cameraAssets(opened.project)
  const faces: GatheredFaces = cameras.length ? await gatherFaces(ctx, videoId, cameras, { waitMs }) : { tracks: {}, state: 'measured', logs: [] }
  if (faces.state === 'pending') throw new StudioError(FACES_PENDING, 503, 'FACES_PENDING')
  const { project: next, report } = directPlan(opened.project, faces.tracks, options)
  const logs = [...faces.logs, ...(faces.state === 'unavailable' ? ['Cameras were chosen without face tracks.'] : [])]
  if (body.dryRun === true) return { report, logs, faces: faces.state, dryRun: true }
  await saveVersion(ctx, videoId, 'project', 'Before the director pass', opened.project).catch(() => null)
  const saved = await saveVideo(ctx, next, opened.projectDigest)
  return { report, logs, faces: faces.state, project: saved.project, projectDigest: saved.projectDigest }
}
