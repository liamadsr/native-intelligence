// The reference blueprint: what a library video (a reference) teaches about structure, computed once and kept.
//
//   requestBlueprint  start it: a review of the reference by itself (a `review` job with `reference`, run on the
//                     file as it is) and, when it has sound and no transcript, a transcript of it (the transcription
//                     path every recording takes). Kept at once as `measuring`.
//   getBlueprint      read it: ready, still measuring (the job to wait on), failed, or none yet. Reading a measuring
//                     one whose jobs ended finishes it.
//   fileReferenceReview  the review's result as it is filed (checks.ts fileCheck): finishes the blueprint at once
//                     when nothing else is waited on
//
// Kept as a studio_record, collection `blueprints`, keyed by the reference asset's id, with the asset's sha256: a
// blueprint of other bytes counts as none and is made again. The beat grid itself is the engine's pure function
// (engine/blueprint.ts makeBlueprint, through blueprint-lines.ts). Without a transcript (no sound, no speech, or the
// worker can't transcribe) the blueprint keeps its rhythm and has no words, and its note says why.
import type { EditorJob } from '../engine/api'
import type { Blueprint, TimedWord } from '../engine/blueprint'
import type { EditorAsset } from '../engine/contracts'
import { getAsset, transcriptForAsset } from './assets'
import { blueprintScenes, buildBlueprint, type BlueprintScene } from './blueprint-lines'
import { requireCapability } from './capabilities'
import type { ReviewResult } from './check-contract'
import type { StudioContext } from './context'
import { StudioError } from './errors'
import { jobRow, queueJob, toEditorJob, type JobRow } from './jobs'
import { getRecord, putRecord } from './records'
import { requestTranscription } from './transcription'

/** The studio_record collection blueprints are kept in, keyed by the reference asset's id. */
export const BLUEPRINTS_COLLECTION = 'blueprints'

/** Whether a kept blueprint has the reference's words, and from where. */
export type BlueprintWords = 'transcript' | 'none'

/** A kept blueprint, by state. `sha256` is the reference's bytes it was made from. */
export type BlueprintRecord = {
  assetId: string
  sha256: string
  state: 'measuring' | 'ready' | 'failed'
  /** The review job of the reference, and its transcribe job when one was started. */
  reviewJobId?: string
  transcriptJobId?: string
  blueprint?: Blueprint
  /** How each scene reads, beside the beat grid (never the reference's text). */
  scenes?: BlueprintScene[]
  words?: BlueprintWords
  /** Why the blueprint has no words, or what else to know. */
  note?: string
  error?: string
  at: string
}

/** What a blueprint read answers. */
export type BlueprintAnswer =
  | { state: 'ready'; blueprint: Blueprint; scenes: BlueprintScene[]; words: BlueprintWords; note?: string }
  | { state: 'measuring'; job: EditorJob }
  | { state: 'failed'; error: string }
  | { state: 'none' }

/** The reference: a video in the media library, or a sentence. */
async function referenceAsset(ctx: StudioContext, assetId: unknown): Promise<EditorAsset> {
  if (typeof assetId !== 'string' || !assetId || assetId.length > 200) throw new StudioError('Choose a library video as the reference.')
  const asset = await getAsset(ctx, assetId).catch(() => null)
  if (!asset || asset.kind !== 'video') throw new StudioError(`Reference ${assetId} is not a video in the media library.`, 404, 'NOT_FOUND')
  return asset
}

/** The kept record of these bytes, or null (none kept, or kept for other bytes). */
async function keptRecord(ctx: StudioContext, asset: EditorAsset): Promise<BlueprintRecord | null> {
  const kept = await getRecord<BlueprintRecord>(ctx, BLUEPRINTS_COLLECTION, asset.id)
  return kept && kept.sha256 === asset.sha256 ? kept : null
}

