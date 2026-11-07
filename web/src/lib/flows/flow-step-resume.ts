/**
 * A loop run that PARKED on an approval card, and what happens when the card
 * is answered (F4, docs/plans/flows-connectors.md §2.3).
 *
 * When a run parks (a call_tool step held its exact call as the owner's card,
 * call-tool.ts), the dispatcher keeps the run's state in flow_run_state
 * (migration 383, server-only): the steps' outputs so far, the outside-text
 * flag, and what the rest of the run needs (the trigger, the entity, the
 * capture, the owner, the depth, a hash of the steps). The flow_run row says
 * 'pending' and lists the waiting steps.
 *
 * The card is then answered once, by the owner (approvals.ts), and that
 * sends `flow/step.settled` (notifyFlowStepSettled):
 *   approved  the server already ran the stored call, as the owner. The step
 *             takes its result and output, and the run carries on from it
 *             (resumeParkedRun → runFlow with `resume`), unless meanwhile the
 *             agent was switched off, the loop was switched off or deleted, or
 *             its steps or owner changed: then the run ends and says why;
 *   denied    Skip: the step is skipped, the run ends cleanly with a note;
 *   expired   24 hours passed: the run ends, failed, saying so;
 *   paused    the kill switch expired the card: the run ends, failed;
 *   failed    the accept's re-check refused the call: the run ends, failed.
 * Exactly once: the state row moves parked → resuming by compare-and-swap.
 * The carried-on part gets its own work-ledger row, so the activity feed
 * shows it as what happened after the yes. If it parks again on a later
 * step, the same machinery holds that card (5 pending per run at most).
 */
import 'server-only'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_PAUSED_REASON, isAgentPaused } from '@/lib/work/agent-paused'
import { legacySnapshotFromResults } from './run-record'
import { runFlow, type FireExtras, type FlowExecutors, type FlowRunOutcome, type RunnerEntityData } from './runner'
import { flowPassesData, parseStepOutputs, withStepOutput, type StepOutputs } from './step-data'
import type { ActionResult, FlowAction, FlowRunStatus, TriggerContext } from './types'

export { FLOW_STEP_SETTLED_EVENT, notifyFlowStepSettled, type FlowStepOutcome } from './flow-step-notify'
import { notifyFlowStepSettled, type FlowStepOutcome } from './flow-step-notify'

/** What a parked run needs to carry on (flow_run_state.resume). JSON-safe. */
export interface ParkedRunContext {
  trigger: TriggerContext
  entity: RunnerEntityData | null
  extras: FireExtras
  /** The Inngest event id of the fire (the continuation's ledger row keys on it). */
  fire_id: string | null
  /** The fire's automation depth + 1: what the continued run's writes carry. */
  origin_depth: number
  /** The loop's steps and owner when it parked (stepsHash): a change ends the run. */
  steps_hash: string
  run_as_user_id: string | null
  /** F4 review R1: a person's Test: it carries on even if the loop is still off. */
  manual?: boolean
}

/** JSON with every object's keys sorted (equal values hash equal). */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
    return v
  }
  return JSON.stringify(sort(value ?? null)) ?? 'null'
}

/** The loop's steps and owner, as one hash: what may not change while a step waits. */
export function stepsHash(actions: unknown, createdBy: string | null): string {
  return createHash('sha256').update(canonicalJson({ actions: Array.isArray(actions) ? actions : [], created_by: createdBy ?? null })).digest('hex')
}

/**
 * Keep a run's state after runFlow (every dispatcher calls it once the
 * flow_run row exists): the outputs, when the loop passes data at all, and
 * what a parked run needs to carry on. A parked step's card is linked to its
 * run here (it could not be at insert: the run row came after). Fail-soft
 * for a run that didn't park; a parked run whose state can't be kept fails
 * loudly to the caller (its card would answer into nothing).
 */
