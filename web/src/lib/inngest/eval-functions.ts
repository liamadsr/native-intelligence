/**
 * The Evals run lane — `eval-run-requested`, triggered by `eval/run.requested`.
 *
 * ===========================================================================
 * WHY INNGEST AND NOT THE ROUTE
 * ===========================================================================
 * Note the inversion the spec calls out (§4.1): the Inngest serve route caps at
 * `maxDuration = 300`, HALF the live-agent route's 600. So Inngest is NOT here
 * because it can run longer — it cannot. It is here because a run is many
 * bounded trials and needs durable progress, per-trial retries, and survival
 * across a closed tab. Each trial is its own `step.run`, so each gets its own
 * 300s budget and the run as a whole is unbounded.
 *
 * That is what makes an instant live trial fit: ~10–14 serial route calls of
 * 3–6s each is 40–90s, comfortably inside one step. A watched replay at real
 * time is a different animal and belongs to the CLIENT driver (P1).
 *
 * ===========================================================================
 * STEP DISCIPLINE — the thing that silently breaks
 * ===========================================================================
 * Every `step.run` here is called from the TOP LEVEL of the handler. Nothing
 * calls `step.*` from inside a `step.run` callback: that does not throw in
 * production, it HANGS for minutes having done nothing (the hubspot-push-sweep
 * incident). `createStepMock()` has an AsyncLocalStorage tripwire for exactly
 * this and it is mandatory in this function's tests.
 *
 * ===========================================================================
 * THREE WAYS A RUN STOPS EARLY, AND WHY EACH IS DIFFERENT
 * ===========================================================================
 * 1. BUDGET. Accumulated `cost_usd` crosses `max_cost_usd`, or the workspace's
 *    monthly cap. Checked BETWEEN trials, because that is the only place the
 *    real spend is known. Status `cancelled`, `error_code: 'budget'` — a
 *    deliberate stop with the completed trials intact and scored.
 * 2. THE USAGE WALL. A 429 or 503 from the live-agent route. This is a RUN-level
 *    `failed` with `error_code: 'usage_limit'` and NO retry: the user is over
 *    their plan limit, every remaining trial would hit the same wall, and
 *    retrying would burn the lane's budget producing identical failures. A
 *    per-trial retry here would also score the wall as a prompt regression,
 *    which is the exact confusion the errored-vs-failed distinction exists to
 *    prevent.
 * 3. CANCELLED BY A PERSON. `cancelEvalRun` writes the status directly; the
 *    loop re-reads it between trials and stops with the partial results, the
 *    same between-angle check the prospecting engine uses.
 *
 * A trial that simply ERRORS (the route skipped the capture, a question went
 * unanswered) is none of these: it is stored `errored` with its code and the run
 * continues. One broken case must not take a suite down.
 */
import { settleEvalWorkFromRow, stepEvalWork } from '@/lib/work/eval-run-mirror'
import { NonRetriableError } from 'inngest'
import { inngest } from './client'
import { getServiceClient } from '@/lib/supabase/service'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'
import { gradeTrial } from '@/lib/evals/graders'
import { runRollup, trialOutcomeFromChecks } from '@/lib/evals/roll-up'
import {
  EVAL_RUN_REQUESTED,
  MONTHLY_EVAL_BUDGET_USD,
} from '@/lib/evals/start-run'
import {
  LiveAgentHttpError,
  mintRunToken,
  revokeRunToken,
  runTrial,
} from '@/lib/evals/run-trial'
import { caseRunnableBy, latestCompletedRun } from '@/lib/evals/queries'
import type {
  EvalCaseRow,
  EvalCheckRow,
  EvalRunRow,
  EvalTrialRow,
  RunProgress,
} from '@/lib/evals/types'

/**
 * Runs in flight, per workspace.
 *
 * ONE, not four. The spec's "concurrency limit 4" is about TRIALS, and this
 * function's unit of concurrency is a RUN — a run whose trials execute serially
 * inside it. Setting 4 here would let four runs of DIFFERENT suites in one
 * workspace race the monthly budget check, each reading a spend total none of
 * them had written yet, which is the precise failure `concurrency: 1` per
 * workspace exists to prevent (the prospecting lane's reasoning, verbatim).
 *
 * Trial-level parallelism is deliberately NOT taken. Every trial in a live run
 * is a serial chain of 10–14 route calls against the same live-agent route real
 * meetings use, and the throughput four parallel trials would buy is not worth
 * an eval sweep competing with a customer's actual call.
 */
