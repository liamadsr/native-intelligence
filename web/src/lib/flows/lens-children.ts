/**
 * The steps AFTER a lens step, when the lens rode Triage's read of the call
 * (F4 + F3). A riding lens flow runs no skill of its own: its lens step's
 * row is written from what its section delivered on the host's run
 * (lens-runs.ts recordLensRides). Its other steps (a call_tool that logs the
 * objections to Notion, say) still run, once, right after, with the lens
 * step's output: what the lens kept from this call (lensFindingsText). A lens
 * that kept nothing passes nothing on, so the steps that use it are skipped
 * (runner.ts), never run with an empty input. A lens flow with no other step
 * costs nothing here.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { keepRunState } from './flow-step-resume'
import { lensFindingsText } from './lens-runs'
import { legacySnapshotFromResults } from './run-record'
import { capStepOutput } from './redact'
import { runFlow, type FireExtras, type FlowExecutors } from './runner'
import type { ActionResult, FlowAction, FlowRunStatus, TriggerContext } from './types'

export async function runLensChildren(
  supabase: SupabaseClient,
  args: {
    flow: { id: string; created_by: string | null; actions: FlowAction[] }
    flowRunId: string
    lensRow: ActionResult
    /** The host Triage run read outside text (its provenance carries to the lens's steps). */
    readOutsideText: boolean
    captureId: string
    workspaceId: string
    trigger: TriggerContext
    extras: FireExtras
    fireId: string | null
    appBaseUrl: string
    executors: FlowExecutors
  },
): Promise<{ ran: boolean; status?: FlowRunStatus }> {
  const { flow, lensRow } = args
  if (!flow.actions.some((a) => a.id !== lensRow.action_id && a.enabled !== false)) return { ran: false }
  const kept = lensRow.status === 'success' ? await lensFindingsText(supabase, { flowId: flow.id, captureId: args.captureId }) : null
  const outcome = await runFlow({ actions: flow.actions }, null, args.trigger, args.appBaseUrl, {
    executors: args.executors,
    extras: args.extras,
    resume: { results: [lensRow], stepOutputs: kept === null ? {} : { [lensRow.action_id]: capStepOutput(kept) }, readOutsideText: args.readOutsideText },
  })
  await supabase
    .from('flow_run')
    .update({ status: outcome.status, action_results: outcome.action_results, ...legacySnapshotFromResults(outcome.action_results) })
    .eq('id', args.flowRunId)
  await keepRunState(supabase, {
    flowRunId: args.flowRunId,
    flowId: flow.id,
    workspaceId: args.workspaceId,
    actions: flow.actions,
    createdBy: flow.created_by,
    outcome,
    context: { trigger: args.trigger, entity: null, extras: args.extras, fire_id: args.fireId, origin_depth: 1, run_as_user_id: flow.created_by },
  })
  return { ran: true, status: outcome.status }
}