export async function keepRunState(
  supabase: SupabaseClient,
  args: {
    flowRunId: string
    flowId: string
    workspaceId: string
    actions: FlowAction[]
    createdBy: string | null
    outcome: Pick<FlowRunOutcome, 'step_outputs' | 'read_outside_text' | 'parked'>
    context: Omit<ParkedRunContext, 'steps_hash'>
  },
): Promise<void> {
  const { outcome } = args
  if (!outcome.parked && !flowPassesData(args.actions)) return
  const row = {
    flow_run_id: args.flowRunId,
    workspace_id: args.workspaceId,
    flow_id: args.flowId,
    step_outputs: outcome.step_outputs,
    read_outside_text: outcome.read_outside_text,
    status: outcome.parked ? 'parked' : 'done',
    parked_action_id: outcome.parked?.action_id ?? null,
    approval_id: outcome.parked?.approval_id ?? null,
    resume: outcome.parked ? ({ ...args.context, steps_hash: stepsHash(args.actions, args.createdBy) } satisfies ParkedRunContext) : null,
    updated_at: new Date().toISOString(),
  }
  const { error } = await supabase.from('flow_run_state').upsert(row, { onConflict: 'flow_run_id' })
  if (error) {
    if (outcome.parked) throw new Error(`could not keep the parked run's state: ${error.message}`)
    console.warn('[flow-step] could not keep the run outputs:', error.message)
    return
  }
  if (outcome.parked) {
    await supabase.from('attention_item').update({ source_flow_run_id: args.flowRunId }).eq('id', outcome.parked.card_id).is('source_flow_run_id', null)
  }
}

interface StateRow {
  flow_run_id: string
  workspace_id: string
  flow_id: string
  step_outputs: unknown
  read_outside_text: boolean
  status: string
  parked_action_id: string | null
  approval_id: string | null
  resume: ParkedRunContext | null
}

interface ApprovalResultRow {
  id: string
  status: string
  result: unknown
  context: { flowStep?: { connection?: string; tool?: string } } | null
}

/** The settled step's result, from the approval's own row (never from a model). */
export function settledStepResult(
  parked: ActionResult,
  outcome: FlowStepOutcome,
  approval: Pick<ApprovalResultRow, 'result'> | null,
): { result: ActionResult; output: string | null; carryOn: boolean } {
  const base: ActionResult = { ...parked, parked: null, waiting: false, skipped: false, duration_ms: parked.duration_ms ?? 0 }
  const r = (approval?.result ?? null) as { success?: unknown; text?: unknown; error?: unknown; message?: unknown } | null
  if (outcome === 'approved') {
    const success = r?.success !== false
    const text = typeof r?.text === 'string' ? r.text : ''
    return {
      result: {
        ...base,
        status: success ? 'success' : 'failed',
        // flow_run is readable by the whole workspace: how much came back,
        // never what (the text stays in the server-only flow_run_state), and
        // never the app's own error text.
        response_body_preview: success ? `Ran after you approved it; ${text.length} char${text.length === 1 ? '' : 's'} back` : null,
        error_message: success ? null : 'It ran after you approved it, but the app returned an error',
        read_outside_text: true,
      },
      output: success ? text : null,
      carryOn: true,
    }
  }
  if (outcome === 'denied') {
    return {
      result: { ...base, status: 'success', skipped: true, response_body_preview: 'Skipped: you chose Skip on the card, so the run ended here' },
      output: null,
      carryOn: false,
    }
  }
  const why =
    outcome === 'expired'
      ? 'The approval card expired after 24 hours with no answer, so the run stopped here'
      : outcome === 'paused'
        ? `${AGENT_PAUSED_REASON}, so the run stopped here`
        : typeof r?.error === 'string'
          ? `${r.error} The run stopped here.`
          : 'The held call could not run, so the run stopped here'
  return { result: { ...base, status: 'failed', error_message: why }, output: null, carryOn: false }
}

/** The run ended at a parked step: the steps after it are recorded as not run (no longer waiting). */
export function endedResults(results: ActionResult[], atActionId: string): ActionResult[] {
  return results.map((r) =>
    r.waiting
      ? { ...r, waiting: false, status: 'success' as FlowRunStatus, skipped: true, response_body_preview: `Not run: the run ended at step ${atActionId}` }
      : r,
  )
}