const EVAL_RUN_CONCURRENCY = 1

/** Statuses a run can be claimed from. `running` is accepted for the same
 *  reason prospecting accepts it: a retried attempt necessarily finds its own
 *  row mid-flight, and refusing it would silently turn `retries` into no retry. */
const CLAIMABLE_STATUSES = ['queued', 'running'] as const

/** Enough of the Inngest step tool for this handler. Structural, so the test's
 *  `createStepMock()` satisfies it without importing Inngest's own types. */
type EvalStep = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>
}

/** The suite fields the lane needs: the judge model and the target recipe. */
interface SuiteContext {
  judge_model: string | null
  target_recipe_id: string | null
}

/** Everything one trial needs, assembled once per case. */
interface TrialPlan {
  caseRow: EvalCaseRow
  trialIndex: number
}

export const evalRunExecute = inngest.createFunction(
  {
    id: 'eval-run-requested',
    // One run at a time per workspace. A run is a sequence of billed model
    // calls against a shared monthly budget, and two concurrent runs would race
    // the cap check — both reading a spend total neither had written yet.
    concurrency: [{ limit: EVAL_RUN_CONCURRENCY, key: 'event.data.workspace_id' }],
    // Trials are individually retried inside their own step; the run itself is
    // not worth replaying, because a replayed trial re-bills the model calls the
    // memoized step already paid for.
    retries: 1,
    triggers: [{ event: EVAL_RUN_REQUESTED }],
  },
  async ({ event, step }: { event: { data: unknown }; step: EvalStep }) => {
    const data = event.data as { run_id?: string; workspace_id?: string } | null
    if (!data?.run_id || !data?.workspace_id) return { skipped: 'missing_ids' }
    const { run_id: runId, workspace_id: workspaceId } = data

    const service = getServiceClient()

    // ── 1. CLAIM: queued|running → running ─────────────────────────────────
    // A compare-and-set, not a read-then-write. Losing means the row already
    // reached a terminal status, so we exit idempotently rather than executing
    // — and re-billing — a run that already finished or was cancelled.
    const claimed = await step.run('claim-run', async () => {
      const { data: rows, error } = await service
        .from('eval_run')
        .update({ status: 'running' })
        .eq('id', runId)
        .eq('workspace_id', workspaceId)
        .in('status', CLAIMABLE_STATUSES)
        .select(
          'id, suite_id, mode, speed, trials_per_case, target_recipe_id, target_prompt_hash, target_model, max_cost_usd, progress, started_by, started_at',
        )
      if (error) throw new Error(`eval_run claim failed: ${error.message}`)
      const row = (rows ?? [])[0] as { progress?: { trials_total?: number } | null } | undefined
      if (row) {
        const total = row.progress?.trials_total ?? 0
        const text = total > 0 ? `Running ${total} trial${total === 1 ? '' : 's'}` : 'Running trials'
        await stepEvalWork(service, runId, text, total > 0 ? { done: 0, total } : undefined)
      }
      return ((rows ?? [])[0] ?? null) as
        | (Pick<
            EvalRunRow,
            | 'id'
            | 'suite_id'
            | 'mode'
            | 'speed'
            | 'trials_per_case'
            | 'target_recipe_id'
            | 'target_prompt_hash'
            | 'target_model'
            | 'max_cost_usd'
            | 'started_by'
            | 'started_at'
          > & { progress: RunProgress & { case_ids?: string[] } })
        | null
    })

    if (!claimed) return { skipped: 'not_claimable', runId }
    if (!claimed.started_by) {
      await step.run('fail-no-starter', () =>
        failRun(service, { runId, workspaceId, code: 'no_run_starter', message: 'The run has no starting user, so no trial can authenticate as anyone.' }),
      )
      return { status: 'failed', error: 'no_run_starter', runId }
    }

    // On the starter's own ChatGPT plan (the free tier): the trials run on it
    // (the live-agent route reads the plan), and so do the judges (gradeTrial's
    // `plan`), never Dial8's models. Read here, for every run however it was
    // queued; a check that can't be read throws (the step retries), so no
    // judge ever runs on the Gateway for a plan user by default.
    const starter = claimed.started_by
    let starterOnPlan: boolean
    try {
      starterOnPlan = await step.run('chatgpt-plan-check', () => chatgptPlanFor(starter, { attempts: 2, failClosed: true }))
    } catch {
      // The row is `running` by now: settle it, or the next start of this
      // suite would join a run nothing is executing (idx_eval_run_one_live).
      await step.run('fail-usage-unavailable', () =>
        failRun(service, {
          runId,
          workspaceId,
          code: 'usage_unavailable',
          message: "The usage check couldn't be read, so no trial ran. Start the run again.",
        }),
      )
      return { status: 'failed', error: 'usage_unavailable', runId }
    }
    const judgePlan = starterOnPlan ? { userId: starter, workspaceId } : undefined

    // ── 2. Load the suite and the exact cases this run was priced for ──────
    const plan = await step.run('load-plan', async () => {
      const [suiteRes, caseRes] = await Promise.all([
        service
          .from('eval_suite')
          .select('judge_model, target_recipe_id')
          .eq('id', claimed.suite_id)
          .maybeSingle<SuiteContext>(),
        (() => {
          // `case_ids` was written onto `progress` at queue time precisely so
          // the lane executes the set that was PRICED and budgeted. Re-querying
          // the suite here would silently pick up a case added in between and
          // run past the estimate the user approved.
          const ids = claimed.progress?.case_ids
          let q = service
            .from('eval_case')
            .select(
              'id, suite_id, workspace_id, name, capture_id, capture_is_eval, script, chunks, expected, modes, polarity, seeded_from_capture_id, visibility, created_by, sort_order, created_at, updated_at',
            )
            .eq('suite_id', claimed.suite_id)
            .order('sort_order')
          if (ids?.length) q = q.in('id', ids)
          return q
        })(),
      ])
      return {
        suite: suiteRes.data ?? { judge_model: null, target_recipe_id: null },
        // Defense in depth behind startEvalRun: someone else's PRIVATE case
        // never runs, since this run's trials and checks are readable by every
        // member (caseRunnableBy).
        cases: ((caseRes.data ?? []) as EvalCaseRow[]).filter((c) =>
          caseRunnableBy(c, claimed.started_by),
        ),
      }
    })

    if (plan.cases.length === 0) {
      await step.run('fail-no-cases', () =>
        failRun(service, { runId, workspaceId, code: 'no_cases', message: 'The run has no cases to execute.' }),
      )
      return { status: 'failed', error: 'no_cases', runId }
    }

    // ── 3. Mint the run token ──────────────────────────────────────────────
    // ONE token for the whole run, not one per trial: it is a credential, and
    // minting N of them multiplies the rows that must be cleaned up if the run
    // dies mid-flight. Deleted in the finally below.
    const runStarterUserId = claimed.started_by
    const token = await step.run('mint-run-token', () =>
      mintRunToken(service, { userId: runStarterUserId, workspaceId, runId }),
    )

    const trialsPerCase = claimed.trials_per_case ?? 1
    const plans: TrialPlan[] = plan.cases.flatMap((caseRow) =>
      Array.from({ length: trialsPerCase }, (_, trialIndex) => ({ caseRow, trialIndex })),
    )

    const completed: Array<Pick<EvalTrialRow, 'status' | 'outcome'> & { checks: EvalCheckRow[] }> = []
    let costUsd = 0
    let tokensIn = 0
    let tokensOut = 0
    let stopCode: 'budget' | 'usage_limit' | 'cancelled' | null = null
    let stopMessage: string | null = null

    try {
      for (let i = 0; i < plans.length; i++) {
        const { caseRow, trialIndex } = plans[i]

        // ── Between-trial checks. All three read state written OUTSIDE this
        // handler (a person's cancel, other runs' spend), so they must be
        // re-read every iteration rather than hoisted.
        const gate = await step.run(`gate-${i}`, async () => {
          const { data: row } = await service
            .from('eval_run')
            .select('status')
            .eq('id', runId)
            .maybeSingle<{ status: string }>()
          if (row && !['queued', 'running'].includes(row.status)) {
            return { stop: 'cancelled' as const, message: `The run was ${row.status}.` }
          }
          if (claimed.max_cost_usd !== null && costUsd > Number(claimed.max_cost_usd)) {
            return {
              stop: 'budget' as const,
              message: `Spent $${costUsd.toFixed(4)} against a $${Number(claimed.max_cost_usd).toFixed(4)} ceiling.`,
            }
          }
          const { data: monthRows } = await service
            .from('eval_run')
            .select('cost_usd')
            .eq('workspace_id', workspaceId)
            .gte('started_at', monthStartIso())
          const monthSpend = (monthRows ?? []).reduce(
            (sum, r) => sum + Number((r as { cost_usd: number | string }).cost_usd ?? 0),
            0,
          )
          if (monthSpend > MONTHLY_EVAL_BUDGET_USD) {
            return {
              stop: 'budget' as const,
              message: `This workspace has spent $${monthSpend.toFixed(2)} on evals this month, over the $${MONTHLY_EVAL_BUDGET_USD} cap.`,
            }
          }
          return { stop: null }
        })

        if (gate.stop) {
          stopCode = gate.stop
          stopMessage = gate.message ?? null
          break
        }

        // ── Stage BEFORE the trial, as well as after it. `start-run` writes
        // 'queued', and the after-trial write below is the only other one — so
        // a one-case run read 'queued' for the entire minute it was running,
        // which is exactly the lag the run rail exists to remove. The
        // after-write is what moves `trials_done`; this one only moves the
        // stage, so a replayed step never rewinds the count.
        await step.run(`stage-${i}`, async () => {
          const progress: RunProgress & { case_ids?: string[] } = {
            cases_total: plan.cases.length,
            trials_total: plans.length,
            trials_done: i,
            stage: `trial ${i + 1} of ${plans.length}`,
            ...(claimed.progress?.case_ids ? { case_ids: claimed.progress.case_ids } : {}),
          }
          await service.from('eval_run').update({ progress }).eq('id', runId)
        })

        // ── The trial itself: clone → run → store → grade, all in ONE step.
        // One step, not four: a replay of a partial trial would re-POST the
        // route calls the first attempt already paid for, and Inngest memoizes
        // the STEP's result, never the money.
        let trial: Awaited<ReturnType<typeof executeTrial>>
        try {
          trial = await step.run(`trial-${i}`, () =>
            executeTrial(service, {
              runId,
              workspaceId,
              caseRow,
              trialIndex,
              mode: claimed.mode,
              speed: claimed.speed,
              recipeId: plan.suite.target_recipe_id ?? claimed.target_recipe_id,
              runStarterUserId,
              token: token.token,
              targetModel: claimed.target_model,
              judgeModel: plan.suite.judge_model,
              ...(judgePlan ? { judgePlan } : {}),
            }),
          )
        } catch (err) {
          // A 429/503 is the usage wall — every remaining trial hits the same
          // one, so the RUN fails rather than the trial.
          if (err instanceof LiveAgentHttpError && (err.status === 429 || err.status === 503)) {
            stopCode = 'usage_limit'
            stopMessage = err.message
            break
          }
          throw err
        }

        completed.push({ status: trial.status, outcome: trial.outcome, checks: trial.checks })
        costUsd += trial.costUsd
        tokensIn += trial.tokensIn
        tokensOut += trial.tokensOut

        // Progress and accumulated spend after EVERY trial. The spend write is
        // what makes the next iteration's budget check, and any concurrent
        // run's monthly check, see money that was actually spent.
        await step.run(`progress-${i}`, async () => {
          const progress: RunProgress & { case_ids?: string[] } = {
            cases_total: plan.cases.length,
            trials_total: plans.length,
            trials_done: i + 1,
            stage: `trial ${i + 1} of ${plans.length}`,
            ...(claimed.progress?.case_ids ? { case_ids: claimed.progress.case_ids } : {}),
          }
          await service
            .from('eval_run')
            .update({
              progress,
              cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
              tokens_in: tokensIn,
              tokens_out: tokensOut,
            })
            .eq('id', runId)
          await stepEvalWork(service, runId, `Trial ${i + 1} of ${plans.length} done`, {
            done: i + 1,
            total: plans.length,
          })
        })
      }
    } catch (err) {
      // A throw that is not the usage wall escapes the loop. It must still
      // reach a TERMINAL row before it leaves the handler: `idx_eval_run_one_live`
      // is a partial unique index over (suite_id, mode) for queued|running, so a
      // run left at 'running' is adopted forever by every later start of that
      // suite+mode — the UI polls a run that can never progress and the suite is
      // unrunnable in that mode until someone cancels it by hand.
      //
      // NonRetriableError, not a rethrow: the credential is revoked below, so a
      // retried attempt would replay the remaining trials against a device_token
      // row that no longer exists and 401 on every POST. One terminal failure
      // with a readable code beats a second attempt that cannot succeed.
      const message = err instanceof Error ? err.message : String(err)
      await step.run('fail-harness-error', () =>
        failRun(service, { runId, workspaceId, code: 'harness_error', message }),
      )
      await step.run('revoke-run-token', async () => {
        await revokeRunToken(service, token.tokenId)
        return { revoked: true }
      })
      throw new NonRetriableError(`Eval run failed: ${message}`)
    }

    // The credential dies with the run. Revoked only on a TERMINAL exit (here,
    // and on the throw path above) — never mid-flight, or a retried attempt
    // would replay `mint-run-token` from memo and authenticate with a token
    // whose row this handler already deleted.
    await step.run('revoke-run-token', async () => {
      await revokeRunToken(service, token.tokenId)
      return { revoked: true }
    })

    // ── 4. Roll up and settle ──────────────────────────────────────────────
    const settled = await step.run('settle-run', async () => {
      const { outcome, scores } = runRollup(completed)

      // The baseline is the most recent completed run of the same suite+mode
      // whose prompt hash DIFFERS. Two runs of the same prompt are variance
      // samples, never a before/after pair — that exclusion is the whole reason
      // the hash is denormalized onto the row.
      const baseline = await latestCompletedRun(
        service,
        claimed.suite_id,
        claimed.mode,
        claimed.target_prompt_hash,
      )

      const endedAt = new Date().toISOString()
      const durationMs = Date.now() - new Date(claimed.started_at).getTime()

      const written = await writeRunSettlement(service, runId, {
        status: stopCode === 'usage_limit' ? 'failed' : stopCode ? 'cancelled' : 'completed',
        errorCode: stopCode,
        errorMessage: stopMessage,
        endedAt,
        // A stopped run still reports what its completed trials scored: a
        // half-finished sweep with three real failures is more useful than a
        // blank row, and `error_code` is what says not to read it as a full
        // result.
        results: {
          outcome,
          scores,
          baseline_run_id: baseline?.id ?? null,
          cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          duration_ms: durationMs,
          progress: {
            cases_total: plan.cases.length,
            trials_total: plans.length,
            trials_done: completed.length,
            stage: stopCode ?? 'done',
          },
        },
      })
      // Mirror the row as stored.
      await settleEvalWorkFromRow(service, runId)

      return { outcome, trials: completed.length, cancelledFirst: written.settled === 'after_cancel' }
    })

    if (stopCode === 'usage_limit') {
      // Not retriable by design: the wall is the user's plan limit, and a retry
      // would burn the lane producing the same failure. Thrown AFTER the row is
      // settled, so the run reads `failed` with its code rather than `running`.
      throw new NonRetriableError(`Eval run hit the usage wall: ${stopMessage ?? ''}`)
    }

    // A cancel that landed after the last gate stopped this run too.
    const stopped = stopCode ?? (settled.cancelledFirst ? 'cancelled' : null)
    return {
      status: stopped ? 'stopped' : 'completed',
      runId,
      outcome: settled.outcome,
      trials: settled.trials,
      ...(stopped ? { stopped } : {}),
    }
  },
)

