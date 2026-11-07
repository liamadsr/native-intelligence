/**
 * The merge RPCs' errcodes (migration 402) mapped onto HTTP, in one place.
 *
 * Raw Postgres messages can interpolate workspace ids and counts, so every
 * branch answers with a fixed string and logs the original server-side. The
 * two plan errors are the exception: their messages hold only fixed text and
 * the slug or prefix the person typed, and the dialog needs them to say which
 * team is the problem. The codes:
 *
 *   P0002  not found, or the caller has no membership on one side (the
 *          engine's anti-oracle: indistinguishable from "does not exist")
 *   42501  role: merging needs the owner of both workspaces
 *   22023  source and destination are the same workspace
 *   P0003  a destination team has no default workflow state (a fold target)
 *   P0006  the plan is invalid or stale: a slug or prefix is taken or not
 *          valid, a team vanished, a mode is unknown
 *   P0007  the source is busy: a live capture, a running agent run, flow run
 *          or tracked job
 *   P0008  an assertion failed: a step was about to delete source rows that
 *          something still references (408's guard), rows were left under the
 *          source, or the destination fails the sweep — the transaction rolled back
 *   P0009  pre-existing drift on either side: the repair has to run first
 *   P0010  a merge of this source is already waiting to run (the job, 417)
 *   P0011  the job waited past its expiry without running: nothing changed
 *   P0012  the job's run died without an outcome (a terminated backend):
 *          failed rather than re-run; nothing changed
 *   P0013  the pg_cron runner could not be scheduled: nothing was queued
 *   23505  a uniqueness the merge does not resolve (the generic re-stamp)
 *   22P02  a malformed uuid (a workspace or team id)
 *   40P01  deadlock, 40001 serialization, 55P03 lock not available: another
 *          change ran at the same time; nothing changed, a retry is fine
 *   57014  the statement timed out (the preflight's 120 s; the merge job runs
 *          without a limit): nothing changed
 *   PGRST202  PostgREST's schema cache does not know the function yet
 */
import { apiError, badRequest, conflict, forbidden, notFound, serverError } from '@/lib/api-errors'

export interface RpcError {
  code?: string | null
  message?: string | null
  details?: string | null
}

/** Which RPC the error came from, for the log line and the wording. */
export type MergeRpcScope = 'merge_workspace_preflight' | 'merge_workspace'

export function mergeRpcErrorResponse(scope: MergeRpcScope, error: RpcError): Response {
  const code = error.code || undefined
  const rawMessage = error.message ?? ''
  const step = scope === 'merge_workspace_preflight' ? 'preflight' : 'merge'

  switch (code) {
    case 'P0002':
      return notFound('Workspace not found')
    case '42501':
      return forbidden('Only the owner of both workspaces can merge them')
    case '22023':
      return badRequest('Source and destination workspace are the same')
    case '22P02':
      return badRequest('A workspace or team id in the request is malformed')
    case 'P0003':
      return badRequest('That destination team has no default status; pick another team to fold into', { reason: rawMessage })
    case 'P0006':
      return conflict('The plan is not valid any more; review the teams and try again', { reason: rawMessage }, 'PLAN_INVALID')
    case 'P0007':
      return conflict('The source workspace is busy (a live capture or a running job); try again when it is idle', undefined, 'SOURCE_BUSY')
    case 'P0009':
      return conflict('A workspace fails the integrity check and needs the repair first; nothing was changed', undefined, 'DRIFT')
    case 'P0010':
      return conflict('A merge of this workspace is already running; wait for it to finish', undefined, 'MERGE_IN_PROGRESS')
    case 'P0011':
      console.error(`[${scope}] the merge job expired before it ran:`, rawMessage)
      return apiError('The merge did not start in time; nothing was changed, try again', { status: 503, code: 'MERGE_EXPIRED' })
    case 'P0012':
      console.error(`[${scope}] the merge job was interrupted:`, rawMessage)
      return apiError('The merge was interrupted; nothing was changed, try again', { status: 503, code: 'MERGE_INTERRUPTED' })
    case 'P0013':
      console.error(`[${scope}] the merge runner could not be scheduled:`, rawMessage)
      return apiError('Merge temporarily unavailable; nothing was changed, try again shortly', { status: 503, code: 'MERGE_RUNNER_UNAVAILABLE' })
    case 'P0008':
      console.error(`[${scope}] assertion failed, transaction rolled back:`, rawMessage)
      return apiError('The merge checked itself and stopped; nothing was changed', { status: 500, code: 'MERGE_ASSERTION' })
    case '23505':
      console.error(`[${scope}] unique violation:`, rawMessage)
      return conflict('Merge failed: a conflicting record already exists in the destination workspace; nothing was changed', undefined, 'MERGE_CONFLICT')
    case '40P01':
    case '40001':
    case '55P03':
      console.error(`[${scope}] lock or serialization failure (${code}):`, rawMessage)
      return conflict(`Another change was running at the same time; nothing was changed, try the ${step} again`, undefined, 'MERGE_RETRY')
    case '57014':
      console.error(`[${scope}] statement timeout:`, rawMessage)
      return apiError(
        step === 'merge' ? 'The merge took too long and was rolled back; nothing was changed' : 'The preflight took too long; try again',
        { status: 503, code: 'MERGE_TIMEOUT' },
      )
    case 'PGRST202':
      console.error(`[${scope}] PostgREST schema cache stale — run NOTIFY pgrst, 'reload schema'`)
      return apiError('Merge temporarily unavailable, please retry shortly', { status: 503, code: 'SCHEMA_CACHE_STALE' })
    default:
      break
  }

  // An older PostgREST, or a proxy, may carry the text without the code.
  if (!code && /could not find the function/i.test(rawMessage)) {
    console.error(`[${scope}] PostgREST schema cache stale — run NOTIFY pgrst, 'reload schema'`)
    return apiError('Merge temporarily unavailable, please retry shortly', { status: 503, code: 'SCHEMA_CACHE_STALE' })
  }

  console.error(`[${scope}] unexpected RPC error:`, code, rawMessage)
  return serverError(step === 'preflight' ? 'Preflight failed' : 'Merge failed')
}
