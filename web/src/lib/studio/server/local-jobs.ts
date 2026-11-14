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
import { cancelJob, completeJob, endUntakenLocalExports, failJob, jobContext, queueJob, reportProgress, toEditorJob, type JobRow, type WorkerDeps } from './jobs'
import { ASSET_KEY, checkBlobKey, commitBlob, createBlobWrite, getBlob, PENDING, readBlob, storageOf } from './blobs'
import { isUuid, must, type StudioContext } from './context'
import { conflictError, notFoundError, StudioError } from './errors'
import { blobObject, LOCAL_EXPORT_MAX_BYTES, MAX_OPEN_LOCAL_EXPORTS, type BlobRead, type BlobWrite, type ExportInput, type ExportResult, type LocalExportInput, type LocalKeptResult, type LocalProgress, type LocalTaken } from './job-contract'
import { localWorkerId, signLocalToken, type LocalTokenClaims } from './local-token'
import { getRecord, putRecord } from './records'
import type { EditorJob } from '../engine/api'
import type { EditorProject } from '../engine/contracts'
import { projectDuration } from '../engine/timeline'

/** Where a local export's attempt stores its video: the only key it may write. */
export const localExportKey = (job: { id: string; attempts: number }) => `exports/${job.id}/${job.attempts}/video.mp4`

/** A local job's row as its computer works it, with its input. */
type LocalRow = JobRow & { input: LocalExportInput & Record<string, unknown>; claimed_at?: string | null; heartbeat_at?: string | null }

/** The refusal for anything the token may not do (one answer: nothing about the job is told). */
const notYours = () => conflictError('This computer does not hold that export any more.', 'NOT_HELD')

/** Reads one attempt may ask for: three for each file its project names (retries), and ten more. */
export const readAllowance = (files: number) => 3 * files + 10
/** The fewest milliseconds between two progress reports taken. */
export const LOCAL_PROGRESS_EVERY_MS = 1000
/** How long one attempt may run: an hour at least, else ten times the video's length (a slow computer, a long video). */
export const LOCAL_RUN_FLOOR_MS = 60 * 60_000
export const LOCAL_RUN_PER_VIDEO = 10
/** Where an attempt's reads are counted (studio_record; the sweep clears them with the job). */
export const LOCAL_READS = 'local-reads'

/** How long an attempt of this export may run. Pure. */
export function localRunLimit(input: Pick<LocalExportInput, 'project'>): number {
  let seconds = 2 * 3600
  try {
    const project = input.project as EditorProject
    seconds = projectDuration(project) / project.output.fps
  } catch {
    // A project that can't be measured is given two hours' worth.
  }
  return Math.max(LOCAL_RUN_FLOOR_MS, LOCAL_RUN_PER_VIDEO * seconds * 1000)
}