/** A run's final status from its results (the runner's worst-of rule). */
export function statusOf(results: ActionResult[]): FlowRunStatus {
  if (results.some((r) => r.parked)) return 'pending'
  return results.some((r) => !r.skipped && r.status === 'failed') ? 'failed' : 'success'
}

export interface ResumeDeps {
  supabase: SupabaseClient
  appBaseUrl: string
  /** The executors the continuation runs with (the dispatcher's own, for this run). */
  executorsFor: (args: { flow: ResumeFlow; state: StateRow; context: ParkedRunContext }) => FlowExecutors
  /** The continuation's ledger: start a row, settle it from the results. */
  ledger?: {
    start: (args: { flow: ResumeFlow; context: ParkedRunContext; approvalId: string }) => Promise<{ settle: (status: FlowRunStatus, results: ActionResult[]) => Promise<void> } | null>
  }
  paused?: (supabase: SupabaseClient, workspaceId: string) => Promise<boolean>
}

/** The loop as the resume reads it. */
export interface ResumeFlow {
  id: string
  workspace_id: string
  name: string
  enabled: boolean
  created_by: string | null
  actions: FlowAction[]
  seed_key?: string | null
  ai_team_member_id?: string | null
}

export type ResumeResult =
  | { ok: true; status: FlowRunStatus; carriedOn: boolean }
  | { ok: false; reason: 'not_found_yet' | 'not_parked' | 'not_this_approval' }

/**
 * Carry a parked run on, or end it, once its card is answered (see the
 * header). Idempotent: only the caller that moves the state off 'parked'
 * acts. Throws 'not_found_yet' as a result (the dispatcher may still be
 * writing the run), which the Inngest function turns into a retry.
 */
