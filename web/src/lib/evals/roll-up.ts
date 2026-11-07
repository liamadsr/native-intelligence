/**
 * The roll-up: checks → a trial outcome, trials → a run outcome and per-dimension
 * scores (spec §6.6).
 *
 * Two pure functions, no client and no I/O, so both drivers and the re-grade
 * path (`grade_eval_run`, P1) reach the same number from the same rows. That
 * matters more than it sounds: a run's headline outcome is the thing a prompt
 * edit is judged by, and it must never depend on WHICH code path assembled it.
 *
 * THE ONE RULE THAT IS EASY TO GET WRONG: `unknown` and `skipped` are excluded
 * from the denominator. They are not zeros.
 *
 *   `unknown` — the grader ran and could not decide (a judge that would not
 *               commit, a flush truncated at the step ceiling so the proposals
 *               dimension measures the budget rather than the prompt).
 *   `skipped` — the grader could not run at all (no gateway credentials, no
 *               summary was written so `judge_summary` has nothing to read).
 *
 * Counting either as a fail would make a missing API key look exactly like a
 * regression, which is the single fastest way to make an eval suite untrusted.
 * A dimension whose every check was unknown/skipped therefore scores `rate:
 * null` — 0/0 is not 0 — and contributes nothing to the run outcome.
 */
import { EVAL_DIMENSIONS } from './types'
import type {
  DimensionScore,
  EvalCheckRow,
  EvalTrialRow,
  RunOutcome,
  RunScores,
  TrialOutcome,
} from './types'

/** The check fields the roll-up actually reads. Narrowed so a caller holding a
 *  freshly-graded array (not yet a persisted row) can pass it straight in. */
type RollupCheck = Pick<EvalCheckRow, 'dimension' | 'severity' | 'outcome'>

/** The trial fields the roll-up reads. `status` matters as much as `outcome`:
 *  an errored trial is a HARNESS failure and never scores. */
type RollupTrial = Pick<EvalTrialRow, 'status' | 'outcome'>

/**
 * One trial's outcome from its checks.
 *
 *   `failed` — any GATE check failed.
 *   `scored` — every gate passed but a soft check failed.
 *   `passed` — nothing failed.
 *
 * A trial with NO checks at all is `passed`: there was nothing to fail. That is
 * the honest reading — a case with an empty `expected` asserts nothing — and it
 * keeps a grader outage from silently reading as a regression (the missing
 * judges emit `skipped` rows, which are not failures either).
 *
 * Never returns `errored`: that is a HARNESS state the caller stamps from the
 * trial's own status, because a route that returned `auto_archived_junk`
 * produced no checks to roll up in the first place.
 */
export function trialOutcomeFromChecks(checks: RollupCheck[]): TrialOutcome {
  let softFailed = false
  for (const check of checks) {
    if (check.outcome !== 'fail') continue
    if (check.severity === 'gate') return 'failed'
    softFailed = true
  }
  return softFailed ? 'scored' : 'passed'
}

/** An empty tally for one dimension. */
function emptyScore(): DimensionScore {
  return { pass: 0, fail: 0, unknown: 0, skipped: 0, rate: null }
}

/**
 * Per-dimension aggregates over every check in a run.
 *
 * `rate = pass / (pass + fail)` — unknown and skipped are outside the
 * denominator (see the module doc). A dimension with no decided checks keeps
 * `rate: null`, which the UI renders as "—" rather than as a zero.
 *
 * Only dimensions that actually have checks appear in the result: a run of
 * batch-only cases has no `nudges` key, and an absent key reads correctly as
 * "not measured" where a `{pass:0,fail:0,rate:null}` key would read as
 * "measured and inconclusive".
 */
export function scoresFromChecks(checks: RollupCheck[]): RunScores {
  const scores: RunScores = {}
  for (const check of checks) {
    // A dimension outside the vocabulary would be a row the DB CHECK refused,
    // but a stored run from an older shape must still aggregate rather than
    // throw — hence the tolerant lookup rather than an assertion.
    const key = check.dimension
    const bucket = (scores[key] ??= emptyScore())
    bucket[check.outcome] += 1
  }
  for (const key of Object.keys(scores)) {
    const bucket = scores[key]
    const decided = bucket.pass + bucket.fail
    bucket.rate = decided === 0 ? null : bucket.pass / decided
  }
  return scores
}

/**
 * The run's outcome and scores from its trials and their checks.
 *
 *   `failed` — any trial failed, OR any trial errored. An errored trial is a
 *              harness failure and the run cannot claim to have passed while
 *              one of its cases never actually ran; the trial's `error_code` is
 *              what tells the two apart in the UI.
 *   `scored` — no failures, but at least one trial only scored.
 *   `passed` — every trial passed.
 *
 * A run with no trials is `failed`: a run that executed nothing has not proved
 * anything, and reporting green would be the worst possible default for a
 * regression suite.
 */
export function runRollup(
  trials: Array<RollupTrial & { checks: RollupCheck[] }>,
): { outcome: RunOutcome; scores: RunScores } {
  const scores = scoresFromChecks(trials.flatMap((t) => t.checks))

  if (trials.length === 0) return { outcome: 'failed', scores }

  let anyScored = false
  for (const trial of trials) {
    if (trial.status === 'errored' || trial.outcome === 'errored' || trial.outcome === 'failed') {
      return { outcome: 'failed', scores }
    }
    if (trial.outcome === 'scored') anyScored = true
  }
  return { outcome: anyScored ? 'scored' : 'passed', scores }
}

/** Every dimension the roll-up can produce, in display order. Exported so the
 *  run-detail screen can render a stable column set rather than whatever keys
 *  one run happened to fill. */
export const ROLLUP_DIMENSIONS = EVAL_DIMENSIONS
