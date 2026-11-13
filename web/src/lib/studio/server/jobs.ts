// Long work (studio_job): importing a file, exporting a video, stills, a thumbnail, a transcript, a slide deck. The
// app queues a row; the Studio worker (its own process with a browser and FFmpeg, job-contract.ts) claims it,
// reports progress on it and finishes it; the editor polls the row. When a job finishes, the app files what it
// made: an imported file becomes a library asset, a transcript is registered, a deck's pages become assets.
//
// The editor reads a job as its EditorJob: queued and running both read as 'running'.
import type { SupabaseClient } from '@supabase/supabase-js'
import { EditorAssetSchema, type EditorAsset, type EditorTranscript } from '../engine/contracts'
import type { EditorJob } from '../engine/api'
import { registerAsset, registerTranscript } from './assets'
import { ASSET_KEY, deleteBlob, getBlob, type StoredBlob } from './blobs'
import { isUuid, must, type StudioContext } from './context'
import { deliverEndedExport } from './delivery'
import { asStudioError, conflictError, notFoundError, StudioError } from './errors'
import type { ClaimedJob, ExportResult, ImportInput, SlidesInput, SlidesResult, StudioJobIO, StudioJobKind, StudioJobStatus, TranscribeInput, TranscribeResult } from './job-contract'
import { COLLECTIONS, putRecord } from './records'
import type { StudioStorage } from './storage'
import { KEEP } from './sweep'

/** Where the app serves a workspace's stored files (files.ts). */
export const fileUrl = (workspaceId: string, key: string) => `/api/account/studio/file/${workspaceId}/${key}`

/** How many log lines a job keeps. */
const KEEP_LOGS = 200

export type JobRow = {
  id: string
  workspace_id: string
  video_id: string | null
  kind: StudioJobKind
  status: StudioJobStatus
  progress: number
  logs: string[]
  input: Record<string, unknown>
  result: Record<string, unknown> | null
  error: string | null
  cancel_requested: boolean
  worker_id: string | null
  attempts: number
  created_by: string | null
  created_at: string
  updated_at: string
}

/**
 * How much one workspace may have waiting or running at once. The worker is shared by every workspace, so one
 * member (or one agent) queuing without end would hold everyone else's work up: past these a new job is refused
 * (429) until some finish. Exports are the long ones, so they have their own, lower cap.
 */
export const MAX_OPEN_JOBS = 20
export const MAX_OPEN_EXPORTS = 5

/** Refuse (429) a new job when the workspace already has as many open as it may (MAX_OPEN_JOBS, MAX_OPEN_EXPORTS). */
async function checkOpenJobs(ctx: StudioContext, kind: StudioJobKind): Promise<void> {
  const open = must(
    await ctx.supabase.from('studio_job').select('kind').eq('workspace_id', ctx.workspaceId).in('status', ['queued', 'running']).eq('cancel_requested', false).limit(MAX_OPEN_JOBS),
    'start that job',
  ) as { kind: string }[] | null
  if ((open?.length ?? 0) >= MAX_OPEN_JOBS)
    throw new StudioError(`This workspace already has ${MAX_OPEN_JOBS} Studio jobs waiting or running. Wait for some to finish, then try again.`, 429, 'TOO_MANY_JOBS')
  if (kind === 'export' && (open ?? []).filter((job) => job.kind === 'export').length >= MAX_OPEN_EXPORTS)
    throw new StudioError(`This workspace already has ${MAX_OPEN_EXPORTS} exports waiting or running. Wait for one to finish, then try again.`, 429, 'TOO_MANY_JOBS')
}

/** True when PostgREST says a function is not there (a migration not applied yet). */
const missingFunction = (error: { code?: string } | null) => error?.code === 'PGRST202' || error?.code === '42883'

/**
 * Queue a job of a kind with its input (job-contract.ts says what each kind is given). 429 past the caps above.
 * The caps are counted and the row inserted in one transaction, one queue per workspace at a time
 * (studio_queue_job, migration 627), so requests at once can't together pass them. Before 627 is applied, counted
 * first and inserted after, as before.
 */