/** What a settled run measured: its cost and what its finished trials scored. */
export interface RunSettlementResults {
  outcome: string | null
  scores: unknown
  baseline_run_id: string | null
  cost_usd: number
  tokens_in: number
  tokens_out: number
  duration_ms: number
  progress: RunProgress
}

/**
 * The lane's final write. The status and its reason move only off a LIVE run,
 * so a cancel that landed during the last trial is terminal: the run stays
 * `cancelled` with the cancel's own reason and end time. `cancelEvalRun` is
 * the only other writer that can end a live run, so a write that finds the
 * run no longer live finds it cancelled.
 *
 * The measured results land either way. `cost_usd` is what the monthly cap
 * sums (start-run.ts), so a cancelled run that spent must still say so, and
 * its finished trials' scores are as real as a completed run's.
 */
export async function writeRunSettlement(
  service: ReturnType<typeof getServiceClient>,
  runId: string,
  args: {
    status: 'completed' | 'cancelled' | 'failed'
    errorCode: string | null
    errorMessage: string | null
    endedAt: string
    results: RunSettlementResults
  },
): Promise<{ settled: 'live' | 'after_cancel' | 'none' }> {
  const { data: live, error } = await service
    .from('eval_run')
    .update({
      status: args.status,
      ended_at: args.endedAt,
      ...args.results,
      ...(args.errorCode ? { error_code: args.errorCode, error_message: args.errorMessage } : {}),
    })
    .eq('id', runId)
    .in('status', ['queued', 'running'])
    .select('id')
  if (error) {
    console.error('[evals] settle write failed:', error.message)
    return { settled: 'none' }
  }
  if ((live ?? []).length > 0) return { settled: 'live' }

  const { data: after, error: afterError } = await service
    .from('eval_run')
    .update({ ...args.results, progress: { ...args.results.progress, stage: 'cancelled' } })
    .eq('id', runId)
    .eq('status', 'cancelled')
    .select('id')
  if (afterError) {
    console.error('[evals] settle-after-cancel write failed:', afterError.message)
    return { settled: 'none' }
  }
  return { settled: (after ?? []).length > 0 ? 'after_cancel' : 'none' }
}

