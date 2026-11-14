// The door for an export run on the person's own computer (local-jobs.ts): POST /api/local-agent/studio-export/<op>,
// JSON, `Authorization: Bearer <token>` (local-token.ts), never a cookie and never the worker secret. In order: the
// token is checked before anything is read; then its job's calls are counted (LOCAL_CALLS_PER_MINUTE); then the body
// is read under LOCAL_BODY_MAX_BYTES and checked against its op's shape (job-contract.ts); then the job is read again
// and fenced (local-jobs.ts localJob). Kept apart from the route file so tests can call it with their own clients.
import type { z } from 'zod'
import { apiError, badRequest, notFound, rateLimited, unauthorized } from '@/lib/api-errors'
import { readCappedBody } from './product-mac'
import { LocalBlobCommitBody, LocalBlobReadBody, LocalBlobWriteBody, LocalCompleteBody, LocalFailBody, LocalProgressBody, LocalTakeBody } from './job-contract'
import { localComplete, localCommit, localFail, localProgress, localRead, localWrite, takeLocalJob } from './local-jobs'
import { verifyLocalToken, type LocalTokenClaims } from './local-token'
import type { WorkerDeps } from './jobs'
import { errorResponse } from './router'

/** The largest body a computer sends (a progress line, a result: a few hundred bytes). */
export const LOCAL_BODY_MAX_BYTES = 64 * 1024
/**
 * A coarse guard on every call of one job's token, per process: 600 a minute. Each operation has its own allowance on
 * top, kept in the database so every process counts the same (local-jobs.ts: one write an attempt, reads by the files
 * the project names, progress once a second).
 */
export const LOCAL_CALLS_PER_MINUTE = 600

const calls = new Map<string, { at: number; count: number }>()

/** Count a call for a job; false once it is past this minute's allowance. */
export function countLocalCall(jobId: string, now = Date.now()): boolean {
  const window = calls.get(jobId)
  if (!window || now - window.at >= 60_000) {
    // Windows past their minute are dropped, never the live ones.
    if (calls.size > 5000) for (const [id, kept] of calls) if (now - kept.at >= 60_000) calls.delete(id)
    calls.set(jobId, { at: now, count: 1 })
    return true
  }
  window.count++
  return window.count <= LOCAL_CALLS_PER_MINUTE
}

/** Forget the counts (tests). */
export const resetLocalCalls = () => calls.clear()

type Op = { schema: z.ZodTypeAny; run: (deps: WorkerDeps, claims: LocalTokenClaims, body: never) => Promise<unknown> }

const OPS: Record<string, Op> = {
  take: { schema: LocalTakeBody, run: (deps, claims) => takeLocalJob(deps, claims) },
  progress: { schema: LocalProgressBody, run: (deps, claims, body: z.infer<typeof LocalProgressBody>) => localProgress(deps, claims, body) },
  complete: { schema: LocalCompleteBody, run: (deps, claims, body: z.infer<typeof LocalCompleteBody>) => localComplete(deps, claims, body.result) },
  fail: { schema: LocalFailBody, run: (deps, claims, body: z.infer<typeof LocalFailBody>) => localFail(deps, claims, body.error) },
  'blobs/read': { schema: LocalBlobReadBody, run: (deps, claims, body: z.infer<typeof LocalBlobReadBody>) => localRead(deps, claims, body.key) },
  'blobs/write': { schema: LocalBlobWriteBody, run: (deps, claims, body: z.infer<typeof LocalBlobWriteBody>) => localWrite(deps, claims, body) },
  'blobs/commit': { schema: LocalBlobCommitBody, run: (deps, claims, body: z.infer<typeof LocalBlobCommitBody>) => localCommit(deps, claims, body.key) },
}

/** Answer one call of a computer working a local job. */
export async function handleLocalRunner(request: Request, segments: string[], deps: WorkerDeps): Promise<Response> {
  // Who is asking, before anything else of the request is read.
  const header = request.headers.get('authorization') ?? ''
  const checked = verifyLocalToken(header.startsWith('Bearer ') ? header.slice(7) : '')
  if (!checked.ok) {
    if (checked.reason === 'unconfigured') return apiError('Exports on your computer are not set up here.', { status: 503, code: 'LOCAL_OFF' })
    return unauthorized(checked.reason === 'expired' ? 'That export token has run out. Ask the Studio for a new one.' : 'Unauthorized')
  }
  // Every call of the token counts, a wrong one too (a loop gone wrong).
  if (!countLocalCall(checked.claims.jid)) return rateLimited('Too many calls for this export. Slow down and try again in a minute.')
  if (request.method !== 'POST') return apiError('That method is not allowed here.', { status: 405, code: 'METHOD_NOT_ALLOWED' })
  const op = Object.hasOwn(OPS, segments.join('/')) ? OPS[segments.join('/')] : undefined
  if (!op) return notFound('Not found')
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > LOCAL_BODY_MAX_BYTES) return apiError('Too large', { status: 413, code: 'TOO_LARGE' })
  const bytes = await readCappedBody(request, LOCAL_BODY_MAX_BYTES)
  if (!bytes) return apiError('Too large', { status: 413, code: 'TOO_LARGE' })
  let raw: unknown
  try {
    const text = new TextDecoder().decode(bytes)
    raw = JSON.parse(text || '{}')
  } catch {
    return badRequest('Invalid JSON body')
  }
  const parsed = op.schema.safeParse(raw)
  if (!parsed.success) return badRequest('Invalid request', parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })))
  try {
    return Response.json(await op.run(deps, checked.claims, parsed.data as never), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}
