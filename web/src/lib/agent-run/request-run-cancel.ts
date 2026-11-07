/**
 * The write half of Stop, shared by both cancel routes (the action-scoped
 * `/api/account/actions/[id]/agent-runs/[runId]/cancel` and the run-scoped
 * `/api/account/agent-runs/[id]/cancel` for runs with no tracked action, such as
 * an auto-attempted run). Each route does its own RLS-scoped read — that read is
 * the authorization — and its terminal pre-check, then calls this.
 *
 * Flips the run to `canceling` for immediate UI feedback through the SERVICE
 * client (member UPDATE RLS on agent_run is dropped, mig 200), CAS-guarded on a
 * non-terminal status so a run that settled in the gap is never resurrected to
 * `canceling` (agentRunCancel would finalize it `canceled` and clobber a real
 * deliverable). Only a flip that took emits `agent/run.cancel`, which cancels
 * the Inngest execute function (its cancelOn) and has agentRunCancel stop the
 * sandbox or eve session and settle the run.
 */
import { getServiceClient } from '@/lib/supabase/service'
import { inngest } from '@/lib/inngest/client'

/** Statuses a run can no longer be stopped from. */
export const RUN_CANCEL_TERMINAL_STATUSES = ['pr_open', 'completed', 'failed', 'canceled'] as const

/** True when the flip took and the cancel event was sent; false when the run had already finished. */
export async function requestAgentRunCancel(args: { runId: string; workspaceId: string }): Promise<boolean> {
  const { runId, workspaceId } = args
  const service = getServiceClient()
  const { data: flipped } = await service
    .from('agent_run')
    .update({ status: 'canceling' })
    .eq('id', runId)
    .eq('workspace_id', workspaceId)
    .not('status', 'in', `(${RUN_CANCEL_TERMINAL_STATUSES.join(',')})`)
    .select('id')
  if (!flipped || flipped.length === 0) return false
  await inngest.send({
    name: 'agent/run.cancel',
    data: { agent_run_id: runId, workspace_id: workspaceId },
  })
  return true
}
