/**
 * Workspace-wide cancel of in-flight WORK runs — the fan-out behind the
 * autonomy kill switch (docs/plans/agent-orchestration-product.md, pre-step 1:
 * "Stop must stop"). Flipping a workspace's `agent_autonomy.mode` to 'off' must
 * halt the runs already going, not only refuse new attempts.
 *
 * Mechanics mirror the per-run Stop route
 * (`/api/account/actions/[id]/agent-runs/[runId]/cancel`): each run is CAS'd
 * from an in-flight status to `canceling` — which the work watcher's
 * cancel-signal poll observes and aborts its drain on — and one
 * `agent/run.cancel` event per run hands the settle (row → canceled, action →
 * idle, ledger → canceled, pending_input cleared) and the eve session cancel to
 * agentRunCancel. A run that settled in the gap loses the CAS and is skipped.
 *
 * `origins` narrows the sweep to runs of those `agent_run.origin` values (an
 * auto-attempted run is `'attempt'`). The column lands with Sequence step 2;
 * until then callers pass nothing and the switch cancels every in-flight work
 * run in the workspace, which is the safe reading of "off".
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'

/** agent_run statuses a workspace sweep may cancel (queued, running, parked). */
export const WORK_RUN_IN_FLIGHT_STATUSES = ['queued', 'running', 'needs_input'] as const

/** The event the kill switch emits; consumed by workspaceAutonomyOff. */
export const WORKSPACE_AUTONOMY_OFF_EVENT = 'workspace/autonomy.off' as const

export const AUTONOMY_OFF_REASON = 'Canceled: agent autonomy was switched off for this workspace'

export interface CancelInFlightWorkRunsArgs {
  workspaceId: string
  /** Lands in agent_run.error_message and the ledger row's reason. */
  reason?: string
  /** Only runs with these `agent_run.origin` values; absent = every in-flight work run. */
  origins?: readonly string[]
}

export interface CancelInFlightWorkRunsResult {
  /** Runs flipped to `canceling` and handed to agentRunCancel. */
  requested: string[]
  /** In-flight runs found that lost the CAS (settled in the gap). */
  skipped: string[]
}

export async function cancelInFlightWorkRuns(
  supabase: SupabaseClient,
  args: CancelInFlightWorkRunsArgs,
): Promise<CancelInFlightWorkRunsResult> {
  const reason = args.reason?.trim() || AUTONOMY_OFF_REASON
  let query = supabase
    .from('agent_run')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('kind', 'workspace')
    .in('status', [...WORK_RUN_IN_FLIGHT_STATUSES])
  if (args.origins && args.origins.length > 0) {
    query = query.in('origin', [...args.origins])
  }
  const { data, error } = await query
  if (error) throw new Error(`cancelInFlightWorkRuns: ${error.message}`)

  const requested: string[] = []
  const skipped: string[] = []
  for (const row of data ?? []) {
    const id = row.id as string
    // The same CAS the per-run Stop route makes: only a still-in-flight row
    // flips; a row that settled meanwhile is left to its terminal winner.
    const { data: flipped } = await supabase
      .from('agent_run')
      .update({ status: 'canceling' })
      .eq('id', id)
      .eq('workspace_id', args.workspaceId)
      .in('status', [...WORK_RUN_IN_FLIGHT_STATUSES])
      .select('id')
    if (flipped && flipped.length > 0) requested.push(id)
    else skipped.push(id)
  }

  if (requested.length > 0) {
    await inngest.send(
      requested.map((id) => ({
        name: 'agent/run.cancel' as const,
        data: { agent_run_id: id, workspace_id: args.workspaceId, reason },
      })),
    )
  }
  return { requested, skipped }
}

/**
 * Emit the kill-switch event. The autonomy settings write (Sequence step 9, the
 * settings surface) calls this when `agent_autonomy.mode` transitions to 'off';
 * the Inngest function `workspaceAutonomyOff` runs cancelInFlightWorkRuns.
 */
export async function requestWorkspaceAutonomyOff(args: {
  workspaceId: string
  reason?: string
  origins?: readonly string[]
}): Promise<void> {
  await inngest.send({
    name: WORKSPACE_AUTONOMY_OFF_EVENT,
    data: {
      workspace_id: args.workspaceId,
      ...(args.reason ? { reason: args.reason } : {}),
      ...(args.origins && args.origins.length > 0 ? { origins: [...args.origins] } : {}),
    },
  })
}