/** A record as its answer (a measuring one needs its job: settle answers those). Pure. */
function answerOf(record: BlueprintRecord): BlueprintAnswer {
  if (record.state === 'ready' && record.blueprint)
    return { state: 'ready', blueprint: record.blueprint, scenes: record.scenes ?? [], words: record.words ?? 'none', ...(record.note ? { note: record.note } : {}) }
  return { state: 'failed', error: record.error ?? 'The blueprint could not be made.' }
}

/** The reference's timed words from its registered transcript (of these bytes), or none. */
async function referenceWords(ctx: StudioContext, asset: EditorAsset): Promise<TimedWord[]> {
  const transcript = await transcriptForAsset(ctx, asset.id).catch(() => null)
  if (!transcript || transcript.sourceSha256 !== asset.sha256) return []
  return transcript.words.map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs }))
}

/** Why a blueprint has no words, from the reference and its transcribe job. Pure. */
export function noWordsNote(asset: Pick<EditorAsset, 'hasAudio'>, transcriptJob: Pick<JobRow, 'status' | 'result' | 'error'> | null, earlier: string | undefined): string {
  if (!asset.hasAudio) return 'The reference has no sound, so the blueprint has no words: its beats follow the picture alone.'
  const outcome = (transcriptJob?.result as { outcome?: string } | null)?.outcome
  if (outcome === 'no-speech') return 'No speech was found in the reference, so its beats follow the picture alone.'
  if (transcriptJob && transcriptJob.status !== 'completed') return `The reference could not be transcribed (${transcriptJob.error ?? transcriptJob.status}), so the blueprint has no words or pace: its beats follow the picture alone.`
  return earlier ?? 'The reference has no transcript, so the blueprint has no words or pace: its beats follow the picture alone.'
}

/** Finish a measuring record from its review's answer: the beat grid built and kept as ready (or failed). */
async function finish(ctx: StudioContext, asset: EditorAsset, record: BlueprintRecord, review: ReviewResult, transcriptJob: JobRow | null): Promise<BlueprintAnswer> {
  const words = await referenceWords(ctx, asset)
  const blueprint = buildBlueprint(asset.id, review, words)
  const at = new Date().toISOString()
  if (!blueprint) {
    const failed: BlueprintRecord = { ...record, state: 'failed', error: 'The review answered no scene list (the Studio worker may need a restart to the current version).', at }
    await putRecord(ctx, BLUEPRINTS_COLLECTION, asset.id, failed)
    return answerOf(failed)
  }
  const scenes = blueprintScenes(review.sceneList)
  const note = words.length ? undefined : noWordsNote(asset, transcriptJob, record.note)
  const ready: BlueprintRecord = { assetId: asset.id, sha256: asset.sha256, state: 'ready', reviewJobId: record.reviewJobId, blueprint, scenes, words: words.length ? 'transcript' : 'none', ...(note ? { note } : {}), at }
  await putRecord(ctx, BLUEPRINTS_COLLECTION, asset.id, ready)
  return answerOf(ready)
}

/** A job row, or null when it is gone. */
const rowOrNull = (ctx: StudioContext, id: string | undefined) => (id ? jobRow(ctx, id).catch(() => null) : Promise.resolve(null))

const running = (row: JobRow | null) => row?.status === 'queued' || row?.status === 'running'

/** A measuring record brought up to date: still measuring (the job to wait on), finished, or failed. */
async function settle(ctx: StudioContext, asset: EditorAsset, record: BlueprintRecord): Promise<BlueprintAnswer> {
  const review = await rowOrNull(ctx, record.reviewJobId)
  if (review && running(review)) return { state: 'measuring', job: toEditorJob(review) }
  if (!review || review.status !== 'completed' || !review.result) {
    const failed: BlueprintRecord = { ...record, state: 'failed', error: review?.error ?? 'The review of the reference did not finish.', at: new Date().toISOString() }
    await putRecord(ctx, BLUEPRINTS_COLLECTION, asset.id, failed)
    return answerOf(failed)
  }
  const transcript = await rowOrNull(ctx, record.transcriptJobId)
  if (transcript && running(transcript)) return { state: 'measuring', job: toEditorJob(transcript) }
  return finish(ctx, asset, record, review.result as unknown as ReviewResult, transcript)
}

