/**
 * Queueing a run — the one place that decides an eval run may exist (spec §4.1).
 *
 * Everything expensive and everything irreversible happens here, BEFORE the
 * first model call: the target prompt is snapshotted and hashed, the cost is
 * estimated, the workspace's monthly eval budget is checked, and the row is
 * inserted. The Inngest lane that follows only executes what this function
 * already authorised.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROMPT IS DENORMALIZED ONTO THE ROW
 * ---------------------------------------------------------------------------
 * `target_system_prompt`, `target_agent_config` and `target_model` are copied
 * onto the run, not referenced. A foreign key to `recipe` would start LYING the
 * moment someone edits the prompt: yesterday's green run would silently claim
 * to have tested today's text, and the whole point of the feature is the
 * x-axis (spec §9). `target_prompt_hash` over those same three values is what
 * groups the sparkline into segments and what `latestCompletedRun`'s
 * `excludingHash` uses to refuse "two runs of the same prompt" as a
 * before/after pair — they are variance samples.
 *
 * ---------------------------------------------------------------------------
 * ADOPTION, NOT AN ERROR
 * ---------------------------------------------------------------------------
 * `idx_eval_run_one_live` is a partial unique index on (suite_id, mode) where
 * the run is queued or running. The DATABASE, not the app, refuses a second
 * concurrent run — which means a double-clicked button and a chat tool racing
 * the UI both land on a 23505 rather than on a check-then-insert race that
 * lets both through. We catch it and return the run that already exists with
 * `adopted: true`, so both callers converge on one run and the poll contract
 * picks it up. That is the same shape `createProspectList` uses for its own
 * unique index.
 *
 * ---------------------------------------------------------------------------
 * THE BUDGET IS CHECKED HERE AND ENFORCED IN THE LANE
 * ---------------------------------------------------------------------------
 * Two ceilings, deliberately different in kind:
 *   - the MONTHLY workspace cap ({@link MONTHLY_EVAL_BUDGET_USD}) is checked
 *     once, here, against the sum of this month's `eval_run.cost_usd`. A run
 *     that would start over the cap never starts.
 *   - `max_cost_usd` (3× the estimate) is written onto the row and enforced
 *     BETWEEN TRIALS by the lane, because that is the only place accumulated
 *     spend is known. An estimate that turns out low cancels the run with
 *     `error_code:'budget'` rather than running to completion at 10× the quote.
 */
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'
import { inngest } from '@/lib/inngest/client'
import { mirrorEvalRunQueued, settleEvalWorkFromRow } from '@/lib/work/eval-run-mirror'
import { estimateRunCostUsd } from './estimate'
import { RUN_FIELDS, caseRunnableBy } from './queries'
import { RUNNABLE_EVAL_SPEEDS } from './types'
import type { EvalMode, EvalRunRow, EvalSpeed, RunProgress } from './types'

/**
 * The event the runs route and the chat tool emit, and `eval-functions.ts`
 * triggers on.
 *
 * Declared HERE rather than in `src/lib/inngest/client.ts` (where prospecting's
 * two events live) only because this module is the sender and the lane is the
 * receiver, so importing the constant from either direction would be circular
 * through the client. The NAMING contract is what matters — sender and receiver
 * both import this symbol, so a rename breaks the build instead of producing a
 * run that never happens and never errors.
 */
export const EVAL_RUN_REQUESTED = 'eval/run.requested' as const

/** Payload of {@link EVAL_RUN_REQUESTED}. The row is created HERE and its id
 *  sent; the lane never creates one, so the partial unique index is the only
 *  thing deciding whether a second run is allowed. */
export interface EvalRunRequestedEvent {
  name: typeof EVAL_RUN_REQUESTED
  data: {
    run_id: string
    workspace_id: string
  }
}

/** Per-workspace monthly ceiling on eval spend (spec §10). Deliberately a
 *  constant and not a setting in P0: the number exists to make a runaway sweep
 *  impossible, and a configurable ceiling is a ceiling somebody raises. */
export const MONTHLY_EVAL_BUDGET_USD = 100

/** `max_cost_usd` as a multiple of the estimate (spec §10). Three, not one:
 *  the estimate is a middle-of-band guess and a run cancelled at its own quote
 *  would cancel constantly. */
export const MAX_COST_MULTIPLE = 3

/** Typed failure the routes and tools map to a 402/400 rather than a 500. The
 *  `code` is what the UI switches on; the message is what it shows. */
