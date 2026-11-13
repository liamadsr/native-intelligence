// A Studio export run on the person's own computer, in the desktop app (job-contract.ts `local-export`): queued by
// the person's signed-in editor, worked by the desktop app with a token for that one job (local-token.ts). The rows,
// progress, completion and failure are the server worker's own (jobs.ts): the token's attempt stands in for the
// worker id. What the computer may read and write is fenced tighter than the shared worker's: only the files the
// frozen project names, and only this attempt's video.
//
// The SQL around a studio_job treats the kind as any other (migrations 620, 625, 627, 631, which check no kind):
// studio_queue_job counts it in the workspace's 20 open jobs, not in its 5 exports; the stale rule in
// studio_claim_job (run whenever a server worker asks for work) puts a running one whose computer went quiet for
// 180 s back in the queue, and fails it after 3 attempts. Back in the queue it waits: no server worker asks for this
// kind. The person's computer takes it again by id, or the person moves it to the server (moveToServer).
import { checkOpenJobs, completeJob, failJob, fromLight, jobContext, LIGHT_FIELDS, reportProgress, toEditorJob, type JobRow, type LightRow, type WorkerDeps } from './jobs'
import { ASSET_KEY, checkBlobKey, commitBlob, createBlobWrite, deleteBlob, getBlob, readBlob, storageOf } from './blobs'
import { isUuid, must, type StudioContext } from './context'
import { conflictError, notFoundError, StudioError } from './errors'
import { blobObject, LOCAL_EXPORT_MAX_BYTES, type BlobRead, type BlobWrite, type ExportResult, type LocalExportInput, type LocalProgress, type LocalTaken } from './job-contract'
import { localWorkerId, signLocalToken, type LocalTokenClaims } from './local-token'
import type { EditorJob } from '../engine/api'
import type { EditorProject } from '../engine/contracts'

/** Where a local export's attempt stores its video: the only key it may write. */
export const localExportKey = (job: { id: string; attempts: number }) => `exports/${job.id}/${job.attempts}/video.mp4`

/** A local job's row as its computer works it, with its input. */
type LocalRow = JobRow & { input: LocalExportInput & Record<string, unknown> }

/** The refusal for anything the token may not do (one answer: nothing about the job is told). */
const notYours = () => conflictError('This computer does not hold that export any more.', 'NOT_HELD')

/**
 * The job a token names, read again on every call: this person's, in this workspace, still a local export, and the
 * person still a member who is not a guest. `held`: and running under the token's own attempt.
 */
export async function localJob(deps: WorkerDeps, claims: LocalTokenClaims, options: { held?: boolean } = {}): Promise<LocalRow> {
  const found = must(await deps.supabase.from('studio_job').select('*').eq('id', claims.jid).eq('workspace_id', claims.wid).maybeSingle(), 'read that job') as LocalRow | null
  if (!found || found.kind !== 'local-export' || found.created_by !== claims.uid) throw notYours()
  const member = must(await deps.supabase.from('member').select('role').eq('workspace_id', claims.wid).eq('user_id', claims.uid).maybeSingle(), 'check the workspace') as { role: string | null } | null
  if (!member || member.role === 'guest') throw new StudioError("You're no longer a member of this workspace, so its exports aren't yours to make.", 403, 'FORBIDDEN')
  if (options.held && (!claims.w || found.worker_id !== claims.w || found.status !== 'running')) throw notYours()
  return found
}

/** A token for a local job of the person's (the editor hands it to the desktop app). Only theirs, and not ended. */
export async function localToken(ctx: StudioContext, jobId: string): Promise<{ token: string; expiresAt: string }> {
  if (!isUuid(jobId) || !ctx.userId) throw notFoundError('Job not found')
  const row = must(await ctx.supabase.from('studio_job').select('id, kind, status, created_by').eq('workspace_id', ctx.workspaceId).eq('id', jobId).maybeSingle(), 'read that job') as Pick<JobRow, 'id' | 'kind' | 'status' | 'created_by'> | null
  if (!row || row.kind !== 'local-export' || row.created_by !== ctx.userId) throw notFoundError('Job not found')
  if (row.status !== 'queued' && row.status !== 'running') throw conflictError('That export has ended.', 'ENDED')
  return signLocalToken({ jid: row.id, uid: ctx.userId, wid: ctx.workspaceId })
}