/** First of the current month, ISO — the monthly cap's window. */
function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/** Write a terminal failure onto the run, filtered so it can never clobber a
 *  status the handler already settled. */
async function failRun(
  service: ReturnType<typeof getServiceClient>,
  args: { runId: string; workspaceId: string; code: string; message: string },
): Promise<{ failed: true }> {
  await service
    .from('eval_run')
    .update({
      status: 'failed',
      ended_at: new Date().toISOString(),
      error_code: args.code,
      error_message: args.message,
    })
    .eq('id', args.runId)
    .eq('workspace_id', args.workspaceId)
    .in('status', ['queued', 'running'])
  await settleEvalWorkFromRow(service, args.runId)
  return { failed: true }
}

/** One trial, end to end. Exported for the tests, which drive it directly
 *  rather than through the whole handler. */
export async function executeTrial(
  service: ReturnType<typeof getServiceClient>,
  args: {
    runId: string
    workspaceId: string
    caseRow: EvalCaseRow
    trialIndex: number
    mode: EvalRunRow['mode']
    speed: EvalRunRow['speed']
    recipeId: string | null
    runStarterUserId: string
    token: string
    targetModel: string | null
    judgeModel: string | null
    /** The starter's ChatGPT plan, when the run is on it: the judges run there. */
    judgePlan?: { userId: string; workspaceId: string }
  },
): Promise<{
  status: EvalTrialRow['status']
  outcome: EvalTrialRow['outcome']
  checks: EvalCheckRow[]
  costUsd: number
  tokensIn: number
  tokensOut: number
}> {
  const result = await runTrial(service, {
    caseRow: args.caseRow,
    workspaceId: args.workspaceId,
    runStarterUserId: args.runStarterUserId,
    recipeId: args.recipeId,
    token: args.token,
    targetModel: args.targetModel,
    mode: args.mode,
    speed: args.speed,
  })

  const usage = result.trace.usage
  const status: EvalTrialRow['status'] = result.errorCode ? 'errored' : 'completed'

  const { data: inserted, error: insertError } = await service
    .from('eval_trial')
    .insert({
      run_id: args.runId,
      case_id: args.caseRow.id,
      workspace_id: args.workspaceId,
      trial_index: args.trialIndex,
      capture_id: result.captureId,
      capture_is_eval: true,
      status,
      // An errored trial's outcome is `errored`, NOT a zero. That is the whole
      // point of the fourth state: the compare view must be able to tell a
      // harness failure from a prompt regression.
      outcome: result.errorCode ? 'errored' : null,
      trace: result.trace,
      cost_usd: usage.cost_usd,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      duration_ms: result.durationMs,
      ended_at: new Date().toISOString(),
      ...(result.errorCode
        ? { error_code: result.errorCode, error_message: result.errorMessage }
        : {}),
    })
    .select('id, run_id, case_id, workspace_id, trial_index, capture_id, capture_is_eval, status, outcome, trace, cost_usd, tokens_in, tokens_out, duration_ms, started_at, ended_at, error_code, error_message')
    .single<EvalTrialRow>()

  // A trial whose ROW could not be written is a harness failure, not a clean
  // trial. `status` above was computed from `result.errorCode`, which is
  // undefined here because the trial itself ran fine — returning it as
  // `completed` with `outcome: null` and no checks makes `runRollup` fall
  // through to `passed` for a case that was never stored or graded.
  if (!inserted) {
    console.warn('[evals] trial insert failed:', insertError?.message ?? 'no row')
    return {
      status: 'errored',
      outcome: 'errored',
      checks: [],
      costUsd: usage.cost_usd,
      tokensIn: usage.tokens_in,
      tokensOut: usage.tokens_out,
    }
  }

  // An errored trial is never graded: it produced no behaviour to grade, and
  // manufacturing failed checks for a harness problem is exactly what the
  // errored state exists to prevent.
  if (result.errorCode) {
    return {
      status,
      outcome: 'errored',
      checks: [],
      costUsd: usage.cost_usd,
      tokensIn: usage.tokens_in,
      tokensOut: usage.tokens_out,
    }
  }

  const { checks, usage: grading, gradingFailed } = await gradeTrial(service, {
    trial: inserted,
    caseRow: args.caseRow,
    judgeModel: args.judgeModel,
    workspaceId: args.workspaceId,
    ...(args.judgePlan ? { plan: args.judgePlan } : {}),
  })
  // Checks that were computed but could not be stored are not "no checks": the
  // drafts may have carried failing gates. `errored` is the honest state — the
  // compare view reads it as a harness problem, never as a prompt pass.
  const trialStatus: EvalTrialRow['status'] = gradingFailed ? 'errored' : status
  const outcome: EvalTrialRow['outcome'] = gradingFailed
    ? 'errored'
    : trialOutcomeFromChecks(checks)

  // Grading is spend, and until this write it was invisible: the DEV run
  // reported the target model's $0.000368 while three frontier judge calls had
  // run. The trial's totals ABSORB it (so the run's accumulator and every
  // per-trial reader agree) and the trace keeps the breakdown, so "what did the
  // judges cost" is answerable without re-deriving it.
  const totalCost = usage.cost_usd + grading.cost_usd
  const totalTokensIn = usage.tokens_in + grading.tokens_in
  const totalTokensOut = usage.tokens_out + grading.tokens_out

  await service
    .from('eval_trial')
    .update({
      status: trialStatus,
      outcome,
      cost_usd: totalCost,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      trace: {
        ...result.trace,
        usage: {
          ...usage,
          grading_cost_usd: grading.cost_usd,
          grading_tokens_in: grading.tokens_in,
          grading_tokens_out: grading.tokens_out,
        },
      },
      ...(gradingFailed
        ? {
            error_code: 'grading_not_persisted',
            error_message: 'The trial ran, but its checks could not be written.',
          }
        : {}),
    })
    .eq('id', inserted.id)

  return {
    status: trialStatus,
    outcome,
    checks,
    costUsd: totalCost,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
  }
}

/** Exported so the lane's concurrency is assertable in a test rather than only
 *  readable in a comment. */
export const EVAL_CONCURRENCY = EVAL_RUN_CONCURRENCY
