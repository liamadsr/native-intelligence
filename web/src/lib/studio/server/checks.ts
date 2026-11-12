// The measured checks (check-contract.ts): the motion check, the whole-video review and the visual check ("look").
// The app freezes the video into a job and the Studio worker renders and measures it; nothing here edits the video.
//
//   startCheck      queue one: the edit, its digest, the fonts its text uses, the references named (library videos),
//                   and for the review what the edit knows that pixels can't (words said, layers, clicks)
//   fileCheck       a finished check is kept as the video's latest of its kind (studio_record, collection `checks`,
//                   key `<video id>:<kind>`), with the digest it measured, so the editor and the agent read it again
//                   without a re-run, and the readiness list uses a visual check only while it matches the video
//   serveCheckFile  a check's pictures (`checks/<job id>/<file>`), to members of the job's workspace only
//
// A review of a library video by itself (a reference, no video) is queued by blueprint.ts and handed back to it here.
//
// motion and review need a worker with the analysis (`motionCheck`, `review`: capabilities.ts); look any worker (refused at
// once when none is running).
import type { EditorProject } from '../engine/contracts'
import type { VisualReport } from '../engine/server-types'
import { clickCues } from '../engine/sound'
import { transcriptWords } from '../engine/transcript'
import type { EditorJob } from '../engine/api'
import { getAsset } from './assets'
import { getBlob } from './blobs'
import type { CheckReference, LookResult, ReviewContext } from './check-contract'
import { isUuid, type StudioContext } from './context'
import { requireCapability, requireWorker } from './capabilities'
import { notFoundError, StudioError } from './errors'
import { serveBlob } from './files'
import { exportFonts } from './fonts'
import { jobRow, queueJob, toEditorJob, type JobRow } from './jobs'
import { getRecord, putRecord } from './records'
import { openVideo } from './videos'

/** The check kinds. */
export const CHECK_KINDS = ['motion', 'review', 'look'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]

/** The studio_record collection the latest check of each kind is kept in. */
export const CHECKS_COLLECTION = 'checks'

/** At most this many reference videos a check measures against. */
export const MAX_REFERENCES = 3

/** The latest check of a kind, as kept. `result` is the job's result (check-contract.ts). */
export type CheckRecord = { kind: CheckKind; jobId: string; videoId: string; digest: string; checkedAt: string; result: Record<string, unknown> }

export const isCheckKind = (value: unknown): value is CheckKind => (CHECK_KINDS as readonly unknown[]).includes(value)

/** The record key of a video's latest check of a kind. Pure. */
export const checkRecordKey = (videoId: string, kind: CheckKind) => `${videoId}:${kind}`

/** Seconds on the video, or undefined; a sentence when it isn't one. Pure. */
function seconds(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new StudioError(`${what} must be seconds on the video (0 or more).`)
  return value
}

/** A check's range from a body: `from` and `to` in seconds, `to` after `from`. Pure. */
export function checkRange(body: { from?: unknown; to?: unknown }): { from?: number; to?: number } {
  const from = seconds(body.from, 'from')
  const to = seconds(body.to, 'to')
  if (from !== undefined && to !== undefined && to <= from) throw new StudioError('to must come after from.')
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }
}

/** A number in a range, or undefined (out of range is a sentence). Pure. */
function within(value: unknown, what: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new StudioError(`${what} must be from ${min} to ${max}.`)
  return value
}

/** What the review knows from the edit that pixels can't tell, in seconds on the video. Pure. */
export function reviewContext(project: EditorProject): ReviewContext {
  const fps = project.output.fps
  const round = (t: number) => Math.round(t * 1000) / 1000
  return {
    title: project.title,
    words: transcriptWords(project)
      .filter((w) => w.timingReliable)
      .map((w) => ({ t: round(w.startFrame / fps), end: round(w.endFrame / fps), text: w.text })),
    layers: (project.layers ?? []).map((l) => ({
      name: l.name,
      kind: l.kind,
      text: String(l.style.text ?? l.style.items?.join(' · ') ?? l.style.title ?? ''),
      start: round(l.startFrame / fps),
      end: round(l.endFrame / fps),
    })),
    clicks: clickCues(project).map((c) => c.t),
  }
}

/** The library videos named as references, checked. */
async function referencesOf(ctx: StudioContext, value: unknown): Promise<CheckReference[]> {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new StudioError('references must be a list of library video ids.')
  if (value.length > MAX_REFERENCES) throw new StudioError(`At most ${MAX_REFERENCES} references at once.`)
  const out: CheckReference[] = []
  for (const id of new Set(value as string[])) {
    const asset = await getAsset(ctx, id).catch(() => null)
    if (!asset || asset.kind !== 'video') throw new StudioError(`Reference ${id} is not a video in the media library.`)
    out.push({ asset })
  }
  return out
}