/** A library video's blueprint as kept: ready, measuring (the job to wait on), failed, or none yet. */
export async function getBlueprint(ctx: StudioContext, assetId: unknown): Promise<BlueprintAnswer> {
  const asset = await referenceAsset(ctx, assetId)
  const record = await keptRecord(ctx, asset)
  if (!record) return { state: 'none' }
  return record.state === 'measuring' ? settle(ctx, asset, record) : answerOf(record)
}

/** Asks in flight in this process, so two at once for one reference start one review. */
const asking = new Map<string, Promise<BlueprintAnswer>>()

/**
 * A library video's blueprint, started when there is none for its bytes (or it failed, or `rebuild`): the review of
 * the file by itself, and its transcript when it has sound and none yet. Answers as getBlueprint does.
 */
export function requestBlueprint(ctx: StudioContext, assetId: unknown, options: { rebuild?: boolean } = {}): Promise<BlueprintAnswer> {
  const slot = `${ctx.workspaceId}:${String(assetId)}`
  const inFlight = asking.get(slot)
  if (inFlight) return inFlight
  const work = (async (): Promise<BlueprintAnswer> => {
    const asset = await referenceAsset(ctx, assetId)
    const record = await keptRecord(ctx, asset)
    if (record && !options.rebuild) {
      if (record.state === 'ready') return answerOf(record)
      if (record.state === 'measuring') {
        const settled = await settle(ctx, asset, record)
        if (settled.state !== 'failed') return settled
      }
    }
    return start(ctx, asset)
  })().finally(() => asking.delete(slot))
  asking.set(slot, work)
  return work
}

/** Queue the review of the reference and, when it needs one, its transcript, and keep the record as measuring. */
async function start(ctx: StudioContext, asset: EditorAsset): Promise<BlueprintAnswer> {
  requireCapability(ctx, 'review')
  const review = await queueJob(ctx, 'review', { reference: { asset } })
  let transcriptJobId: string | undefined
  let note: string | undefined
  if (asset.hasAudio) {
    try {
      const answer = await requestTranscription(ctx, asset.id)
      if ('job' in answer) transcriptJobId = answer.job.id
      else if ('outcome' in answer) note = noWordsNote(asset, { status: 'completed', result: { outcome: answer.outcome }, error: null }, undefined)
    } catch (error) {
      note = `The reference could not be transcribed (${error instanceof Error ? error.message : 'unknown'}), so the blueprint has no words or pace: its beats follow the picture alone.`
    }
  }
  const record: BlueprintRecord = { assetId: asset.id, sha256: asset.sha256, state: 'measuring', reviewJobId: review.id, ...(transcriptJobId ? { transcriptJobId } : {}), ...(note ? { note } : {}), at: new Date().toISOString() }
  await putRecord(ctx, BLUEPRINTS_COLLECTION, asset.id, record)
  return { state: 'measuring', job: toEditorJob(review) }
}

/**
 * A finished review of a reference, as the worker's result is filed: the blueprint waiting on it is finished at
 * once when its transcript is not still running (else the next read finishes it). Never throws: the review itself
 * is filed either way.
 */
export async function fileReferenceReview(ctx: StudioContext, row: Pick<JobRow, 'id' | 'input'>, result: Record<string, unknown>): Promise<void> {
  try {
    const asset = (row.input as { reference?: { asset?: EditorAsset } }).reference?.asset
    if (!asset?.id) return
    const record = await getRecord<BlueprintRecord>(ctx, BLUEPRINTS_COLLECTION, asset.id)
    if (!record || record.state !== 'measuring' || record.reviewJobId !== row.id || record.sha256 !== asset.sha256) return
    const transcript = await rowOrNull(ctx, record.transcriptJobId)
    if (transcript && running(transcript)) return
    await finish(ctx, asset, record, result as unknown as ReviewResult, transcript)
  } catch (error) {
    console.error('[studio] finishing a blueprint failed:', error instanceof Error ? error.message : error)
  }
}