export class EvalRunError extends Error {
  constructor(
    readonly code:
      | 'EVAL_BUDGET_EXCEEDED'
      | 'EVAL_SUITE_NOT_FOUND'
      | 'EVAL_NO_CASES'
      | 'EVAL_TARGET_NOT_FOUND'
      | 'EVAL_SPEED_UNAVAILABLE'
      | 'EVAL_RUN_NOT_FOUND'
      | 'EVAL_RUN_INSERT_FAILED'
      | 'EVAL_USAGE_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'EvalRunError'
  }
}

/**
 * The hash that identifies a prompt version.
 *
 * `sha256(system_prompt || model || JSON.stringify(agent_config))`, exactly as
 * `recipe_prompt_version.content_hash` is specified — the two MUST agree, or a
 * run would never match the version it tested and the "version recovered" path
 * (spec §9) would fire on every run.
 *
 * Nulls collapse to the empty string rather than to the literal "null": a
 * recipe with no model set and one whose model is the string "null" are the
 * same prompt in every way that matters, and the four-character difference
 * would otherwise split the sparkline.
 */
export function computePromptHash(args: {
  systemPrompt: string | null
  model: string | null
  agentConfig: Record<string, unknown> | null
}): string {
  const parts = [
    args.systemPrompt ?? '',
    args.model ?? '',
    args.agentConfig ? JSON.stringify(args.agentConfig) : '',
  ]
  return createHash('sha256').update(parts.join('')).digest('hex')
}

type SuiteTargetRow = {
  id: string
  workspace_id: string
  target_recipe_id: string | null
  judge_model: string | null
}

type RecipeSnapshotRow = {
  system_prompt: string | null
  agent_config: Record<string, unknown> | null
  model: string | null
}

/** First day of the current month, ISO — the window the monthly cap sums over. */
function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/**
 * Sum of this workspace's eval spend so far this month.
 *
 * Reads `cost_usd` off every run started since the first of the month,
 * including runs still in flight — an in-flight run's accumulated cost is
 * already written by the lane after each trial, so a second sweep queued while
 * the first is halfway through sees the money it has actually spent.
 */
async function monthToDateSpendUsd(
  service: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const { data, error } = await service
    .from('eval_run')
    .select('cost_usd')
    .eq('workspace_id', workspaceId)
    .gte('started_at', monthStartIso())

  if (error) {
    console.warn('[evals] month-to-date spend read failed:', error.message)
    // Fail OPEN on a read failure, not closed. The per-run `max_cost_usd` still
    // bounds this run, and refusing every run in the workspace because one
    // aggregate query hiccuped is a worse failure than one run over the cap.
    return 0
  }
  return (data ?? []).reduce(
    (sum, row) => sum + Number((row as { cost_usd: number | string }).cost_usd ?? 0),
    0,
  )
}

/**
 * Queue a run of one suite in one mode.
 *
 * @param service  the SERVICE client. Every write here is server-authored:
 *                 `eval_run` has no insert policy for members, and the
 *                 `case_ids` narrowing must not be re-filtered by RLS.
 * @returns the run, whether it was adopted from an in-flight one, and the
 *          estimate the caller should quote before anything executes.
 */
