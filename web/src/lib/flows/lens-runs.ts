/**
 * A lens flow's own run row (flows F3, lens-plan.ts). A lens flow that rode
 * Triage's read ran no skill, but its history still says what happened on
 * each call: what its section delivered on the host's run (linked to it), a
 * skip when its condition didn't hold, or a failure when the read it rode
 * produced nothing. One flow_run row each, written by the capture_processed
 * dispatcher, exactly like any other fire's.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LensRide } from './lenses'
import type { ActionResult, FlowAction, LensRideResult } from './types'
import { fireRunId } from './run-record'

/** The lens outcomes a host run's action results carry (its verdict ledger), or null. */
export function lensResultsFrom(results: readonly ActionResult[]): LensRideResult[] | null {
  for (const r of results) if (r.verdict?.lenses) return r.verdict.lenses
  return null
}

function baseResult(actionId: string): Omit<ActionResult, 'status' | 'skipped' | 'condition_met'> {
  return {
    action_id: actionId,
    disabled: false,
    incomplete: false,
    request_summary: null,
    response_status_code: null,
    response_body_preview: null,
    error_message: null,
    duration_ms: 0,
  }
}

/** A lens flow skipped on this call: its condition didn't hold. No model call, one row. */
export async function recordLensSkip(
  supabase: SupabaseClient,
  args: { flowId: string; actionId: string; reason: string; actions: readonly FlowAction[] },
): Promise<void> {
  const action_results: ActionResult[] = args.actions.map((a) => ({
    ...baseResult(a.id),
    condition_met: false,
    skipped: true,
    status: 'success',
    response_body_preview: a.id === args.actionId ? args.reason : null,
  }))
  await supabase.from('flow_run').insert({
    id: crypto.randomUUID(),
    flow_id: args.flowId,
    triggered_by_action_id: null,
    status: 'success',
    action_results,
    response_body_preview: args.reason,
  })
}

/** Each riding lens flow's row, from what its section delivered on the host's run. */
export async function recordLensRides(
  supabase: SupabaseClient,
  args: {
    rides: readonly LensRide[]
    host: { flowRunId: string; status: string; lenses: LensRideResult[] | null; readOutsideText?: boolean } | null
    /** The fire (Inngest event id): each ride's run id derives from it, the same on a retry (fireRunId). */
    fireId?: string | null
  },
): Promise<Array<{ flowId: string; flowRunId: string; row: ActionResult; readOutsideText: boolean }>> {
  const written: Array<{ flowId: string; flowRunId: string; row: ActionResult; readOutsideText: boolean }> = []
  for (const ride of args.rides) {
    const outcome = args.host?.lenses?.find((l) => l.flow_id === ride.flowId) ?? null
    const error = outcome
      ? outcome.error_message
      : args.host
        ? "Triage didn't finish reading this call, so the lens got nothing"
        : 'Triage did not run on this call'
    const status = outcome && !outcome.error_message ? 'success' : 'failed'
    const preview = outcome?.delivered?.summary ?? null
    const row: ActionResult = {
      ...baseResult(ride.actionId),
      condition_met: true,
      skipped: false,
      status,
      response_status_code: status === 'success' ? 200 : 500,
      response_body_preview: preview,
      error_message: status === 'failed' ? error : null,
      delivered: outcome?.delivered ?? null,
      rode_flow_run_id: args.host?.flowRunId ?? null,
    }
    const flowRunId = fireRunId(args.fireId ?? null, ride.flowId, 'lens')
    await supabase.from('flow_run').insert({
      id: flowRunId,
      flow_id: ride.flowId,
      triggered_by_action_id: null,
      status,
      action_results: [row],
      response_status_code: row.response_status_code,
      response_body_preview: preview,
      error_message: row.error_message,
    })
    // The host read the call: whether it read outside text is the lens's provenance too.
    written.push({ flowId: ride.flowId, flowRunId, row, readOutsideText: args.host?.readOutsideText === true })
  }
  return written
}

/** The most findings a lens step's output lists. */
const LENS_OUTPUT_MAX_FINDINGS = 40

/**
 * A lens step's OUTPUT for the steps after it (F4 data passing): what the
 * lens kept from this call, one line each ("objection: … ("their words")").
 * Read from lens_finding (the owner's rows for this flow and call), so a lens
 * that rode Triage and one that ran on its own leave the same output. Empty
 * when it kept nothing (a step that names it then fails loudly).
 */
export async function lensFindingsText(
  supabase: SupabaseClient,
  args: { flowId: string; captureId: string | null },
): Promise<string> {
  if (!args.captureId) return ''
  const { data, error } = await supabase
    .from('lens_finding')
    .select('kind, body')
    .eq('flow_id', args.flowId)
    .eq('capture_id', args.captureId)
    .limit(LENS_OUTPUT_MAX_FINDINGS)
  if (error || !data) return ''
  return (data as Array<{ kind: string; body: { text?: unknown; quote?: unknown } | null }>)
    .map((f) => {
      const text = typeof f.body?.text === 'string' ? f.body.text.trim() : ''
      const quote = typeof f.body?.quote === 'string' && f.body.quote.trim() ? ` ("${f.body.quote.trim()}")` : ''
      return text ? `- ${f.kind.replace(/_/g, ' ')}: ${text}${quote}` : ''
    })
    .filter(Boolean)
    .join('\n')
}