/**
 * Take a queued local job onto this computer: running, under a new attempt (`local:<uid>:<nonce>`), its attempts one
 * more. Only from queued (a first take, or after the stale rule put it back), only the person's own, and not one
 * they asked to stop. Answers the job and the token that now holds it.
 */
export async function takeLocalJob(deps: WorkerDeps, claims: LocalTokenClaims): Promise<LocalTaken> {
  const row = await localJob(deps, claims)
  if (row.status !== 'queued' || row.cancel_requested) throw conflictError(row.status === 'running' ? 'That export is running elsewhere already.' : 'That export has ended.', row.status === 'running' ? 'NOT_HELD' : 'ENDED')
  const workerId = localWorkerId(claims.uid)
  const now = new Date().toISOString()
  // Compare-and-set on what was read: two computers taking at once, one wins.
  const taken = must(
    await deps.supabase.from('studio_job')
      .update({ status: 'running', worker_id: workerId, attempts: row.attempts + 1, claimed_at: now, heartbeat_at: now, updated_at: now })
      .eq('id', row.id).eq('workspace_id', claims.wid).eq('created_by', claims.uid).eq('kind', 'local-export').eq('status', 'queued').eq('cancel_requested', false).eq('attempts', row.attempts)
      .select('id'),
    'take that export',
  ) as { id: string }[] | null
  if (!taken?.length) throw conflictError('That export was taken or changed just now.', 'NOT_HELD')
  const { token, expiresAt } = signLocalToken({ jid: row.id, uid: claims.uid, wid: claims.wid, w: workerId })
  return { job: { id: row.id, kind: 'local-export', workspaceId: row.workspace_id, videoId: row.video_id, input: row.input, attempts: row.attempts + 1 }, token, expiresAt }
}

/** Progress from the computer: recorded as a worker's, answered with a cancel request and a fresh token. */
export async function localProgress(deps: WorkerDeps, claims: LocalTokenClaims, body: { progress: number; log?: string }): Promise<LocalProgress> {
  await localJob(deps, claims, { held: true })
  const { cancelRequested } = await reportProgress(deps, claims.jid, { workerId: claims.w!, progress: body.progress, ...(body.log ? { log: body.log } : {}) })
  return { cancelRequested, ...signLocalToken({ jid: claims.jid, uid: claims.uid, wid: claims.wid, w: claims.w }) }
}

/** The computer finished: filed as a worker's export is (jobs.ts completeJob, fileLocalExport below). */
export async function localComplete(deps: WorkerDeps, claims: LocalTokenClaims, result: ExportResult): Promise<{ ok: true }> {
  await localJob(deps, claims, { held: true })
  return completeJob(deps, claims.jid, claims.w!, result)
}

/** The computer failed or stopped (a cancel ends cancelled, jobs.ts failJob). */
export async function localFail(deps: WorkerDeps, claims: LocalTokenClaims, error: string): Promise<{ ok: true }> {
  await localJob(deps, claims, { held: true })
  return failJob(deps, claims.jid, claims.w!, error)
}

/** The files a frozen export draws on: its library files (`assets/<sha256>.<ext>`) and its font faces (`fonts/…`). Pure. */
export function localReadable(input: Pick<LocalExportInput, 'project' | 'fonts'>): Set<string> {
  const keys = new Set<string>()
  for (const asset of (input.project as EditorProject | undefined)?.assets ?? []) if (typeof asset?.file === 'string' && ASSET_KEY.test(asset.file)) keys.add(asset.file)
  for (const face of input.fonts ?? []) if (typeof face?.file === 'string' && face.file.startsWith('fonts/') && !face.file.includes('..')) keys.add(face.file)
  return keys
}

/** A read link to a file the job's frozen project names, and to nothing else. */
export async function localRead(deps: WorkerDeps, claims: LocalTokenClaims, key: string): Promise<BlobRead> {
  const row = await localJob(deps, claims, { held: true })
  key = checkBlobKey(key)
  if (!localReadable(row.input).has(key)) throw conflictError('That file is not one this export uses.', 'NOT_YOURS')
  return readBlob(jobContext(deps, row), key)
}