export async function startEvalRun(
  service: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    suiteId: string
    mode: EvalMode
    speed?: EvalSpeed
    trialsPerCase?: number
    caseIds?: string[]
  },
): Promise<{ run: EvalRunRow; adopted: boolean; estimated_cost_usd: number }> {
  // A person on their own ChatGPT plan (the free tier) runs evals on it: the
  // trials and the judges (the eval lane passes the plan to gradeTrial), so
  // the run costs Native Intelligence nothing and is priced at $0 below (its $0 ceiling
  // stops it should anything about it ever spend). Read whichever door it came
  // in by (the route, the chat's start_eval_run, MCP). Fails closed: a check
  // that can't be read queues nothing.
  let onPlan: boolean
  try {
    onPlan = await chatgptPlanFor(args.userId, { attempts: 2, failClosed: true })
  } catch {
    throw new EvalRunError('EVAL_USAGE_UNAVAILABLE', "The usage check couldn't be read, so the run wasn't queued. Try again in a moment.")
  }
  const speed: EvalSpeed = args.speed ?? 'instant'
  // Refuse a watched speed rather than queue a run that cannot finish. The
  // driver below is `server` whatever the speed says, and the server driver
  // really sleeps between chunks — a 15-minute case at `realtime` would sit
  // ~900s inside one `step.run` against a 300s serve route. Failing here is a
  // sentence the caller can act on; the alternative is a timeout with no
  // explanation and a partial bill.
  if (!(RUNNABLE_EVAL_SPEEDS as readonly EvalSpeed[]).includes(speed)) {
    throw new EvalRunError(
      'EVAL_SPEED_UNAVAILABLE',
      `Replay speed "${speed}" needs the client driver, which is not built yet. Run at "instant".`,
    )
  }
  const trialsPerCase = Math.max(1, Math.floor(args.trialsPerCase ?? 1))

  const { data: suiteRow } = await service
    .from('eval_suite')
    .select('id, workspace_id, target_recipe_id, judge_model')
    .eq('id', args.suiteId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle<SuiteTargetRow>()

  if (!suiteRow) {
    throw new EvalRunError('EVAL_SUITE_NOT_FOUND', 'Eval suite not found')
  }

  // ── The cases this run will execute ────────────────────────────────────────
  // Narrowed by `case_ids` (Retry failed cases only) and by MODE: a case
  // declares which modes it is valid for, and running a batch-only case live
  // would grade an empty replay as a failure.
  let caseQuery = service
    .from('eval_case')
    .select('id, modes, visibility, created_by')
    .eq('suite_id', args.suiteId)
    .eq('workspace_id', args.workspaceId)
    .order('sort_order')
  if (args.caseIds?.length) caseQuery = caseQuery.in('id', args.caseIds)

  const { data: caseRows } = await caseQuery
  // Someone else's PRIVATE case never runs here: this read is on the service
  // client, and the trials it would write are readable by every member
  // (caseRunnableBy).
  const caseIds = (
    (caseRows ?? []) as Array<{
      id: string
      modes: EvalMode[] | null
      visibility?: string | null
      created_by?: string | null
    }>
  )
    .filter((c) => caseRunnableBy(c, args.userId))
    .filter((c) => !c.modes?.length || c.modes.includes(args.mode))
    .map((c) => c.id)

  if (caseIds.length === 0) {
    throw new EvalRunError(
      'EVAL_NO_CASES',
      `This suite has no cases that run in ${args.mode} mode`,
    )
  }

  // ── Snapshot the LIVE recipe (spec §9) ────────────────────────────────────
  // Scoped to system recipes or the suite's OWN workspace: this read is on the
  // service client, so a `target_recipe_id` that slipped in before the write
  // paths were fenced would otherwise copy another workspace's private system
  // prompt onto a row `RUN_FIELDS` serves back. A target that does not resolve
  // fails the start rather than snapshotting nothing — a run graded against an
  // empty prompt is a silently wrong result, not a working run.
  let snapshot: RecipeSnapshotRow = { system_prompt: null, agent_config: null, model: null }
  if (suiteRow.target_recipe_id) {
    const { data: recipe } = await service
      .from('recipe')
      .select('system_prompt, agent_config, model')
      .eq('id', suiteRow.target_recipe_id)
      .or(`is_system.eq.true,workspace_id.eq.${suiteRow.workspace_id}`)
      .maybeSingle<RecipeSnapshotRow>()
    if (!recipe) {
      throw new EvalRunError(
        'EVAL_TARGET_NOT_FOUND',
        'The Agent or Skill this suite grades is not available in this workspace. Point the suite at a target you can see, then run it again.',
      )
    }
    snapshot = recipe
  }
  const targetPromptHash = computePromptHash({
    systemPrompt: snapshot.system_prompt,
    model: snapshot.model,
    agentConfig: snapshot.agent_config,
  })

  // ── Money, before anything runs ───────────────────────────────────────────
  // On the person's own plan nothing is Native Intelligence's to pay: $0, and a $0 ceiling.
  const estimated = onPlan
    ? 0
    : estimateRunCostUsd({
        caseCount: caseIds.length,
        mode: args.mode,
        trialsPerCase,
      })
  const spent = await monthToDateSpendUsd(service, args.workspaceId)
  if (spent + estimated > MONTHLY_EVAL_BUDGET_USD) {
    throw new EvalRunError(
      'EVAL_BUDGET_EXCEEDED',
      `This workspace has spent $${spent.toFixed(2)} on evals this month; ` +
        `this run would add about $${estimated.toFixed(2)}, over the $${MONTHLY_EVAL_BUDGET_USD} monthly cap.`,
    )
  }

  // `case_ids` rides on `progress` rather than on a column of its own: the lane
  // must execute exactly the set this function priced and budgeted, and a
  // re-query at execution time would silently pick up a case added in between.
  const progress: RunProgress & { case_ids: string[] } = {
    cases_total: caseIds.length,
    trials_total: caseIds.length * trialsPerCase,
    trials_done: 0,
    stage: 'queued',
    case_ids: caseIds,
  }

  const { data: inserted, error: insertError } = await service
    .from('eval_run')
    .insert({
      suite_id: args.suiteId,
      workspace_id: args.workspaceId,
      mode: args.mode,
      speed,
      // P0 is server-driven in both modes: batch, and live at `instant`. The
      // client driver (realtime / fast) is P1 and sets this itself.
      driver: 'server',
      trials_per_case: trialsPerCase,
      target_recipe_id: suiteRow.target_recipe_id,
      target_prompt_hash: targetPromptHash,
      target_system_prompt: snapshot.system_prompt,
      target_agent_config: snapshot.agent_config,
      target_model: snapshot.model,
      status: 'queued',
      progress,
      estimated_cost_usd: estimated,
      max_cost_usd: Math.round(estimated * MAX_COST_MULTIPLE * 1_000_000) / 1_000_000,
      started_by: args.userId,
    })
    .select(RUN_FIELDS)
    .single<EvalRunRow>()

  if (insertError) {
    // 23505 on idx_eval_run_one_live: a run of this suite+mode is already live.
    // Adopt it — both callers converge on one run and the poll picks it up.
    if (insertError.code === '23505') {
      const { data: existing } = await service
        .from('eval_run')
        .select(RUN_FIELDS)
        .eq('suite_id', args.suiteId)
        .eq('mode', args.mode)
        .in('status', ['queued', 'running'])
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle<EvalRunRow>()
      if (existing) {
        return {
          run: existing,
          adopted: true,
          estimated_cost_usd: Number(existing.estimated_cost_usd ?? estimated),
        }
      }
      // The live run settled between the conflict and the re-read. Nothing to
      // adopt and nothing inserted — the caller retries rather than getting a
      // half-truthful "adopted" with no run attached.
      throw new EvalRunError(
        'EVAL_RUN_INSERT_FAILED',
        'A run of this suite finished while starting; try again',
      )
    }
    throw new EvalRunError('EVAL_RUN_INSERT_FAILED', insertError.message)
  }
  if (!inserted) {
    throw new EvalRunError('EVAL_RUN_INSERT_FAILED', 'Failed to create the run')
  }

  // The run's Activity row, queued from the moment the run exists (Sequence
  // row 6). Fail-soft.
  await mirrorEvalRunQueued(service, inserted)

  // Emitted AFTER the row exists, so a lane that starts instantly always finds
  // it. A failed emit leaves a queued run the watchdog/UI can see, which is
  // strictly better than a run executing with no row to write progress onto.
  await inngest.send({
    name: EVAL_RUN_REQUESTED,
    data: { run_id: inserted.id, workspace_id: args.workspaceId },
  })

  return { run: inserted, adopted: false, estimated_cost_usd: estimated }
}

/**
 * Cancel a run.
 *
 * Writes the terminal status directly rather than sending a cancel event: the
 * lane re-reads the row's status between trials (the same between-angle check
 * prospecting uses), so a cancel lands with the trials that already completed
 * intact instead of freezing the run mid-flight. Filtered to live statuses so a
 * cancel can never clobber a run that finished a moment earlier.
 */
export async function cancelEvalRun(
  service: SupabaseClient,
  args: { workspaceId: string; runId: string },
): Promise<EvalRunRow> {
  const { data, error } = await service
    .from('eval_run')
    .update({
      status: 'cancelled',
      ended_at: new Date().toISOString(),
      error_code: 'cancelled',
      error_message: 'Cancelled',
    })
    .eq('id', args.runId)
    .eq('workspace_id', args.workspaceId)
    .in('status', ['queued', 'running'])
    .select(RUN_FIELDS)
    .maybeSingle<EvalRunRow>()

  if (error) throw new EvalRunError('EVAL_RUN_INSERT_FAILED', error.message)
  if (data) {
    await settleEvalWorkFromRow(service, args.runId)
    return data
  }

  // Zero rows updated: either the run does not exist in this workspace, or it
  // had already settled. Read it back so the caller can tell those apart.
  const { data: current } = await service
    .from('eval_run')
    .select(RUN_FIELDS)
    .eq('id', args.runId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle<EvalRunRow>()
  if (!current) throw new EvalRunError('EVAL_RUN_NOT_FOUND', 'Run not found')
  return current
}
