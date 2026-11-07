/**
 * POST /api/account/workspace/merge
 *
 * Merge another workspace (the source) into the current one (the
 * destination). Body:
 *
 *   { source_workspace_id: uuid, destination_workspace_id: uuid,
 *     plan: { teams: [...] }, confirm_name: string }
 *
 * `destination_workspace_id` is the workspace the dialog is open in and must
 * be the one this request resolves to; `plan` is the preflight's plan with the
 * person's team choices; `confirm_name` must be the source workspace's name
 * as typed in the dialog (a stray call never merges anything). In order:
 *
 *   1. the gate: a signed-in owner of both workspaces, never a device token,
 *      the destination pinned (the RPC re-checks the roles inside);
 *   2. the preflight again, server-side: a blocker (busy source, drift)
 *      answers 409 before anything is written;
 *   3. the typed name must be the source's;
 *   4. the snapshot: every table of the source, paged by bytes along the
 *      primary key, into the private `workspace-merges` bucket; the merge
 *      never runs without a complete one;
 *   5. `merge_workspace` (migration 402), one transaction, with the plan the
 *      preflight normalised and the snapshot's location, so the merge record
 *      keeps it — run as a database job (migration 417,
 *      lib/workspace-merge/job.ts): `merge_workspace_enqueue` checks the gate
 *      and queues it, a pg_cron runner runs it with no statement timeout, and
 *      this request waits for the job's outcome. The engine refusing (busy,
 *      drift, a stale plan) removes the snapshot again. An enqueue answer with
 *      no Postgres errcode (the connection dropped) looks for the job it may
 *      have queued and waits for that;
 *   6. this browser's workspace cookie moves to the destination (device and
 *      MCP tokens were re-pointed inside the merge), and every other
 *      destination member hears about it through the agent.
 *
 * The response is the merge's result plus the snapshot summary; the client
 * then runs finishWorkspaceMerge (lib/workspace-merge/after-merge.ts) to sweep
 * its local state and land in the destination.
 */
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, conflict, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { WORKSPACE_COOKIE } from '@/lib/workspace'
import { gateMerge, refuseDeviceToken } from '@/lib/workspace-merge/auth'
import { mergeRpcErrorResponse } from '@/lib/workspace-merge/errors'
import { findRecentMergeJob, hasQueuedMergeJob, waitForMergeJob } from '@/lib/workspace-merge/job'
import { announceWorkspaceMerge } from '@/lib/workspace-merge/notice'
import { removeSnapshot, snapshotWorkspace, SnapshotError, type SnapshotSummary } from '@/lib/workspace-merge/snapshot'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

/** A large workspace is many snapshot pages plus a merge job of a few minutes (Corvanne on PROD: about two). */
export const maxDuration = 800
/** Stop waiting for the job this long before the function's limit, to answer in time. */
const ANSWER_MARGIN_MS = 20_000

interface PreflightResult {
  ok?: boolean
  blockers?: unknown[]
  source?: { id?: string; name?: string }
  destination?: { id?: string; name?: string }
  plan?: Record<string, unknown>
}

interface MergeResult {
  merge_id?: string
  source?: { id?: string; name?: string }
  destination?: { id?: string; name?: string }
  counts?: Record<string, unknown>
  rows_before?: Record<string, number>
  duration_ms?: number
}

