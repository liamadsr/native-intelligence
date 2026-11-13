// The two doors into the Studio over HTTP: the person's (src/app/api/account/studio/[...path]) and the worker's
// (src/app/api/internal/studio/*). Each resolves who is asking, then hands the request to the plain functions of
// this folder. Kept apart from the route files so tests can call them with their own clients.
import type { z } from 'zod'
import { apiError, badRequest, notFound, unauthorized } from '@/lib/api-errors'
import { conflictError } from './errors'
import { checkBlobKey, commitBlob, createBlobWrite, dropPendingWrite, getBlob, readBlob, workerWriteFence } from './blobs'
import { noteWorker } from './capabilities'
import type { StudioContext } from './context'
import { serveBlob, type PartFetch } from './files'
import { BlobCommitBody, BlobReadBody, BlobWriteBody, ClaimBody, CompleteBody, FailBody, ProgressBody } from './job-contract'
import { claimJob, completeJob, failJob, heldJob, jobContext, reportProgress, type WorkerDeps } from './jobs'
import { dispatch, errorResponse } from './router'
import { studioRoutes } from './routes'
import { checkWorkerAuth } from './worker-auth'

/** Answer a person's Studio request (everything under /api/account/studio but files). */
export function handleStudio(request: Request, segments: string[], ctx: StudioContext): Promise<Response> {
  return dispatch(studioRoutes, request, segments, ctx)
}

/**
 * Answer GET /file/<workspace>/<key…>: the stored file, streamed with byte ranges. `authorize` checks the person
 * is a member of that workspace (the request carries only the session cookie).
 */
export async function handleFile(
  request: Request,
  segments: string[],
  authorize: (workspaceId: string) => Promise<StudioContext | Response>,
  options: { fetchPart?: PartFetch } = {},
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return apiError('That method is not allowed here.', { status: 405, code: 'METHOD_NOT_ALLOWED' })
  const [workspaceId, ...rest] = segments
  if (!workspaceId || !rest.length) return notFound('Not found')
  const ctx = await authorize(workspaceId)
  if (ctx instanceof Response) return ctx
  try {
    const key = checkBlobKey(rest.map((s) => decodeURIComponent(s)).join('/'))
    const blob = await getBlob(ctx, key)
    // An export is kept 30 days (sweep.ts): its link then says so.
    if (!blob) return notFound(key.startsWith('exports/') ? 'This export is no longer kept: exports are kept for 30 days. Export the video again.' : 'There is no file under that key.')
    const download = new URL(request.url).searchParams.get('download')
    return await serveBlob(ctx, blob, request, { download, fetchPart: options.fetchPart })
  } catch (error) {
    return errorResponse(error)
  }
}

/** The largest worker request (a finished transcription's words). */
const WORKER_MAX_BODY_BYTES = 16 * 1024 * 1024

/** A worker request, its secret checked and its body parsed, or the answer that refuses it. */
export async function workerBody<S extends z.ZodTypeAny>(request: Request, schema: S): Promise<z.infer<S> | Response> {
  const auth = checkWorkerAuth(request)
  if (auth === 'off') return apiError('The Studio worker is not set up here (STUDIO_WORKER_SECRET is not set).', { status: 503, code: 'WORKER_OFF' })
  if (auth === 'refused') return unauthorized()
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > WORKER_MAX_BODY_BYTES) return apiError('Too large', { status: 413 })
  const text = await request.text()
  if (text.length > WORKER_MAX_BODY_BYTES) return apiError('Too large', { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(text || '{}')
  } catch {
    return badRequest('Invalid JSON body')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) return badRequest('Invalid request', parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })))
  return parsed.data
}

async function run(work: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await work(), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}

/** POST jobs/claim {workerId, kinds} → {job | null}. */
export async function workerClaim(request: Request, deps: WorkerDeps): Promise<Response> {
  const body = await workerBody(request, ClaimBody)
  if (body instanceof Response) return body
  noteWorker(body.workerId, body.capabilities)
  return run(async () => ({ job: await claimJob(deps, body.workerId, body.kinds) }))
}

/** POST jobs/<id>/progress {workerId, progress, log?} → {cancelRequested}. */
export async function workerProgress(request: Request, jobId: string, deps: WorkerDeps): Promise<Response> {
  const body = await workerBody(request, ProgressBody)
  if (body instanceof Response) return body
  noteWorker(body.workerId, body.capabilities)
  return run(() => reportProgress(deps, jobId, body))
}

/** POST jobs/<id>/complete {workerId, result} → {ok: true} (422 when what it made can't be filed). */
export async function workerComplete(request: Request, jobId: string, deps: WorkerDeps): Promise<Response> {
  const body = await workerBody(request, CompleteBody)
  if (body instanceof Response) return body
  return run(() => completeJob(deps, jobId, body.workerId, body.result))
}

/** POST jobs/<id>/fail {workerId, error} → {ok: true}. */
export async function workerFail(request: Request, jobId: string, deps: WorkerDeps): Promise<Response> {
  const body = await workerBody(request, FailBody)
  if (body instanceof Response) return body
  return run(() => failJob(deps, jobId, body.workerId, body.error))
}

/**
 * POST blobs/read {jobId, workerId, key} → BlobRead, inside the held job's workspace. A take's track (`live/…`) only
 * for the job that names it as its upload: a worker never reads another recording of the workspace through it.
 */
export async function workerBlobRead(request: Request, deps: WorkerDeps): Promise<Response> {
  const body = await workerBody(request, BlobReadBody)
  if (body instanceof Response) return body
  return run(async () => {
    const live = body.key.startsWith('live/')
    const job = await heldJob(deps, body.jobId, body.workerId, live)
    if (live && (job.input as { uploadKey?: unknown } | null)?.uploadKey !== body.key) throw conflictError("That recording is not this job's to read.", 'NOT_YOURS')
    return readBlob(jobContext(deps, job), body.key)
  })
}

/**
 * POST blobs/write {jobId, workerId, key, bytes, contentType, sha256?} → BlobWrite, inside the held job's workspace,
 * fenced (blobs.ts workerWriteFence): a committed file is replaced only under the job's own keys; a library file
 * already stored answers `{exists: true}` with no parts (nothing to send again).
 */
export async function workerBlobWrite(request: Request, deps: WorkerDeps): Promise<Response> {
  const body = await workerBody(request, BlobWriteBody)
  if (body instanceof Response) return body
  return run(async () => {
    const job = await heldJob(deps, body.jobId, body.workerId)
    const ctx = jobContext(deps, job)
    const { exists } = await workerWriteFence(ctx, job, body.key, { sha256: body.sha256 ?? null })
    if (exists) return { key: exists.key, partBytes: exists.partBytes, parts: [], exists: true }
    return createBlobWrite(ctx, { key: body.key, bytes: body.bytes, contentType: body.contentType, sha256: body.sha256 ?? null })
  })
}

/** POST blobs/commit {jobId, workerId, key} → {ok: true}, inside the held job's workspace, fenced as the write is. */
export async function workerBlobCommit(request: Request, deps: WorkerDeps): Promise<Response> {
  const body = await workerBody(request, BlobCommitBody)
  if (body instanceof Response) return body
  return run(async () => {
    const job = await heldJob(deps, body.jobId, body.workerId)
    const ctx = jobContext(deps, job)
    // A library file stored already is there: its row is not written again (a write still pending under it goes).
    const { exists } = await workerWriteFence(ctx, job, body.key)
    if (exists) await dropPendingWrite(ctx, exists.key)
    else await commitBlob(ctx, body.key)
    return { ok: true }
  })
}