/**
 * Queue a check of a saved video. Body: motion {from, to, references, scale}; review {from, to, references};
 * look {step, scale}. Answers the job for the editor to poll.
 */
export async function startCheck(ctx: StudioContext, kind: CheckKind, videoId: string, body: Record<string, unknown>): Promise<{ job: EditorJob }> {
  if (kind === 'motion') requireCapability(ctx, 'motionCheck')
  if (kind === 'review') requireCapability(ctx, 'review')
  // The visual check needs only the renderer, which every worker has: refuse at once when none is running.
  if (kind === 'look') requireWorker('The visual check')
  const { project, projectDigest } = await openVideo(ctx, videoId)
  const fonts = await exportFonts(ctx, project).catch(() => [])
  const base = { project, digest: projectDigest, ...(fonts.length ? { fonts } : {}) }
  let row: JobRow
  if (kind === 'look') {
    const step = within(body.step, 'step', 0.1, 5)
    const scale = within(body.scale, 'scale', 0.2, 1)
    row = await queueJob(ctx, 'look', { ...base, ...(step !== undefined ? { step } : {}), ...(scale !== undefined ? { scale } : {}) }, videoId)
  } else {
    const range = checkRange(body)
    const references = await referencesOf(ctx, body.references)
    const refs = references.length ? { references } : {}
    if (kind === 'motion') {
      const scale = within(body.scale, 'scale', 0.2, 1)
      row = await queueJob(ctx, 'motion', { ...base, ...range, ...refs, ...(scale !== undefined ? { scale } : {}) }, videoId)
    } else row = await queueJob(ctx, 'review', { ...base, ...range, ...refs, context: reviewContext(project) }, videoId)
  }
  return { job: toEditorJob(row) }
}

/**
 * A finished check, kept as its video's latest of its kind (with the digest it measured). Called when the worker
 * completes the job; answers the result to keep on the job.
 */
export async function fileCheck(ctx: StudioContext, row: Pick<JobRow, 'id' | 'kind' | 'video_id' | 'input'>, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isCheckKind(row.kind)) return result
  if (typeof result.name !== 'string' && row.kind !== 'look') throw new StudioError(`The ${row.kind} check answered no report.`)
  if (row.kind === 'look' && !Array.isArray(result.issues)) throw new StudioError('The visual check answered no report.')
  if (row.video_id) {
    const record: CheckRecord = { kind: row.kind, jobId: row.id, videoId: row.video_id, digest: String(row.input?.digest ?? ''), checkedAt: new Date().toISOString(), result }
    await putRecord(ctx, CHECKS_COLLECTION, checkRecordKey(row.video_id, row.kind), record)
  }
  // A review of a library video by itself is a reference's: the blueprint waiting on it is finished (blueprint.ts).
  if (row.kind === 'review' && !row.video_id && row.input?.reference) await (await import('./blueprint')).fileReferenceReview(ctx, row, result)
  return result
}

/** A video's latest check of a kind, or null. */
export async function latestCheck(ctx: StudioContext, videoId: string, kind: CheckKind): Promise<CheckRecord | null> {
  return getRecord<CheckRecord>(ctx, CHECKS_COLLECTION, checkRecordKey(videoId, kind))
}

/** The latest visual check as the readiness list takes it, when it measured exactly this version. Pure. */
export function visualFor(record: CheckRecord | null, digest: string): VisualReport | null {
  if (!record || record.kind !== 'look' || !record.digest || record.digest !== digest) return null
  const r = record.result as Partial<LookResult>
  if (!Array.isArray(r.issues)) return null
  return { projectId: String(r.projectId ?? record.videoId), digest: record.digest, checkedAt: String(r.checkedAt ?? record.checkedAt), times: r.times ?? [], issues: r.issues, ...(r.sheet ? { sheet: r.sheet } : {}), folder: String(r.folder ?? '') }
}

/** The latest visual check of this video when it matches its digest, else null. */
export async function latestVisual(ctx: StudioContext, videoId: string, digest: string): Promise<VisualReport | null> {
  return visualFor(await latestCheck(ctx, videoId, 'look').catch(() => null), digest)
}

/** A check's file name: letters, digits, `_ . -`, a picture or its report. Pure. */
export const CHECK_FILE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,79}\.(png|jpg|json|txt)$/

/** The file a check made, served to a member of the job's workspace (404 for any other job or name). */
export async function serveCheckFile(ctx: StudioContext, kinds: CheckKind[], jobId: string, file: string, request: Request): Promise<Response> {
  if (!isUuid(jobId) || !CHECK_FILE.test(file) || file.includes('..')) throw notFoundError('No such picture.')
  const row = await jobRow(ctx, jobId)
  if (!(kinds as string[]).includes(row.kind)) throw notFoundError('No such picture.')
  const blob = await getBlob(ctx, `checks/${jobId}/${file}`)
  if (!blob) throw notFoundError('No such picture.')
  return serveBlob(ctx, blob, request)
}
