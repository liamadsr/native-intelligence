// Transcribing a recording in the Studio: a `transcribe` job the worker runs (jobs.ts files its result: a
// transcript is registered, "no speech" and "no audio" end the job without one). This file decides whether a new job
// is needed at all, so an asset is transcribed at most once at a time and never again after it was found to hold no
// speech or no audio, unless the person asks for it again (`retry`).
//
//   a transcript is registered for the asset     -> { transcript }        nothing queued
//   a transcribe job of the asset is running     -> { job }               that job, nothing queued
//   it was found to hold no speech / no audio    -> { outcome }           remembered (studio_record), nothing queued
//   otherwise                                    -> { job }               a new job
import type { EditorAsset, EditorTranscript } from '../engine/contracts'
import type { EditorJob } from '../engine/api'
import { getAssets, transcriptForAsset } from './assets'
import { must, type StudioContext } from './context'
import { StudioError } from './errors'
import { queueJob, toEditorJob, type JobRow } from './jobs'
import { deleteRecord, getRecord, putRecord } from './records'

/** Per asset: what its last transcription found when it found nothing to transcribe. */
export const OUTCOMES_COLLECTION = 'transcription-outcomes'
export type EmptyOutcome = 'no-speech' | 'no-audio'
type OutcomeRecord = { outcome: EmptyOutcome; sourceSha256: string; at: string }

export type TranscriptionAnswer =
  | { job: EditorJob }
  | { transcript: EditorTranscript }
  | { outcome: EmptyOutcome }

/** What GET /transcription/config answers: transcription runs on the server, nothing to set up. */
export const TRANSCRIPTION_INFO = { config: null, ready: true, serviceFee: 0 } as const

const JOB_FIELDS = 'id, workspace_id, video_id, kind, status, progress, logs, input, result, error, cancel_requested, worker_id, attempts, created_by, created_at, updated_at'

/** The transcribe job of an asset still queued or running, if any. */
async function runningJob(ctx: StudioContext, assetId: string): Promise<JobRow | null> {
  const rows = must(
    await ctx.supabase.from('studio_job').select(JOB_FIELDS).eq('workspace_id', ctx.workspaceId).eq('kind', 'transcribe').in('status', ['queued', 'running']).eq('input->asset->>id', assetId).order('created_at', { ascending: false }).limit(1),
    'read jobs',
  ) as JobRow[] | null
  return rows?.[0] ?? null
}

/** The empty outcome remembered for an asset (these bytes), reading it back from its last finished job the first time. */
export async function emptyOutcome(ctx: StudioContext, asset: EditorAsset): Promise<EmptyOutcome | null> {
  const kept = await getRecord<OutcomeRecord>(ctx, OUTCOMES_COLLECTION, asset.id)
  if (kept) return kept.sourceSha256 === asset.sha256 ? kept.outcome : null
  const rows = must(
    await ctx.supabase.from('studio_job').select('result, updated_at').eq('workspace_id', ctx.workspaceId).eq('kind', 'transcribe').eq('status', 'completed').eq('input->asset->>id', asset.id).order('updated_at', { ascending: false }).limit(1),
    'read jobs',
  ) as { result: { outcome?: string } | null }[] | null
  const outcome = rows?.[0]?.result?.outcome
  if (outcome !== 'no-speech' && outcome !== 'no-audio') return null
  await rememberOutcome(ctx, asset, outcome)
  return outcome
}

/** Remember that an asset holds no speech or no audio. */
export async function rememberOutcome(ctx: StudioContext, asset: EditorAsset, outcome: EmptyOutcome): Promise<void> {
  await putRecord(ctx, OUTCOMES_COLLECTION, asset.id, { outcome, sourceSha256: asset.sha256, at: new Date().toISOString() } satisfies OutcomeRecord)
}

/** Asks in flight in this process, so two at once for one asset queue one job. */
const asking = new Map<string, Promise<TranscriptionAnswer>>()

/**
 * Transcribe a library asset (see the header). `retry`: the person asked again, so a remembered "no speech" or
 * "no audio" does not stop a new job (a running job or a registered transcript still does).
 */
export function requestTranscription(ctx: StudioContext, assetId: unknown, options: { retry?: boolean } = {}): Promise<TranscriptionAnswer> {
  if (typeof assetId !== 'string' || !assetId || assetId.length > 200) return Promise.reject(new StudioError('Choose a recording or audio file to transcribe.'))
  const slot = `${ctx.workspaceId}:${assetId}`
  const running = asking.get(slot)
  if (running) return running
  const work = (async (): Promise<TranscriptionAnswer> => {
    const asset = (await getAssets(ctx, [assetId])).get(assetId)
    if (!asset) throw new StudioError('That recording is not in the library.', 404, 'NOT_FOUND')
    const transcript = await transcriptForAsset(ctx, asset.id)
    if (transcript && transcript.sourceSha256 === asset.sha256) return { transcript }
    const job = await runningJob(ctx, asset.id)
    if (job) return { job: toEditorJob(job) }
    if (!asset.hasAudio) {
      await rememberOutcome(ctx, asset, 'no-audio')
      return { outcome: 'no-audio' }
    }
    if (options.retry) await deleteRecord(ctx, OUTCOMES_COLLECTION, asset.id)
    else {
      const outcome = await emptyOutcome(ctx, asset)
      if (outcome) return { outcome }
    }
    return { job: toEditorJob(await queueJob(ctx, 'transcribe', { asset })) }
  })().finally(() => asking.delete(slot))
  asking.set(slot, work)
  return work
}