export async function resumeParkedRun(
  deps: ResumeDeps,
  event: { approvalId: string; flowRunId: string; outcome: FlowStepOutcome },
): Promise<ResumeResult> {
  const { supabase } = deps
  const { data: state } = await supabase
    .from('flow_run_state')
    .select('flow_run_id, workspace_id, flow_id, step_outputs, read_outside_text, status, parked_action_id, approval_id, resume')
    .eq('flow_run_id', event.flowRunId)
    .maybeSingle<StateRow>()
  if (!state) return { ok: false, reason: 'not_found_yet' }
  if (state.status !== 'parked' || !state.resume || !state.parked_action_id) return { ok: false, reason: 'not_parked' }
  if (state.approval_id !== event.approvalId) return { ok: false, reason: 'not_this_approval' }
  // Exactly once.
  const { data: claimed } = await supabase
    .from('flow_run_state')
    .update({ status: 'resuming', updated_at: new Date().toISOString() })
    .eq('flow_run_id', state.flow_run_id)
    .eq('status', 'parked')
    .eq('approval_id', event.approvalId)
    .select('flow_run_id')
  if (!claimed?.length) return { ok: false, reason: 'not_parked' }

  const context = state.resume
  const [{ data: runRow }, { data: approval }, { data: flowRow }] = await Promise.all([
    supabase.from('flow_run').select('id, action_results').eq('id', state.flow_run_id).maybeSingle<{ id: string; action_results: ActionResult[] | null }>(),
    supabase.from('tool_approval').select('id, status, result, context').eq('id', event.approvalId).maybeSingle<ApprovalResultRow>(),
    supabase
      .from('flow')
      .select('id, workspace_id, name, enabled, created_by, actions, seed_key, ai_team_member_id')
      .eq('id', state.flow_id)
      .maybeSingle<ResumeFlow>(),
  ])
  const results = Array.isArray(runRow?.action_results) ? runRow!.action_results! : []
  const parkedIndex = results.findIndex((r) => r.action_id === state.parked_action_id)
  const parked = parkedIndex >= 0 ? results[parkedIndex] : null

  const finish = async (status: FlowRunStatus, final: ActionResult[], outputs: StepOutputs, readOutside: boolean, nextPark?: FlowRunOutcome['parked']) => {
    await supabase
      .from('flow_run')
      .update({ status, action_results: final, ...legacySnapshotFromResults(final) })
      .eq('id', state.flow_run_id)
    await supabase
      .from('flow_run_state')
      .update({
        step_outputs: outputs,
        read_outside_text: readOutside,
        status: nextPark ? 'parked' : 'done',
        parked_action_id: nextPark?.action_id ?? null,
        approval_id: nextPark?.approval_id ?? null,
        ...(nextPark ? {} : { resume: null }),
        updated_at: new Date().toISOString(),
      })
      .eq('flow_run_id', state.flow_run_id)
    if (nextPark) {
      await supabase.from('attention_item').update({ source_flow_run_id: state.flow_run_id }).eq('id', nextPark.card_id).is('source_flow_run_id', null)
    }
  }

  let outputs = parseStepOutputs(state.step_outputs)
  if (!parked) {
    // The run row lost its parked step: end it as it stands.
    const final = endedResults(results, state.parked_action_id)
    await finish(statusOf(final), final, outputs, state.read_outside_text)
    return { ok: true, status: statusOf(final), carriedOn: false }
  }
  const settled = settledStepResult(parked, event.outcome, approval ?? null)
  const updated = [...results]
  updated[parkedIndex] = settled.result
  if (settled.output !== null) outputs = withStepOutput(outputs, parked.action_id, settled.output)
  const readOutside = state.read_outside_text || settled.result.read_outside_text === true

  // Why the rest can't run now, if it can't.
  let stop: string | null = null
  if (!settled.carryOn) stop = 'ended'
  else if (!flowRow) stop = 'The loop was deleted while this step waited, so the rest did not run'
  else if (!flowRow.enabled && context.manual !== true) stop = 'The loop was switched off while this step waited, so the rest did not run'
  else if (stepsHash(flowRow.actions, flowRow.created_by) !== context.steps_hash) stop = 'The loop changed while this step waited, so the rest did not run'
  else if (await (deps.paused ?? isAgentPaused)(supabase, state.workspace_id)) stop = `${AGENT_PAUSED_REASON}, so the rest did not run`

  if (stop) {
    const final = endedResults(updated, parked.action_id).map((r) =>
      stop !== 'ended' && r.response_body_preview?.startsWith('Not run:') ? { ...r, response_body_preview: `Not run: ${stop}` } : r,
    )
    const status = statusOf(final)
    await finish(status, final, outputs, readOutside)
    return { ok: true, status, carriedOn: false }
  }

  const flow = flowRow!
  const ledger = deps.ledger ? await deps.ledger.start({ flow, context, approvalId: event.approvalId }).catch(() => null) : null
  const outcome = await runFlow({ actions: flow.actions }, context.entity, context.trigger, deps.appBaseUrl, {
    executors: deps.executorsFor({ flow, state, context }),
    extras: context.extras,
    resume: { results: updated, stepOutputs: outputs, readOutsideText: readOutside },
  })
  await finish(outcome.status, outcome.action_results, outcome.step_outputs, outcome.read_outside_text, outcome.parked)
  // The carried-on part's own ledger row: only the steps that ran after the yes.
  if (ledger) {
    const after = outcome.action_results.filter((r) => !results.some((p) => p.action_id === r.action_id && !p.waiting) || r.action_id === parked.action_id)
    await ledger.settle(outcome.status, after).catch(() => {})
  }
  return { ok: true, status: outcome.status, carriedOn: true }
}

// ── The parked-run sweep (hourly, with the approval expiry cron) ───────────