/** Upload links for this attempt's video, and nothing else: its own key, at most LOCAL_EXPORT_MAX_BYTES, an MP4. */
export async function localWrite(deps: WorkerDeps, claims: LocalTokenClaims, body: { key: string; bytes: number; contentType: string }): Promise<BlobWrite> {
  const row = await localJob(deps, claims, { held: true })
  if (checkBlobKey(body.key) !== localExportKey(row)) throw conflictError("That is not where this export's video is stored.", 'NOT_YOURS')
  if (body.contentType !== 'video/mp4') throw new StudioError('An export is stored as an MP4 video.', 400, 'INVALID')
  if (!Number.isSafeInteger(body.bytes) || body.bytes < 1 || body.bytes > LOCAL_EXPORT_MAX_BYTES) throw new StudioError('That video is larger than an export may be.', 413, 'TOO_LARGE')
  return createBlobWrite(jobContext(deps, row), { key: body.key, bytes: body.bytes, contentType: 'video/mp4' })
}

/** True when bytes start the way an MP4 does: a box whose type is `ftyp`. Pure. */
export function startsLikeMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const size = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  return String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!) === 'ftyp' && size >= 8
}

/** Record this attempt's uploaded video, once its first bytes are an MP4's (else it is removed and refused). */
export async function localCommit(deps: WorkerDeps, claims: LocalTokenClaims, key: string): Promise<{ ok: true }> {
  const row = await localJob(deps, claims, { held: true })
  if (checkBlobKey(key) !== localExportKey(row)) throw conflictError("That is not where this export's video is stored.", 'NOT_YOURS')
  const ctx = jobContext(deps, row)
  const head = await storageOf(ctx).head(blobObject(ctx.workspaceId, key, 0), 12).catch(() => new Uint8Array(0))
  if (!startsLikeMp4(head)) {
    await deleteBlob(ctx, key).catch(() => undefined)
    throw new StudioError('What was uploaded is not an MP4 video.', 422, 'NOT_MP4')
  }
  await commitBlob(ctx, key)
  return { ok: true }
}

/**
 * A finished local export, filed (jobs.ts fileResult): exactly this attempt's video, stored and committed, as many
 * bytes as the result says, and its measures plausible. Anything else refuses the result and the job fails.
 */
export async function fileLocalExport(ctx: StudioContext, row: JobRow, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = raw as Partial<ExportResult>
  if (result.key !== localExportKey(row)) throw new StudioError("The computer stored the exported video outside this export's files.")
  const blob = await getBlob(ctx, result.key)
  if (!blob) throw new StudioError('The computer did not store the exported video.')
  if (blob.bytes !== result.bytes || blob.contentType !== 'video/mp4') throw new StudioError('The stored video is not the file the computer described.')
  const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0
  if (!positive(result.width) || !positive(result.height) || !positive(result.fps) || !(typeof result.durationSeconds === 'number' && result.durationSeconds >= 0)) throw new StudioError('The export result does not say what the video is.')
  return { key: result.key, bytes: result.bytes, width: result.width, height: result.height, fps: result.fps, durationSeconds: result.durationSeconds }
}

/**
 * "Finish on the server": a queued local export of the person's becomes an ordinary export, which the server's
 * worker takes. Only from queued (a running one is the computer's until it ends or goes quiet), only their own, and
 * only within the workspace's export cap (an export counts there, a local one does not).
 */
export async function moveToServer(ctx: StudioContext, jobId: string): Promise<{ job: EditorJob }> {
  if (!isUuid(jobId) || !ctx.userId) throw notFoundError('Job not found')
  const row = must(await ctx.supabase.from('studio_job').select(LIGHT_FIELDS).eq('workspace_id', ctx.workspaceId).eq('id', jobId).maybeSingle(), 'read that job') as LightRow | null
  if (!row || row.kind !== 'local-export' || row.created_by !== ctx.userId) throw notFoundError('Job not found')
  if (row.status !== 'queued' || row.cancel_requested) throw conflictError(row.status === 'running' ? 'This export is running on your computer. Stop it there first, or wait for it.' : 'That export has ended.', row.status === 'running' ? 'RUNNING' : 'ENDED')
  await checkOpenJobs(ctx, 'export')
  const moved = must(
    await ctx.supabase.from('studio_job').update({ kind: 'export', worker_id: null, updated_at: new Date().toISOString() })
      .eq('id', jobId).eq('workspace_id', ctx.workspaceId).eq('created_by', ctx.userId).eq('kind', 'local-export').eq('status', 'queued').eq('cancel_requested', false)
      .select(LIGHT_FIELDS),
    'move that export',
  ) as LightRow[] | null
  if (!moved?.length) throw conflictError('That export was taken or changed just now.', 'CHANGED')
  return { job: toEditorJob(fromLight(moved[0]!)) }
}