export async function queueJob<K extends StudioJobKind>(ctx: StudioContext, kind: K, input: StudioJobIO[K]['input'] & Record<string, unknown>, videoId: string | null = null): Promise<JobRow> {
  const video = videoId && isUuid(videoId) ? videoId : null
  const { data, error } = await ctx.supabase.rpc('studio_queue_job', {
    p_workspace: ctx.workspaceId, p_kind: kind, p_input: input, p_video: video, p_created_by: ctx.userId, p_max_open: MAX_OPEN_JOBS, p_max_exports: MAX_OPEN_EXPORTS,
  })
  if (!missingFunction(error)) {
    const rows = must({ data, error }, 'start that job') as JobRow[] | JobRow | null
    const made = Array.isArray(rows) ? rows[0] : rows
    if (made?.id) return fromFull(made)
    // Refused at a cap: say which (counted again), or that the workspace is at one.
    await checkOpenJobs(ctx, kind)
    throw new StudioError(`This workspace already has as many Studio jobs waiting or running as it may. Wait for some to finish, then try again.`, 429, 'TOO_MANY_JOBS')
  }
  await checkOpenJobs(ctx, kind)
  const row = must(
    await ctx.supabase
      .from('studio_job')
      .insert({ workspace_id: ctx.workspaceId, video_id: video, kind, input, created_by: ctx.userId })
      .select(LIGHT_FIELDS)
      .single(),
    'start that job',
  ) as LightRow
  return fromLight(row)
}

// What the editor's reads take of a job: everything but its input, of which only the export's title and the
// transcribed asset are needed (an export's input is a whole edit, read every 700 ms while it runs).
// The thumbnail job's given key is read too: the worker's blob writes are fenced to it (blobs.ts workerWriteFence).
const LIGHT_FIELDS = 'id, workspace_id, video_id, kind, status, progress, logs, result, error, cancel_requested, worker_id, attempts, created_by, created_at, updated_at, input_title:input->>title, input_asset:input->asset, input_key:input->>key'
type LightRow = Omit<JobRow, 'input'> & { input_title: string | null; input_asset: EditorAsset | null; input_key?: string | null }
const fromLight = (row: LightRow): JobRow => {
  const { input_title, input_asset, input_key, ...rest } = row
  return { ...rest, ...stoppedWhileQueued(rest), input: { ...(input_title ? { title: input_title } : {}), ...(input_asset ? { asset: input_asset } : {}), ...(input_key ? { key: input_key } : {}) } }
}

/** A whole row (the queue function answers one) as the editor's reads take it: its input reduced the same way. */
const fromFull = (row: JobRow): JobRow => {
  const input = (row.input ?? {}) as Record<string, unknown>
  return fromLight({
    ...row,
    input_title: typeof input.title === 'string' ? input.title : null,
    input_asset: (input.asset as EditorAsset | undefined) ?? null,
    input_key: typeof input.key === 'string' ? input.key : null,
  } as LightRow)
}

/** What a job's worker is told and the person reads when it ends because they asked it to stop. */
const CANCELLED = 'Cancelled.'

/**
 * A queued row the person asked to stop reads as cancelled. cancelJob cancels a queued job at once, so such a row is
 * one that was running when they asked and went back in the queue when its worker went quiet (studio_claim_job):
 * no worker ever claims it again, and without this it would read as running for good.
 */
function stoppedWhileQueued(row: Pick<JobRow, 'status' | 'cancel_requested' | 'error'>): Partial<JobRow> {
  return row.status === 'queued' && row.cancel_requested ? { status: 'cancelled', error: row.error ?? CANCELLED } : {}
}

/** A job of this workspace (its input reduced to what the editor reads), or 404. */
export async function jobRow(ctx: StudioContext, id: string): Promise<JobRow> {
  if (!isUuid(id)) throw notFoundError('Job not found')
  const row = must(await ctx.supabase.from('studio_job').select(LIGHT_FIELDS).eq('workspace_id', ctx.workspaceId).eq('id', id).maybeSingle(), 'read that job') as LightRow | null
  if (!row) throw notFoundError('Job not found')
  return fromLight(row)
}

