/**
 * The one message an answered flow-step card sends its parked run (F4): the
 * approval's id, the run's id and the outcome. flow-step-resume.ts carries
 * the run on (or ends it) from it. Kept apart so approvals.ts can send it
 * without loading the runner.
 */
import { inngest } from '@/lib/inngest/client'

/** The event an answered flow-step card sends. */
export const FLOW_STEP_SETTLED_EVENT = 'flow/step.settled'

/** How a parked step's card was answered (or lapsed). */
export type FlowStepOutcome = 'approved' | 'denied' | 'expired' | 'paused' | 'failed'

/**
 * Tell a flow step's parked run its card was answered (or lapsed). Only a
 * 'flow_step' approval has a run to tell. Best effort: a lost event leaves the
 * run 'pending' until the card's expiry sweep sends 'expired'.
 */
export async function notifyFlowStepSettled(
  row: { id: string; door?: string | null; context?: { flowStep?: { flow_run_id?: string } } | null; flow_run_id?: string | null },
  outcome: FlowStepOutcome,
  send: (event: { name: string; data: Record<string, unknown> }) => Promise<unknown> = (e) => inngest.send(e),
): Promise<void> {
  if (row.door !== 'flow_step') return
  const flowRunId = row.flow_run_id ?? row.context?.flowStep?.flow_run_id ?? null
  if (!flowRunId) return
  await send({ name: FLOW_STEP_SETTLED_EVENT, data: { approval_id: row.id, flow_run_id: flowRunId, outcome } })
}