/** An approval decided this long ago whose run never heard is re-told (its event was lost). */
export const LOST_ANSWER_AFTER_MS = 10 * 60 * 1000
/** A run claimed for resuming this long ago and never finished died mid-way: it ends, failed. */
export const STUCK_RESUMING_AFTER_MS = 30 * 60 * 1000
/** A finished run's step outputs are kept this long, then purged. */
export const RUN_STATE_KEEP_MS = 7 * 24 * 60 * 60 * 1000
/** How far back the lost-answer pass looks at settled approvals (older ones: pass 1b). */
const ANSWERED_WINDOW_MS = 48 * 60 * 60 * 1000
/** A run parked this long is past any card's 24 h: pass 1b ends it if its approval is settled or gone. */
const OLD_PARKED_AFTER_MS = 25 * 60 * 60 * 1000
/** A skill run's outside-read note is kept this long (a run lives minutes). */
const RUN_READ_KEEP_MS = 24 * 60 * 60 * 1000
/** Rows one sweep looks at, per kind. */
const SWEEP_LIMIT = 100

/** What a tool_approval's status means for its parked run (a missing one: failed). */
export function outcomeOfApprovalStatus(status: string | null | undefined): FlowStepOutcome {
  if (status === 'approved') return 'approved'
  if (status === 'denied') return 'denied'
  if (status === 'expired') return 'expired'
  return 'failed'
}

export interface ParkedSweepResult {
  retold: number
  ended: number
  purged: number
}

/**
 * Nothing stays parked forever (F4 review S2, S8). Passes, each bounded:
 *   1. a run still PARKED whose approval settled over LOST_ANSWER_AFTER_MS
 *      ago (an approved one: since its call ran) and whose flow/step.settled
 *      was lost: told again, with the outcome read from tool_approval.status,
 *      read from the answered side so pending cards can't starve it; and
 *      (1b) a run parked past any card's 24 h whose approval is settled or
 *      gone (gone: failed);
 *   2. a run stuck RESUMING past STUCK_RESUMING_AFTER_MS (the resume died
 *      after its claim): ended, failed, with a note on every step that waited;
 *   3. a finished run's state (its step outputs) older than RUN_STATE_KEEP_MS:
 *      deleted;
 *   4. skill runs' outside-read notes over a day old: deleted.
 * Never throws for one row; a failed read skips that pass.
 */