/** A file name safe for a download header. */
const fileName = (title: string, extension: string) => `${(title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'video').slice(0, 120)}.${extension}`

/** A job as the editor reads it (EditorJob): queued and running are both 'running'. */
export function toEditorJob(row: JobRow): EditorJob {
  const status: EditorJob['status'] = row.status === 'queued' || row.status === 'running' ? 'running' : row.status
  const job: EditorJob = {
    id: row.id,
    kind: row.kind as EditorJob['kind'],
    status,
    progress: Number(row.progress) || 0,
    logs: Array.isArray(row.logs) ? row.logs.map(String) : [],
    ...(row.error ? { error: row.error } : {}),
    ...(row.result ? { result: row.result } : {}),
  }
  if (row.status === 'queued' && !job.logs.length) job.logs = ['Waiting for the Studio worker…']
  if (row.kind === 'export' && row.status === 'completed' && typeof row.result?.key === 'string') {
    const title = typeof row.input?.title === 'string' ? row.input.title : 'video'
    job.downloadUrl = `${fileUrl(row.workspace_id, row.result.key)}?download=${encodeURIComponent(fileName(title, 'mp4'))}`
  }
  if ((row.kind === 'import' || row.kind === 'slides') && row.result?.asset) job.asset = row.result.asset as EditorAsset
  if (row.kind === 'transcribe') {
    const asset = (row.input as TranscribeInput).asset
    if (asset) {
      job.assetId = asset.id
      job.sourceSha256 = asset.sha256
    }
    const result = row.result as TranscribeResult | null
    if (result) {
      job.outcome = result.outcome
      if (result.outcome === 'transcribed') job.transcript = result.transcript
    }
  }
  return job
}

/** A job as the editor reads it. */
export async function getJob(ctx: StudioContext, id: string): Promise<EditorJob> {
  return toEditorJob(await jobRow(ctx, id))
}

