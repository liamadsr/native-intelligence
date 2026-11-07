/**
 * `gradeTrial` — the one entry point that turns a finished trial into
 * `eval_check` rows.
 *
 * LAYERED CHEAPEST-FIRST (spec §6): deterministic checks over the trace cost
 * nothing, the proposal matcher costs one embedding batch and one model call,
 * and the judges cost one frontier call each. Running them in that order is
 * what makes the bill predictable, and it is also the order a human would
 * check things in.
 *
 * The layers are NOT independent: the deterministic pass returns
 * `proposalsUnknown`, which the matcher reads to downgrade its recall verdicts
 * when a flush was truncated at the step ceiling. Without that thread a
 * budget-bound trial reports as a recall regression, which is the one confusion
 * that would make people distrust the numbers fastest.
 *
 * Every check is written with the trial's own scoping stamped by THIS function,
 * so no individual grader can get `workspace_id` wrong — the same reason
 * `cloneTrialCapture` owns the capture field contract rather than its callers.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { CHECK_FIELDS } from '../queries'
import { scriptToTranscript } from '../create-case'
import type { EvalCaseRow, EvalCheckRow, EvalTrace, EvalTrialRow } from '../types'
import { gradeDeterministic, type DraftCheck } from './deterministic'
import { matchProposals } from './match-proposals'
import { addGradingUsage, runJudges, ZERO_GRADING_USAGE, type GradingUsage, type JudgePlan } from './judges'

export { gradeDeterministic, type DraftCheck } from './deterministic'
export { matchProposals } from './match-proposals'
export {
  runJudges,
  resolveJudgeModel,
  DEFAULT_JUDGE_MODEL_ID,
  type GradingUsage,
} from './judges'

/** What grading one trial produced: its checks, and what the graders' own model
 *  calls cost. The cost is the RUN's, not the user's (spec §6.4) — the caller
 *  adds it to `eval_trial.cost_usd` and to the run's accumulator. */
export type GradeTrialResult = {
  checks: EvalCheckRow[]
  usage: GradingUsage
  /**
   * True when drafts were computed but could NOT be persisted. An empty
   * `checks` is otherwise indistinguishable from the two legitimate empties
   * (no trace, no drafts), and `trialOutcomeFromChecks([])` reads those as
   * `passed` — so without this flag a trial whose gates actually failed would
   * settle the run green. The caller stamps it `errored`.
   */
  gradingFailed?: true
}

/**
 * Grade one trial and persist its checks.
 *
 * @param service the SERVICE client — `eval_check` has a member SELECT policy
 *                and an UPDATE policy for thumbs, but no INSERT policy: the
 *                checks are server-authored, like `flow_run`.
 * @returns the persisted rows, in the order they were graded, so the caller can
 *          roll them up without a second read, plus what the graders spent.
 */
export async function gradeTrial(
  service: SupabaseClient,
  args: {
    trial: EvalTrialRow
    caseRow: EvalCaseRow
    judgeModel: string | null
    workspaceId: string
    /** The run's starter is on their own ChatGPT plan: every judge runs there (./judges.ts JudgePlan). */
    plan?: JudgePlan
  },
): Promise<GradeTrialResult> {
  const trace = args.trial.trace as EvalTrace
  const expected = args.caseRow.expected ?? {}

  // A trial with no trace never ran — an errored clone, a route that was
  // unreachable. Grading it would manufacture failures for a harness problem,
  // which is precisely what `eval_trial.status = 'errored'` exists to prevent.
  if (!trace?.flushes) return { checks: [], usage: ZERO_GRADING_USAGE }

  const { checks: deterministic, proposalsUnknown } = gradeDeterministic(trace, expected, {
    script: args.caseRow.script ?? [],
    chunks: args.caseRow.chunks ?? [],
  })

  // THE transcript the judges read, rendered from the case's own script rather
  // than reconstructed from the flush log. Batch trials post the whole meeting
  // through the capture's `transcript` column, so a trace-derived transcript is
  // only ever as good as what the flush record happens to carry — and when it
  // carried nothing, every judge returned `unknown` saying no transcript was
  // provided. The script is what the case actually asserts about the meeting,
  // so it is the honest input in both modes.
  const transcript = scriptToTranscript(args.caseRow.script ?? [])

  const [matcher, judges] = await Promise.all([
    matchProposals(service, {
      workspaceId: args.workspaceId,
      trace,
      expected,
      proposalsUnknown,
      ...(args.plan ? { plan: args.plan } : {}),
    }),
    runJudges({
      trace,
      ...(args.plan ? { plan: args.plan } : {}),
      expected,
      judgeModel: args.judgeModel,
      transcript,
      chunks: args.caseRow.chunks ?? [],
    }),
  ])

  const usage = addGradingUsage(matcher.usage, judges.usage)

  const drafts: DraftCheck[] = [...deterministic, ...matcher.checks, ...judges.checks]
  if (drafts.length === 0) return { checks: [], usage }

  const rows = drafts.map((draft) => ({
    ...draft,
    trial_id: args.trial.id,
    workspace_id: args.workspaceId,
  }))

  const { data, error } = await service
    .from('eval_check')
    .insert(rows)
    .select(CHECK_FIELDS)

  if (error) {
    // The trial's trace is already persisted, so a failed check insert costs
    // this trial's score and nothing else. Throwing would fail the whole run
    // over one Postgres hiccup, and the lane's retry would re-execute the model
    // calls we already paid for.
    //
    // But it must NOT read as a pass. The drafts we could not store may have
    // held failing gates, so the trial is reported as a HARNESS error — the one
    // state that says "this number is not about the prompt".
    console.warn('[evals] check insert failed:', error.message)
    return { checks: [], usage, gradingFailed: true }
  }
  return { checks: (data ?? []) as EvalCheckRow[], usage }
}
