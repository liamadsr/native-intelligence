/**
 * The merge as a database job (migration 417).
 *
 * `merge_workspace` on a large workspace runs past the service role's 120 s
 * statement_timeout (Corvanne on PROD: about two minutes, most of it re-stamping
 * eleven thousand claim embeddings whose vector index is rebuilt row by row),
 * and a PostgREST call that long is cut at the HTTP edge (~100 s) anyway. So
 * the route enqueues instead: `merge_workspace_enqueue` checks the gate, writes
 * a `workspace_merge_job` row and wakes the pg_cron runner, which runs
 * `merge_workspace` as postgres with no statement timeout and records the
 * outcome on the row in the same transaction: the merge and its `done`, or
 * nothing and its `failed` with the errcode. The route then waits for the row.
 */
import type { getServiceClient } from '@/lib/admin'
import type { RpcError } from './errors'

type Service = ReturnType<typeof getServiceClient>

/** How often the route reads the job row while the runner works. */
export const JOB_POLL_MS = 1_500

/** A job the route lost track of (its enqueue answer never arrived) is looked for this far back. */
const RECENT_JOB_MS = 10 * 60_000

export type MergeJobOutcome =
  | { status: 'done'; result: Record<string, unknown> }
  | { status: 'failed'; error: RpcError }
  | { status: 'pending' }

interface JobRow {
  status: string
  result: Record<string, unknown> | null
  error_code: string | null
  error_message: string | null
}

/**
 * Read the job row until it is done or failed, or until waiting longer would
 * pass `deadline` (epoch ms). A failed read is retried: the job runs on in the
 * database whatever happens to this request.
 */
export async function waitForMergeJob(
  service: Service,
  jobId: string,
  deadline: number,
  opts: { pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MergeJobOutcome> {
  const pollMs = opts.pollMs ?? JOB_POLL_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (;;) {
    const { data, error } = await service
      .from('workspace_merge_job')
      .select('status, result, error_code, error_message')
      .eq('id', jobId)
      .maybeSingle()
    if (!error && data) {
      const row = data as JobRow
      if (row.status === 'done') return { status: 'done', result: row.result ?? {} }
      if (row.status === 'failed') return { status: 'failed', error: { code: row.error_code, message: row.error_message } }
    }
    if (now() + pollMs > deadline) return { status: 'pending' }
    await sleep(pollMs)
  }
}

/**
 * The enqueue's answer never arrived (no errcode: the connection dropped), but
 * the job may have been written. Only the job THIS request queued counts: the
 * one carrying its snapshot (an earlier attempt's job, failed or still running,
 * is not this request's outcome).
 */
export async function findRecentMergeJob(
  service: Service,
  sourceWorkspaceId: string,
  destinationWorkspaceId: string,
  actorUserId: string,
  snapshotId: string,
  now: () => number = Date.now,
): Promise<string | null> {
  const { data, error } = await service
    .from('workspace_merge_job')
    .select('id')
    .eq('source_workspace_id', sourceWorkspaceId)
    .eq('destination_workspace_id', destinationWorkspaceId)
    .eq('actor_user_id', actorUserId)
    .eq('plan->snapshot->>snapshot_id', snapshotId)
    .gte('created_at', new Date(now() - RECENT_JOB_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  return (data as { id: string }).id
}

/**
 * Whether a merge of this source is already waiting or running (the enqueue
 * would refuse it with P0010): checked before the snapshot, so a second click
 * does not export the whole workspace only to throw it away.
 */
export async function hasQueuedMergeJob(service: Service, sourceWorkspaceId: string): Promise<boolean> {
  const { data, error } = await service
    .from('workspace_merge_job')
    .select('id')
    .eq('source_workspace_id', sourceWorkspaceId)
    .eq('status', 'queued')
    .limit(1)
    .maybeSingle()
  return !error && Boolean(data)
}