/** Ask a job to stop: a queued one is cancelled at once, a running one when its worker next reports. */
export async function cancelJob(ctx: StudioContext, id: string): Promise<EditorJob> {
  const row = await jobRow(ctx, id)
  if (row.status === 'queued') {
    must(await ctx.supabase.from('studio_job').update({ cancel_requested: true, status: 'cancelled', error: CANCELLED }).eq('id', id).eq('workspace_id', ctx.workspaceId).eq('status', 'queued'), 'cancel that job')
  } else if (row.status === 'running') {
    must(await ctx.supabase.from('studio_job').update({ cancel_requested: true }).eq('id', id).eq('workspace_id', ctx.workspaceId), 'cancel that job')
  }
  return getJob(ctx, id)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The job's row once it is finished, or as it is when `timeoutMs` runs out (still queued or running). */
export async function waitForJob(ctx: StudioContext, id: string, options: { timeoutMs?: number; everyMs?: number; signal?: AbortSignal } = {}): Promise<JobRow> {
  const until = Date.now() + (options.timeoutMs ?? 110_000)
  for (;;) {
    const row = await jobRow(ctx, id)
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') return row
    if (Date.now() + (options.everyMs ?? 1000) > until || options.signal?.aborted) return row
    await sleep(options.everyMs ?? 1000)
  }
}

/** A finished export as the Export dialog lists it: the job as the editor reads it, its title, and when it finished. */
export type FinishedExport = EditorJob & { title: string; finishedAt: string }

/**
 * A video's finished exports whose files are still kept (KEEP.exports, sweep.ts), the newest export first: every member's, as the
 * files are the workspace's. The Export dialog lists them so a finished export stays reachable after the dialog
 * closes, another export starts or the page reloads.
 */
export async function videoExports(ctx: StudioContext, videoId: string, now = Date.now()): Promise<{ exports: FinishedExport[] }> {
  if (!isUuid(videoId)) throw notFoundError('Video not found')
  const rows = must(
    await ctx.supabase.from('studio_job').select(LIGHT_FIELDS).eq('workspace_id', ctx.workspaceId).eq('video_id', videoId).eq('kind', 'export').eq('status', 'completed')
      .gte('updated_at', new Date(now - KEEP.exports).toISOString()).order('created_at', { ascending: false }).limit(20),
    'read the exports',
  ) as LightRow[] | null
  return {
    exports: (rows ?? []).map(fromLight).flatMap((row) => {
      const job = toEditorJob(row)
      return job.downloadUrl ? [{ ...job, title: typeof row.input.title === 'string' ? row.input.title : 'video', finishedAt: row.updated_at }] : []
    }),
  }
}

/** The person's export or transcription still going, if any (the editor picks it back up when it opens). */
export async function activeJob(ctx: StudioContext, userId: string): Promise<EditorJob | null> {
  const rows = must(
    await ctx.supabase.from('studio_job').select(LIGHT_FIELDS).eq('workspace_id', ctx.workspaceId).eq('created_by', userId).in('status', ['queued', 'running']).in('kind', ['export', 'transcribe']).order('created_at', { ascending: false }).limit(1),
    'read jobs',
  ) as LightRow[] | null
  return rows?.[0] ? toEditorJob(fromLight(rows[0])) : null
}

// ---- the worker's side ---------------------------------------------------------------------------------------

/** What the worker routes run with: a service-role client (and storage, for tests). No workspace until a job is read. */
export type WorkerDeps = { supabase: SupabaseClient; storage?: StudioStorage }

/** The context of the workspace a job belongs to, acting for nobody (the worker). */
export const jobContext = (deps: WorkerDeps, row: Pick<JobRow, 'workspace_id'>): StudioContext => ({ supabase: deps.supabase, storage: deps.storage, workspaceId: row.workspace_id, userId: null })

/** Take the oldest queued job of these kinds for this worker (stale ones go back in the queue first). */
export async function claimJob(deps: WorkerDeps, workerId: string, kinds: StudioJobKind[]): Promise<ClaimedJob | null> {
  const rows = must(await deps.supabase.rpc('studio_claim_job', { p_worker: workerId, p_kinds: kinds }), 'claim a job') as JobRow[] | JobRow | null
  const row = Array.isArray(rows) ? rows[0] : rows
  if (!row) return null
  return { id: row.id, kind: row.kind, workspaceId: row.workspace_id, videoId: row.video_id, input: row.input as never, attempts: row.attempts }
}

/** The job, when this worker holds it (claimed by it and running); otherwise a 409 the worker should stop on. */
export async function heldJob(deps: WorkerDeps, jobId: string, workerId: string, withInput = false): Promise<JobRow> {
  if (!isUuid(jobId)) throw notFoundError('Job not found')
  const read = withInput ? deps.supabase.from('studio_job').select('*') : deps.supabase.from('studio_job').select(LIGHT_FIELDS)
  const found = must(await read.eq('id', jobId).maybeSingle(), 'read that job') as JobRow | LightRow | null
  const row = found && !withInput ? fromLight(found as LightRow) : (found as JobRow | null)
  if (!row) throw notFoundError('Job not found')
  if (row.worker_id !== workerId || row.status !== 'running') throw conflictError('This worker does not hold that job any more.', 'NOT_HELD')
  return row
}

/** Progress (0–1) and an optional log line from the worker; answers whether the person asked it to stop. */
export async function reportProgress(deps: WorkerDeps, jobId: string, body: { workerId: string; progress: number; log?: string }): Promise<{ cancelRequested: boolean }> {
  const row = await heldJob(deps, jobId, body.workerId)
  const logs = body.log ? [...(row.logs ?? []), body.log].slice(-KEEP_LOGS) : row.logs
  must(
    await deps.supabase
      .from('studio_job')
      .update({ progress: Math.max(0, Math.min(1, body.progress)), logs, heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('worker_id', body.workerId)
      .eq('status', 'running'),
    'record progress',
  )
  return { cancelRequested: row.cancel_requested }
}

/**
 * The worker failed, or stopped because it was asked to: a job the person asked to stop ends cancelled whatever the
 * worker's words ('Cancelled', or a failure on the way out), any other ends failed with its reason. Each write
 * checks the flag itself, so a cancel that lands while the worker reports still ends cancelled.
 */
export async function failJob(deps: WorkerDeps, jobId: string, workerId: string, error: string): Promise<{ ok: true }> {
  const held = await heldJob(deps, jobId, workerId)
  const end = async (cancelled: boolean) => {
    const patch = cancelled ? { status: 'cancelled', error: CANCELLED } : { status: 'failed', error: error.slice(0, 4000) }
    const rows = must(
      await deps.supabase
        .from('studio_job')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', jobId)
        .eq('worker_id', workerId)
        .eq('status', 'running')
        .eq('cancel_requested', cancelled)
        .select('id'),
      'record the failure',
    ) as { id: string }[] | null
    return Boolean(rows?.length)
  }
  // Cancelled, else failed, else (a cancel landed between the two) cancelled; none when the worker no longer holds it.
  const cancelled = await end(true)
  const failed = !cancelled && (await end(false))
  const late = !cancelled && !failed && (await end(true))
  // An upload whose import ended without an asset is not kept (it is never served, and counts against the space).
  if (cancelled || failed || late) await dropUpload(deps, held)
  // A failed export is reported to whoever queued it, by the delivery rule (delivery.ts); a cancelled one was asked for.
  if (failed && held.kind === 'export') await deliverEndedExport(deps, jobId)
  // A product capture's import that ended without its file: its product job is told (products.ts). Never throws.
  if ((cancelled || failed || late) && held.kind === 'import') await settleProductCapture(deps, jobId, { error: failed ? error : CANCELLED })
  // A recording's import that ended: when it was the last, the recording is finished now (recordings.ts). Never throws.
  if ((cancelled || failed || late) && held.kind === 'import') await settleRecording(deps, held)
  return { ok: true }
}

/**
 * The worker finished: what it made is filed (assets registered, transcripts registered, uploads removed) and the
 * job completes with that result. When what it made can't be filed, the job fails with the reason and the worker
 * is answered 422.
 */
export async function completeJob(deps: WorkerDeps, jobId: string, workerId: string, result: unknown): Promise<{ ok: true }> {
  let row: JobRow
  try {
    row = await heldJob(deps, jobId, workerId, true)
  } catch (error) {
    if (error instanceof StudioError && error.code === 'NOT_HELD') await chargeLateResult(deps, jobId, workerId, result)
    throw error
  }
  const ctx = jobContext(deps, row)
  let filed: Record<string, unknown>
  try {
    filed = await fileResult(ctx, row, result)
  } catch (error) {
    const reason = asStudioError(error, `The ${row.kind} result`).message
    must(
      await deps.supabase.from('studio_job').update({ status: 'failed', error: reason.slice(0, 4000), updated_at: new Date().toISOString() }).eq('id', jobId).eq('worker_id', workerId).eq('status', 'running'),
      'record the failure',
    )
    if (row.kind === 'export') await deliverEndedExport(deps, jobId)
    if (row.kind === 'import') await settleProductCapture(deps, jobId, { error: reason })
    await dropUpload(deps, row)
    if (row.kind === 'import') await settleRecording(deps, row)
    throw new StudioError(reason, 422, 'RESULT_REFUSED')
  }
  const done = must(
    await deps.supabase
      .from('studio_job')
      .update({ status: 'completed', progress: 1, result: filed, error: null, updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('worker_id', workerId)
      .eq('status', 'running')
      .select('id'),
    'finish that job',
  ) as { id: string }[] | null
  if (!done?.length) throw conflictError('This worker does not hold that job any more.', 'NOT_HELD')
  // The consumed upload goes only once the job is recorded as done, never while the job could still be taken back.
  await dropUpload(deps, row, true)
  // A finished export goes to whoever queued it, the way the app delivers finished work (delivery.ts). Never throws.
  if (row.kind === 'export') await deliverEndedExport(deps, jobId)
  // A product capture whose import outlasted the capture route's wait is filed now (products.ts). Never throws.
  if (row.kind === 'import' && filed.asset) await settleProductCapture(deps, jobId, { asset: filed.asset as EditorAsset })
  if (row.kind === 'import') await settleRecording(deps, row)
  return { ok: true }
}

/**
 * An import of a product capture (its provenance names the product job, products.ts acceptCapture) that ended after
 * the capture route stopped waiting for it: completed, the capture is filed onto its job (kept, placed or swapped in,
 * the job finished); failed or cancelled, the job is told. Only a job still waiting on this very import is touched,
 * so an import the route already filed changes nothing. Never throws.
 */
async function settleProductCapture(deps: WorkerDeps, jobId: string, ended: { asset: EditorAsset } | { error: string | null }): Promise<void> {
  try {
    const found = must(await deps.supabase.from('studio_job').select('workspace_id, kind, provenance:input->provenance').eq('id', jobId).maybeSingle(), 'read that job') as
      | { workspace_id: string; kind: string; provenance: { productComponent?: { job?: unknown } } | null }
      | null
    const productJob = found?.provenance?.productComponent?.job
    if (!found || found.kind !== 'import' || typeof productJob !== 'string' || !isUuid(productJob)) return
    const ctx = jobContext(deps, found)
    const products = await import('./products')
    if ('asset' in ended) await products.captureImported(ctx, productJob, jobId, ended.asset)
    else await products.captureImportEnded(ctx, productJob, jobId, ended.error)
  } catch (error) {
    console.error('[studio] filing a product capture failed:', error instanceof Error ? error.message : error)
  }
}

/** The kinds that spend at a provider: their charge is recorded whenever the worker says it spent. */
export const PAID_KINDS: readonly string[] = ['shot', 'narration', 'revoice', 'sound-effect', 'music']

/**
 * A paid job's result that arrives after the job was taken from its worker (its heartbeat went stale and it ended
 * failed, migration 625): the provider may have charged, so the charge the result carries is recorded in the ledger
 * (keyed by the job, so once), and nothing is placed on the video. Only from the worker that held it last. Never throws.
 */
async function chargeLateResult(deps: WorkerDeps, jobId: string, workerId: string, result: unknown): Promise<void> {
  try {
    if (!isUuid(jobId) || !result || typeof result !== 'object' || Array.isArray(result)) return
    const row = must(await deps.supabase.from('studio_job').select('*').eq('id', jobId).maybeSingle(), 'read that job') as JobRow | null
    if (!row || !PAID_KINDS.includes(row.kind) || row.worker_id !== workerId || row.status === 'running' || row.status === 'completed') return
    const ctx = jobContext(deps, row)
    if (row.kind === 'shot') await (await import('./generation')).recordShotCharge(ctx, row, result as Record<string, unknown>)
    else if (row.kind === 'narration') await (await import('./voiceover')).recordNarrationCharge(ctx, row, result as Record<string, unknown>)
    else await (await import('./voice-media')).recordPaidCharge(ctx, row, result as Record<string, unknown>)
  } catch (error) {
    console.error('[studio] recording a late charge failed:', error instanceof Error ? error.message : error)
  }
}

/**
 * Remove the upload an import, slides or sound-import job was given (missing is fine; a failure to remove is logged, the
 * sweep retries). A track of a take uploaded while it was recorded (`live/…`, live-takes.ts) goes only once it is
 * `imported`: a recording brought back after a crash keeps its pieces when its import fails, until the sweep.
 */
async function dropUpload(deps: WorkerDeps, row: Pick<JobRow, 'id' | 'kind' | 'workspace_id'>, imported = false): Promise<void> {
  if (row.kind !== 'import' && row.kind !== 'slides' && row.kind !== 'sound-import') return
  try {
    const found = must(await deps.supabase.from('studio_job').select('upload:input->>uploadKey').eq('id', row.id).maybeSingle(), 'read that job') as { upload: string | null } | null
    if (found?.upload && /^uploads\/[0-9a-f-]{36}$/.test(found.upload)) await deleteBlob(jobContext(deps, row), found.upload)
    else if (found?.upload && imported && row.kind === 'import' && found.upload.startsWith('live/')) await (await import('./live-takes')).dropLiveTrack(jobContext(deps, row), found.upload)
  } catch (error) {
    console.error('[studio] removing an upload failed:', error instanceof Error ? error.message : error)
  }
}

/** An import that belongs to a recording (its provenance names it) ended: the recording is told (recordings.ts). Never throws. */
async function settleRecording(deps: WorkerDeps, row: Pick<JobRow, 'id' | 'workspace_id'>): Promise<void> {
  try {
    const found = must(await deps.supabase.from('studio_job').select('provenance:input->provenance').eq('id', row.id).maybeSingle(), 'read that job') as { provenance: { recording?: unknown } | null } | null
    const recording = found?.provenance?.recording
    if (typeof recording !== 'string') return
    await (await import('./recordings')).recordingImportEnded(deps.supabase, deps.storage, row.workspace_id, recording)
  } catch (error) {
    console.error('[studio] finishing a recording failed:', error instanceof Error ? error.message : error)
  }
}

/**
 * An asset a worker's result names, checked against what the job stored before anything registers it: it is named
 * by its bytes' hash (id = sha256), stored under that hash (`assets/<sha256>.<ext>`), and the blob there is that
 * many bytes with that hash. Answers the asset as parsed, or the sentence that refuses the result. Every result kind
 * that registers an asset goes through this.
 */
export async function ownAsset(ctx: StudioContext, value: unknown, what = 'file'): Promise<EditorAsset> {
  const asset = EditorAssetSchema.parse(value)
  if (asset.id !== asset.sha256) throw new StudioError(`The ${what} is not named by its contents.`)
  const key = ASSET_KEY.exec(asset.file)
  if (!key || key[1] !== asset.sha256) throw new StudioError(`The ${what} is not stored under its contents.`)
  const stored = await getBlob(ctx, asset.file)
  if (!stored) throw new StudioError(`The worker did not store the ${what}.`)
  if (stored.bytes !== asset.bytes || stored.sha256 !== asset.sha256) throw new StudioError(`The stored ${what} is not the file the worker described.`)
  return asset
}

/** A committed blob of the job's workspace under one of the job's own keys, or the sentence that refuses the result. */
export async function ownBlob(ctx: StudioContext, key: unknown, prefix: string, what: string): Promise<StoredBlob> {
  if (typeof key !== 'string' || !key.startsWith(prefix) || key.includes('..')) throw new StudioError(`The worker stored the ${what} outside this job's files.`)
  const blob = await getBlob(ctx, key)
  if (!blob) throw new StudioError(`The worker did not store the ${what}.`)
  return blob
}

const object = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError(`The ${what} result is not an object.`)
  return value as Record<string, unknown>
}

/** File what a finished job made, by kind; answers the result to keep on the row. */
async function fileResult(ctx: StudioContext, row: JobRow, raw: unknown): Promise<Record<string, unknown>> {
  const result = object(raw, row.kind)
  switch (row.kind) {
    case 'import': {
      const input = row.input as ImportInput
      const registered = await registerAsset(ctx, await ownAsset(ctx, result.asset, 'imported file'))
      // The upload itself is removed once the job is recorded as done (completeJob).
      const upload = input.conform ? await getBlob(ctx, input.uploadKey).catch(() => null) : null
      return { asset: registered, ...(input.conform ? { rawBytes: upload?.bytes ?? 0, rawSha256: upload?.sha256 ?? '' } : {}) }
    }
    case 'export': {
      // Under this attempt's own folder (job-contract.ts), so a worker that lost the job can't stand in for the next.
      const out = result as ExportResult
      await ownBlob(ctx, out.key, `exports/${row.id}/${row.attempts}/`, 'exported video')
      return result
    }
    case 'thumbnail': {
      // Exactly the key the job was given.
      const key = (row.input as { key?: string }).key
      if (!key || result.key !== key) throw new StudioError("The worker stored the thumbnail outside this job's files.")
      await ownBlob(ctx, result.key, key, 'thumbnail')
      return result
    }
    case 'stills': {
      const stills = (result as { stills?: unknown }).stills
      if (!Array.isArray(stills)) throw new StudioError('A stills result lists its frames.')
      for (const still of stills) await ownBlob(ctx, (still as { key?: unknown } | null)?.key, `stills/${row.id}/`, 'frame')
      return result
    }
    case 'transcribe': {
      const out = result as TranscribeResult
      if (out.outcome === 'transcribed') {
        const transcript: EditorTranscript = await registerTranscript(ctx, out.transcript)
        return { outcome: 'transcribed', transcript }
      }
      if (out.outcome !== 'no-speech' && out.outcome !== 'no-audio') throw new StudioError('A transcription ends transcribed, no-speech or no-audio.')
      return { outcome: out.outcome }
    }
    case 'slides': {
      const input = row.input as SlidesInput
      const out = result as SlidesResult
      if (!out.deck || !Array.isArray(out.pages) || !out.pages.length) throw new StudioError('A slide deck has at least one page.')
      // Every page checked against what the job stored before any is registered.
      const checked: EditorAsset[] = []
      for (const page of out.pages) checked.push(await ownAsset(ctx, page, 'slide page'))
      const pages: EditorAsset[] = []
      for (const page of checked) pages.push(await registerAsset(ctx, page))
      const deck = {
        schemaVersion: 1 as const,
        id: String(out.deck.id),
        name: String(out.deck.name || input.name).slice(0, 250),
        pageAssetIds: pages.map((p) => p.id),
        width: Number(out.deck.width),
        height: Number(out.deck.height),
        createdAt: new Date().toISOString(),
      }
      await putRecord(ctx, COLLECTIONS.slides, deck.id, deck)
      // The upload is removed once the job is recorded as done (completeJob).
      return { deck, pages }
    }
    // The paid providers' jobs are filed by their own modules (loaded here, as they import this one).
    case 'voices':
      return (await import('./voiceover')).fileVoices(ctx, result)
    case 'narration':
      return (await import('./voiceover')).fileNarration(ctx, row, result)
    case 'shot':
      return (await import('./generation')).fileShot(ctx, row, result)
    // The voice provider's other work (voice-media.ts): a search's voices kept; a spend's charge, assets and cache.
    case 'voice-search':
      return (await import('./voice-media')).fileVoiceSearch(ctx, result)
    case 'revoice':
    case 'sound-effect':
    case 'music':
      return (await import('./voice-media')).filePaidAudio(ctx, row, result)
    // Vision's (vision.ts): cut-outs registered and attached to the video, face tracks cached by the recording's bytes.
    case 'cutout':
      return (await import('./vision')).fileCutout(ctx, row, result)
    case 'faces':
      return (await import('./vision')).fileFaces(ctx, row, result)
    // Sound design's (sound.ts): the sounds registered and applied to the video, the listening report, the bank kept.
    case 'sounds':
      return (await import('./sound')).fileSounds(ctx, row, result)
    case 'sound-import':
      return (await import('./sound')).fileSoundImport(ctx, row, result)
    case 'listen':
      return (await import('./sound')).fileListen(ctx, row, result)
    case 'sound-bank':
      return (await import('./sound')).fileSoundBank(ctx, result)
    // Judging and making sounds (sound-judge.ts): the judgement checked again; made sounds checked, then registered.
    case 'sound-judge':
      return (await import('./sound-judge')).fileSoundJudge(row, result)
    case 'sound-make':
      return (await import('./sound-judge')).fileSoundMake(ctx, row, result)
    // The measured checks: kept as the video's latest of each kind (checks.ts).
    case 'motion':
    case 'review':
    case 'look':
      return (await import('./checks')).fileCheck(ctx, row, result)
    // Ads from a brand kit: images registered and the batch filed, a motion ad made an editable video (ads.ts).
    case 'ads-static':
    case 'ads-motion':
    case 'ads-reel':
      return (await import('./ads')).fileAdsResult(ctx, row, result)
    default:
      return result
  }
}
