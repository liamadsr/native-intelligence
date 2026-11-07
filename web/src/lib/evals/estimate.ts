/**
 * What a run will cost, before anything executes (spec §10).
 *
 * A pure function over numbers the caller already has — no client, no network,
 * following the `src/lib/prospecting/spend.ts` precedent. It exists so
 * `start_eval_run` and `list_evals` can say "about forty cents" BEFORE the
 * first route call, and so `max_cost_usd` has something to be a multiple of.
 *
 * THE SHAPE OF THE BILL: judges dominate, and by a lot. A live trial is ~12
 * route calls of ~4,500 input and ~350 output tokens on the live-agent default
 * (DeepSeek V4 Flash) with cache breakpoints on the system prompt and the
 * capture-state block; a batch trial is one bigger call. Either way the target
 * costs cents. The judges are five calls per trial on a FRONTIER model over
 * ~5k tokens each, which is an order of magnitude more. That is why
 * `judgeCount` is a parameter and not a constant: turning judges off is the
 * single biggest lever a caller has.
 *
 * These are ESTIMATES from the spec's measured bands, deliberately rounded to
 * the middle of each rather than the top — the run also enforces a live
 * `max_cost_usd` between trials, so the estimate's job is to be honest to the
 * user, not to be a ceiling. Revisit them against real `eval_trial.cost_usd`
 * once there is a month of runs to look at.
 */
import type { EvalMode } from './types'

/** One live trial: ~12 route calls of a ~15-minute mock call (spec §10 band
 *  $0.01–0.02). */
export const ESTIMATED_LIVE_TRIAL_USD = 0.015

/** One batch trial: a single end-of-meeting call (spec §10 band
 *  $0.005–0.015). */
export const ESTIMATED_BATCH_TRIAL_USD = 0.01

/** One judge call on a frontier model over ~5k tokens (spec §10 band
 *  $0.08–0.15 for five judges, so ~$0.02–0.03 each). Rounded to $0.04 because
 *  a judge that quotes evidence writes more than a judge that does not, and an
 *  estimate that surprises upward is worse than one that surprises down. */
export const ESTIMATED_JUDGE_CALL_USD = 0.04

/** Judges graded per trial in a BATCH run: `judge_summary`, `judge_rubric`
 *  and `judge_proposal_quality`. */
export const DEFAULT_JUDGE_COUNT = 3

/** Judges graded per trial in a LIVE run: the batch three plus
 *  `judge_nudges`, which runs on live trials only. */
export const DEFAULT_LIVE_JUDGE_COUNT = DEFAULT_JUDGE_COUNT + 1

/** The default judge count for a mode. */
export function defaultJudgeCount(mode: EvalMode): number {
  return mode === 'live' ? DEFAULT_LIVE_JUDGE_COUNT : DEFAULT_JUDGE_COUNT
}

/**
 * Estimated dollar cost of one run, before it executes.
 *
 * @param caseCount     cases in the run (after any `case_ids` narrowing)
 * @param mode          batch or live — different prompts, different bills
 * @param trialsPerCase attempts per case; multi-attempt runs are variance
 *                      samples and cost linearly
 * @param judgeCount    judges graded per trial; defaults to the mode's
 *                      ({@link defaultJudgeCount}: live adds judge_nudges).
 *                      Pass 0 for a deterministic-only run.
 */
export function estimateRunCostUsd(args: {
  caseCount: number
  mode: EvalMode
  trialsPerCase: number
  judgeCount?: number
}): number {
  const caseCount = Math.max(0, Math.floor(args.caseCount))
  const trialsPerCase = Math.max(0, Math.floor(args.trialsPerCase))
  const judgeCount = Math.max(0, Math.floor(args.judgeCount ?? defaultJudgeCount(args.mode)))

  const trials = caseCount * trialsPerCase
  if (trials === 0) return 0

  const perTrialTarget =
    args.mode === 'live' ? ESTIMATED_LIVE_TRIAL_USD : ESTIMATED_BATCH_TRIAL_USD
  const perTrial = perTrialTarget + judgeCount * ESTIMATED_JUDGE_CALL_USD

  // Six decimals is what `numeric(10,6)` stores; rounding here rather than at
  // the write site keeps the number the user was quoted and the number the row
  // holds identical.
  return Math.round(trials * perTrial * 1_000_000) / 1_000_000
}