export async function sweepParkedRuns(
  supabase: SupabaseClient,
  deps: { now?: number; send?: (o: { approvalId: string; flowRunId: string; outcome: FlowStepOutcome }) => Promise<unknown> } = {},
): Promise<ParkedSweepResult> {
  const now = deps.now ?? Date.now()
  const out: ParkedSweepResult = { retold: 0, ended: 0, purged: 0 }
  const send =
    deps.send ??
    ((o: { approvalId: string; flowRunId: string; outcome: FlowStepOutcome }) =>
      notifyFlowStepSettled({ id: o.approvalId, door: 'flow_step', flow_run_id: o.flowRunId }, o.outcome))

  // 1. Lost answers, from the answered side: flow-step approvals settled in
  // the last two days, oldest first, so a backlog of still-pending cards can't
  // starve the pass. An approved one counts as lost only once its call RAN
  // (executed_at) over LOST_ANSWER_AFTER_MS ago; any other once decided then.
  const lostCutoff = now - LOST_ANSWER_AFTER_MS
  const { data: answered } = await supabase
    .from('tool_approval')
    .select('id, status, decided_at, executed_at, flow_run_id')
    .eq('door', 'flow_step')
    .in('status', ['approved', 'denied', 'expired', 'failed'])
    .gte('decided_at', new Date(now - ANSWERED_WINDOW_MS).toISOString())
    .order('decided_at', { ascending: true })
    .limit(SWEEP_LIMIT * 5)
  const settledLongEnough = ((answered ?? []) as Array<{ id: string; status: string; decided_at: string | null; executed_at: string | null; flow_run_id: string | null }>).filter((a) => {
    const at = Date.parse((a.status === 'approved' ? a.executed_at : a.decided_at) ?? '')
    return Number.isFinite(at) && at <= lostCutoff
  })
  const told = new Set<string>()
  if (settledLongEnough.length) {
    const byId = new Map(settledLongEnough.map((a) => [a.id, a]))
    const { data: parked } = await supabase
      .from('flow_run_state')
      .select('flow_run_id, approval_id')
      .eq('status', 'parked')
      .in('approval_id', [...byId.keys()])
    for (const row of (parked ?? []) as Array<{ flow_run_id: string; approval_id: string | null }>) {
      const approval = row.approval_id ? byId.get(row.approval_id) : undefined
      if (!approval) continue
      try {
        await send({ approvalId: approval.id, flowRunId: row.flow_run_id, outcome: outcomeOfApprovalStatus(approval.status) })
        told.add(row.flow_run_id)
        out.retold += 1
      } catch {
        /* the next sweep tries again */
      }
    }
  }
  // 1b. Old parked runs (past a card's 24 h, so nothing should still wait),
  // oldest first: an approval that is gone, or settled outside the window
  // above, ends the run the same way.
  const { data: oldParked } = await supabase
    .from('flow_run_state')
    .select('flow_run_id, approval_id')
    .eq('status', 'parked')
    .lt('updated_at', new Date(now - OLD_PARKED_AFTER_MS).toISOString())
    .order('updated_at', { ascending: true })
    .limit(SWEEP_LIMIT)
  const oldRows = ((oldParked ?? []) as Array<{ flow_run_id: string; approval_id: string | null }>).filter((r) => !told.has(r.flow_run_id) && r.approval_id)
  if (oldRows.length) {
    const { data } = await supabase.from('tool_approval').select('id, status').in('id', oldRows.map((r) => r.approval_id as string))
    const status = new Map(((data ?? []) as Array<{ id: string; status: string }>).map((a) => [a.id, a.status]))
    for (const row of oldRows) {
      const s = status.get(row.approval_id as string)
      if (s === 'pending') continue
      try {
        await send({ approvalId: row.approval_id as string, flowRunId: row.flow_run_id, outcome: outcomeOfApprovalStatus(s) })
        out.retold += 1
      } catch {
        /* the next sweep tries again */
      }
    }
  }

  // 2. Stuck resumes.
  const { data: stuck } = await supabase
    .from('flow_run_state')
    .select('flow_run_id')
    .eq('status', 'resuming')
    .lt('updated_at', new Date(now - STUCK_RESUMING_AFTER_MS).toISOString())
    .limit(SWEEP_LIMIT)
  for (const row of (stuck ?? []) as Array<{ flow_run_id: string }>) {
    const { data: claimed } = await supabase
      .from('flow_run_state')
      .update({ status: 'done', resume: null, updated_at: new Date(now).toISOString() })
      .eq('flow_run_id', row.flow_run_id)
      .eq('status', 'resuming')
      .select('flow_run_id')
    if (!claimed?.length) continue
    const { data: run } = await supabase.from('flow_run').select('action_results').eq('id', row.flow_run_id).maybeSingle<{ action_results: ActionResult[] | null }>()
    const note = 'Not run: the run stopped while carrying on after your approval'
    const final = (run?.action_results ?? []).map((r) =>
      r.waiting || r.parked ? { ...r, waiting: false, parked: null, skipped: true, status: 'failed' as FlowRunStatus, error_message: note, response_body_preview: note } : r,
    )
    await supabase
      .from('flow_run')
      .update({ status: 'failed', action_results: final, ...legacySnapshotFromResults(final), error_message: note })
      .eq('id', row.flow_run_id)
    out.ended += 1
  }

  // 3. Old finished state.
  const { data: purged } = await supabase
    .from('flow_run_state')
    .delete()
    .eq('status', 'done')
    .lt('updated_at', new Date(now - RUN_STATE_KEEP_MS).toISOString())
    .select('flow_run_id')
  out.purged = (purged ?? []).length
  // 4. Skill runs' outside-read notes (skill-run-reads.ts), a day on.
  await supabase.from('skill_run_read').delete().lt('created_at', new Date(now - RUN_READ_KEEP_MS).toISOString())
  return out
}