/** A path on the computer in text (macOS, Linux, Windows drive or share, a file URL). */
const LOCAL_PATH = /(?:file:\/\/\S*|(?<![A-Za-z])[A-Za-z]:[\\/][^\s'"]*|\\\\[^\s'"]+|(?<![\w.])\/(?:Users|home|private|var|tmp|Volumes|opt|mnt|root|Library|Applications|System|etc|usr|srv|media|run)(?:\/[^\s'"]*)?|~\/[^\s'"]*)/g

/**
 * Text from the computer (a failure, a log line) as the Studio keeps and shows it: every path on that computer taken
 * out (they can name the person's folders and account), control characters too, at most `max` characters. The
 * desktop app takes paths out on its side as well; this is the server's own guard. Pure.
 */
export function scrubLocalText(text: string, max: number): string {
  const clean = text.replace(LOCAL_PATH, '[a file on the computer]').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * The job a token names, read again on every call: this person's, in this workspace, still a local export, the
 * workspace's Studio switched on, and the person still a member who is not a guest. `held`: and running under the
 * token's own attempt, within its time.
 */
export async function localJob(deps: WorkerDeps, claims: LocalTokenClaims, options: { held?: boolean } = {}): Promise<LocalRow> {
  const found = must(await deps.supabase.from('studio_job').select('*').eq('id', claims.jid).eq('workspace_id', claims.wid).maybeSingle(), 'read that job') as LocalRow | null
  if (!found || found.kind !== 'local-export' || found.created_by !== claims.uid) throw notYours()
  const member = must(await deps.supabase.from('member').select('role').eq('workspace_id', claims.wid).eq('user_id', claims.uid).maybeSingle(), 'check the workspace') as { role: string | null } | null
  if (!member || member.role === 'guest') throw new StudioError("You're no longer a member of this workspace, so its exports aren't yours to make.", 403, 'FORBIDDEN')
  // The Studio switch, as every signed-in Studio request honours it (auth.ts).
  const { studioSwitchedOn } = await import('./auth')
  if (!(await studioSwitchedOn(deps.supabase, claims.wid))) throw new StudioError('The Studio is not enabled for this workspace.', 403, 'FEATURE_DISABLED')
  if (options.held && (!claims.w || found.worker_id !== claims.w || found.status !== 'running')) throw notYours()
  if (options.held && Date.now() - Date.parse(found.claimed_at ?? found.created_at) > localRunLimit(found.input)) {
    await failJob(deps, found.id, claims.w!, 'This export ran longer than an export on a computer may. Export it again, or on our server.').catch(() => undefined)
    throw conflictError('This export ran longer than an export on a computer may.', 'TOO_LONG')
  }
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

/**
 * Progress from the computer, at most once every LOCAL_PROGRESS_EVERY_MS: recorded as a worker's (its log line with
 * the computer's paths taken out), answered with a cancel request and a fresh token.
 */
export async function localProgress(deps: WorkerDeps, claims: LocalTokenClaims, body: { progress: number; log?: string }): Promise<LocalProgress> {
  const row = await localJob(deps, claims, { held: true })
  // The first report after the take is always taken (the take stamps both times alike).
  const last = row.heartbeat_at && row.heartbeat_at !== row.claimed_at ? Date.parse(row.heartbeat_at) : 0
  if (Date.now() - last < LOCAL_PROGRESS_EVERY_MS) throw new StudioError('Progress comes at most once a second.', 429, 'TOO_FAST')
  const log = body.log ? scrubLocalText(body.log, 300) : ''
  const { cancelRequested } = await reportProgress(deps, claims.jid, { workerId: claims.w!, progress: body.progress, ...(log ? { log } : {}) })
  return { cancelRequested, ...signLocalToken({ jid: claims.jid, uid: claims.uid, wid: claims.wid, w: claims.w }) }
}

/** The computer finished: filed as a worker's export is (jobs.ts completeJob, fileLocalExport below). */
export async function localComplete(deps: WorkerDeps, claims: LocalTokenClaims, result: ExportResult | LocalKeptResult): Promise<{ ok: true }> {
  await localJob(deps, claims, { held: true })
  return completeJob(deps, claims.jid, claims.w!, result)
}

/** The computer failed or stopped (a cancel ends cancelled, jobs.ts failJob); its sentence kept without its paths. */
export async function localFail(deps: WorkerDeps, claims: LocalTokenClaims, error: string): Promise<{ ok: true }> {
  await localJob(deps, claims, { held: true })
  return failJob(deps, claims.jid, claims.w!, scrubLocalText(error, 500) || 'The Studio app on the computer stopped without saying why.')
}

/** The files a frozen export draws on: its library files (`assets/<sha256>.<ext>`) and its font faces (`fonts/…`). Pure. */
export function localReadable(input: Pick<LocalExportInput, 'project' | 'fonts'>): Set<string> {
  const keys = new Set<string>()
  for (const asset of (input.project as EditorProject | undefined)?.assets ?? []) if (typeof asset?.file === 'string' && ASSET_KEY.test(asset.file)) keys.add(asset.file)
  for (const face of input.fonts ?? []) if (typeof face?.file === 'string' && face.file.startsWith('fonts/') && !face.file.includes('..')) keys.add(face.file)
  return keys
}

/**
 * Count one read of an attempt against its allowance (readAllowance of the files its project names), in the database
 * so every process of the app counts the same. A compare-and-set on the count; two reads at once may cost one retry.
 */
async function countRead(ctx: StudioContext, row: LocalRow, files: number): Promise<void> {
  const key = `${row.id}:${row.attempts}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const kept = await getRecord<{ reads: number }>(ctx, LOCAL_READS, key)
    const reads = Number(kept?.reads) || 0
    if (reads >= readAllowance(files)) throw new StudioError('This export has asked for its files too many times.', 429, 'TOO_MANY_READS')
    if (!kept) {
      await putRecord(ctx, LOCAL_READS, key, { reads: 1 })
      return
    }
    const moved = must(
      await ctx.supabase.from('studio_record').update({ value: { reads: reads + 1 }, updated_at: new Date().toISOString() })
        .eq('workspace_id', ctx.workspaceId).eq('collection', LOCAL_READS).eq('key', key).eq('value->>reads', String(reads)).select('key'),
      'count a read',
    ) as { key: string }[] | null
    if (moved?.length) return
  }
  throw new StudioError('Too many reads at once for this export.', 429, 'TOO_MANY_READS')
}

/** A read link to a file the job's frozen project names, and to nothing else, within the attempt's allowance. */
export async function localRead(deps: WorkerDeps, claims: LocalTokenClaims, key: string): Promise<BlobRead> {
  const row = await localJob(deps, claims, { held: true })
  key = checkBlobKey(key)
  const readable = localReadable(row.input)
  if (!readable.has(key)) throw conflictError('That file is not one this export uses.', 'NOT_YOURS')
  const ctx = jobContext(deps, row)
  await countRead(ctx, row, readable.size)
  return readBlob(ctx, key)
}

/**
 * Upload links for this attempt's video, and nothing else: its own key, at most LOCAL_EXPORT_MAX_BYTES, an MP4; once
 * per attempt (none pending under the key, none stored: one set of links an attempt). The links never replace a part
 * already stored, so what is committed stays what was checked.
 */
export async function localWrite(deps: WorkerDeps, claims: LocalTokenClaims, body: { key: string; bytes: number; contentType: string }): Promise<BlobWrite> {
  const row = await localJob(deps, claims, { held: true })
  const key = checkBlobKey(body.key)
  if (key !== localExportKey(row)) throw conflictError("That is not where this export's video is stored.", 'NOT_YOURS')
  if (body.contentType !== 'video/mp4') throw new StudioError('An export is stored as an MP4 video.', 400, 'INVALID')
  if (!Number.isSafeInteger(body.bytes) || body.bytes < 1 || body.bytes > LOCAL_EXPORT_MAX_BYTES) throw new StudioError('That video is larger than an export may be.', 413, 'TOO_LARGE')
  const ctx = jobContext(deps, row)
  const pending = must(await ctx.supabase.from('studio_record').select('key').eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).eq('key', key).maybeSingle(), 'check the upload') as { key: string } | null
  if (pending) throw conflictError('This export is uploading its video already. Upload it to the links it was given, then commit.', 'WRITE_PENDING')
  if (await getBlob(ctx, key)) throw conflictError("This export's video is stored already.", 'STORED')
  return createBlobWrite(ctx, { key, bytes: body.bytes, contentType: 'video/mp4', upsert: false })
}

/** True when bytes start the way an MP4 does: a box whose type is `ftyp`. Pure. */
export function startsLikeMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const size = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  return String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!) === 'ftyp' && size >= 8
}

/**
 * Record this attempt's uploaded video, once its first bytes are an MP4's. A refused one is left as it is: its
 * pending write keeps holding its space and its parts keep their places (the links can't store over them), until
 * the sweep removes both after the links have run out (sweep.ts). Removing them now would let the links store the
 * parts again, outside anything the Studio counts.
 */
export async function localCommit(deps: WorkerDeps, claims: LocalTokenClaims, key: string): Promise<{ ok: true }> {
  const row = await localJob(deps, claims, { held: true })
  if (checkBlobKey(key) !== localExportKey(row)) throw conflictError("That is not where this export's video is stored.", 'NOT_YOURS')
  const ctx = jobContext(deps, row)
  const head = await storageOf(ctx).head(blobObject(ctx.workspaceId, key, 0), 12).catch(() => new Uint8Array(0))
  if (!startsLikeMp4(head)) throw new StudioError('What was uploaded is not an MP4 video.', 422, 'NOT_MP4')
  await commitBlob(ctx, key)
  return { ok: true }
}

/**
 * A finished local export, filed (jobs.ts fileResult): exactly this attempt's video, stored and committed, as many
 * bytes as the result says, and its measures plausible. Anything else refuses the result and the job fails.
 */
export async function fileLocalExport(ctx: StudioContext, row: JobRow, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0
  // Kept on the computer (uploading switched off there): its facts, nothing stored, nothing to download.
  if (raw.kept === 'computer') {
    const kept = raw as Partial<LocalKeptResult>
    if (raw.key !== undefined || !positive(kept.bytes) || !positive(kept.width) || !positive(kept.height) || !positive(kept.fps) || !(typeof kept.durationSeconds === 'number' && kept.durationSeconds >= 0)) throw new StudioError('The export result does not say what the video is.')
    return { kept: 'computer', bytes: kept.bytes, width: kept.width, height: kept.height, fps: kept.fps, durationSeconds: kept.durationSeconds }
  }
  const result = raw as Partial<ExportResult>
  if (result.key !== localExportKey(row)) throw new StudioError("The computer stored the exported video outside this export's files.")
  const blob = await getBlob(ctx, result.key)
  if (!blob) throw new StudioError('The computer did not store the exported video.')
  if (blob.bytes !== result.bytes || blob.contentType !== 'video/mp4') throw new StudioError('The stored video is not the file the computer described.')
  if (!positive(result.width) || !positive(result.height) || !positive(result.fps) || !(typeof result.durationSeconds === 'number' && result.durationSeconds >= 0)) throw new StudioError('The export result does not say what the video is.')
  return { key: result.key, bytes: result.bytes, width: result.width, height: result.height, fps: result.fps, durationSeconds: result.durationSeconds }
}

/**
 * "Finish on the server": a NEW export of the same edit is queued for the server's worker through the one queue
 * function (its lock and its caps, the export cap included), then the person's queued local export is stopped, only if
 * it is still queued. When a computer took it meanwhile, the new export is stopped again and the answer is RUNNING.
 * The editor follows the new job (`replaces` names the one it stood in for). A new job starts with its own attempts.
 */
export async function moveToServer(ctx: StudioContext, jobId: string): Promise<{ job: EditorJob; replaces: string }> {
  if (!isUuid(jobId) || !ctx.userId) throw notFoundError('Job not found')
  const row = must(await ctx.supabase.from('studio_job').select('*').eq('workspace_id', ctx.workspaceId).eq('id', jobId).maybeSingle(), 'read that job') as LocalRow | null
  if (!row || row.kind !== 'local-export' || row.created_by !== ctx.userId) throw notFoundError('Job not found')
  const running = () => conflictError('This export is running on your computer. Stop it there first, or wait for it.', 'RUNNING')
  if (row.status === 'running') throw running()
  if (row.status !== 'queued' || row.cancel_requested) throw conflictError('That export has ended.', 'ENDED')
  const { renderVersion: _renderVersion, ...input } = row.input
  void _renderVersion
  const server = await queueJob(ctx, 'export', { ...(input as ExportInput & Record<string, unknown>), source: 'editor' }, row.video_id)
  const stopped = must(
    await ctx.supabase.from('studio_job').update({ status: 'cancelled', cancel_requested: true, error: 'Moved to our server.', updated_at: new Date().toISOString() })
      .eq('id', jobId).eq('workspace_id', ctx.workspaceId).eq('created_by', ctx.userId).eq('kind', 'local-export').eq('status', 'queued').eq('cancel_requested', false)
      .select('id'),
    'move that export',
  ) as { id: string }[] | null
  if (!stopped?.length) {
    await cancelJob(ctx, server.id)
    throw running()
  }
  return { job: toEditorJob(server), replaces: jobId }
}

/**
 * Queue-time limit of an export on a computer: one person has at most MAX_OPEN_LOCAL_EXPORTS open (those no computer
 * took in time are ended first, so they never count).
 */
export async function checkOpenLocalExports(ctx: StudioContext): Promise<void> {
  await endUntakenLocalExports(ctx.supabase, ctx.workspaceId)
  const open = must(
    await ctx.supabase.from('studio_job').select('id').eq('workspace_id', ctx.workspaceId).eq('created_by', ctx.userId).eq('kind', 'local-export').in('status', ['queued', 'running']).limit(MAX_OPEN_LOCAL_EXPORTS),
    'count your exports',
  ) as { id: string }[] | null
  if ((open?.length ?? 0) >= MAX_OPEN_LOCAL_EXPORTS) throw new StudioError(`You already have ${MAX_OPEN_LOCAL_EXPORTS} exports waiting for or running on your computer. Wait for one to finish, or finish one on our server.`, 429, 'TOO_MANY_LOCAL')
}