export async function POST(req: Request) {
  const started = Date.now()
  const device = refuseDeviceToken(req)
  if (device) return device
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { user, workspaceId: destinationWorkspaceId, member } = auth

  let body: { source_workspace_id?: unknown; destination_workspace_id?: unknown; plan?: unknown; confirm_name?: unknown } | null = null
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (body?.plan === null || typeof body?.plan !== 'object' || Array.isArray(body.plan)) {
    return badRequest('plan is required (the preflight’s plan with your team choices)')
  }
  if (typeof body.confirm_name !== 'string' || body.confirm_name.trim().length === 0) {
    return badRequest('confirm_name is required: type the source workspace’s name')
  }

  // 1. the gate
  const service = getServiceClient()
  const gate = await gateMerge({
    service,
    userId: user.id,
    destinationWorkspaceId,
    destinationRole: member.role,
    claimedDestinationId: body.destination_workspace_id,
    sourceWorkspaceId: body.source_workspace_id,
  })
  if (gate instanceof Response) return gate
  const plan = body.plan as Record<string, unknown>

  // 2. the preflight, server-side, with the person's plan
  const pre = await service.rpc('merge_workspace_preflight', {
    p_source: gate.sourceWorkspaceId,
    p_destination: destinationWorkspaceId,
    p_actor: user.id,
    p_plan: plan,
  })
  if (pre.error) return mergeRpcErrorResponse('merge_workspace_preflight', pre.error)
  const preflight = (pre.data ?? {}) as PreflightResult

  // 3. the typed name
  const sourceName = preflight.source?.name ?? ''
  if (sourceName.trim().toLowerCase() !== (body.confirm_name as string).trim().toLowerCase()) {
    return badRequest('confirm_name does not match the source workspace’s name')
  }
  if (preflight.ok !== true) {
    return conflict('The merge cannot start yet', { blockers: preflight.blockers ?? [] }, 'MERGE_BLOCKED')
  }
  if (await hasQueuedMergeJob(service, gate.sourceWorkspaceId)) {
    // a merge of this source is already waiting or running: answer before exporting it again
    return mergeRpcErrorResponse('merge_workspace', { code: 'P0010', message: 'a merge of this workspace is already waiting to run' })
  }

  // 4. the snapshot
  let snapshot: SnapshotSummary
  try {
    snapshot = await snapshotWorkspace(service, gate.sourceWorkspaceId)
  } catch (err) {
    const step = err instanceof SnapshotError ? err.step : 'unknown'
    console.error('[merge_workspace] snapshot failed, merge not started', step, err instanceof Error ? err.message : err)
    return serverError('The snapshot of the source workspace could not be stored; nothing was changed')
  }

  // 5. the merge, as a job, with the plan the preflight normalised (every team's mode, name, slug and prefix explicit) — `snapshot` is ours
  const normalised = preflight.plan && typeof preflight.plan === 'object' ? preflight.plan : plan
  const enqueued = await service.rpc('merge_workspace_enqueue', {
    p_source: gate.sourceWorkspaceId,
    p_destination: destinationWorkspaceId,
    p_actor: user.id,
    p_plan: { ...normalised, snapshot },
  })
  let jobId = typeof enqueued.data === 'string' ? enqueued.data : null
  if (enqueued.error) {
    jobId = enqueued.error.code
      ? null
      : await findRecentMergeJob(service, gate.sourceWorkspaceId, destinationWorkspaceId, user.id, snapshot.snapshot_id)
    if (!jobId) {
      // Refused before anything was queued: a snapshot of a workspace that still exists is just storage.
      await removeSnapshot(service, snapshot).catch(() => 0)
      return mergeRpcErrorResponse('merge_workspace', enqueued.error)
    }
    console.error('[merge_workspace] the enqueue answer was lost; waiting for the job it queued:', jobId)
  }
  if (!jobId) {
    await removeSnapshot(service, snapshot).catch(() => 0)
    return serverError('Merge failed')
  }
  const outcome = await waitForMergeJob(service, jobId, started + maxDuration * 1000 - ANSWER_MARGIN_MS)
  if (outcome.status === 'failed') {
    // The engine refused or rolled back.
    await removeSnapshot(service, snapshot).catch(() => 0)
    return mergeRpcErrorResponse('merge_workspace', outcome.error)
  }
  if (outcome.status === 'pending') {
    // Still running in the database: it commits or rolls back on its own, so the snapshot stays.
    console.error('[merge_workspace] the job outlasted this request; it finishes in the database:', jobId)
    return apiError('The merge is still running and finishes on its own; reload in a few minutes', { status: 504, code: 'MERGE_STILL_RUNNING' })
  }
  const result = outcome.result as MergeResult

  // 6. this browser follows; everyone else hears about it
  const cookieStore = await cookies()
  cookieStore.set(WORKSPACE_COOKIE, destinationWorkspaceId, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })
  const told = await announceWorkspaceMerge(service, {
    destinationWorkspaceId,
    actorMemberId: member.id,
    sourceName: result.source?.name ?? sourceName,
    destinationName: result.destination?.name ?? preflight.destination?.name ?? '',
    mergeId: result.merge_id ?? '',
    rowsBefore: result.rows_before ?? {},
  })

  return NextResponse.json({ ok: true, merge: result, snapshot, members_told: told })
}
