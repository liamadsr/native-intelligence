/**
 * The two spend gates (spec §9), and nothing else.
 *
 * Cost in this feature is real money leaving the building on every Exa call,
 * so both gates are pure, unit-testable functions over numbers the caller has
 * already read — no client, no network, no clock of their own. The run engine
 * owns the reads; this module owns the arithmetic and the constants.
 *
 * TWO GATES, TWO SCOPES:
 *
 *   1. {@link monthlyCapVerdict} — the WORKSPACE ceiling, checked ONCE in
 *      preflight before anything paid. Decision 5: any member can run, and the
 *      damage is bounded at {@link PROSPECTING_MONTHLY_CAP_DOLLARS} for the
 *      whole workspace for the calendar month.
 *   2. {@link budgetVerdict} — the PER-RUN cap, checked BEFORE EACH CALL, not
 *      once per run. §9 is explicit: "max_spend_dollars is checked before each
 *      paid call". Checking after would let the last call overshoot by its own
 *      price, and the whole point of the cap is that the number the consent
 *      screen showed is the number that can be spent.
 *
 * WHY AN ESTIMATE AND NOT THE REAL PRICE: Exa reports `costDollars` in the
 * RESPONSE, so the only cost available before a call is a prediction.
 * {@link ESTIMATED_DISCOVERY_CALL_DOLLARS} is the measured price of a 25-result
 * discovery search (§12), used as the pre-call reservation. Actual spend is
 * always reconciled from `res.costDollars` afterwards, so the estimate can only
 * make the gate slightly EARLY, never late — which is the safe direction.
 */

/**
 * The per-workspace monthly ceiling, in dollars (decision 5).
 *
 * THIS IS A FIRST GUESS. Nothing measured says $20 is the right number; it is
 * roughly 27 default runs at the §12 model ($0.72 each), which felt like "a
 * month of real use for one seller" when the feature was designed and nobody
 * had used it yet. Revisit it once there is a month of real `spent_dollars` to
 * look at — the honest signal is how often a workspace hits it, not what a
 * spreadsheet says it ought to be.
 */
export const PROSPECTING_MONTHLY_CAP_DOLLARS = 20

/**
 * What one discovery call is assumed to cost before it is made.
 *
 * Measured (§12): a `numResults: 25` deep search with three `additionalQueries`
 * cost $0.027. Rounded UP to $0.03 on purpose — a pre-call reservation that
 * under-predicts lets a run finish above its cap, which is exactly the failure
 * the cap exists to prevent.
 */
export const ESTIMATED_DISCOVERY_CALL_DOLLARS = 0.03

/**
 * What one PROSPECT ACCOUNT CARD (§7 Stage 3b) is assumed to cost before it is
 * made.
 *
 * Measured (§12): an own-domain-anchored `numResults: 5` company search with
 * the 9-property flat card cost $0.012–0.015 and 5–15s. $0.013 is the middle
 * of that band rather than the top, and that is a deliberate difference from
 * the discovery estimate above: the account-card loop bills the REAL
 * `costDollars` after every single company and re-checks the gate before the
 * next one, so an under-prediction can overshoot by at most ONE card
 * (~1.5 cents), while an over-prediction would park a run with budget it was
 * never going to spend. The contract names this number and the UI multiplies
 * it by the selection to show "about $0.24" at the consent gate, so it must be
 * the honest expected price, not a conservative one.
 */
export const ESTIMATED_ACCOUNT_CARD_DOLLARS = 0.013

/**
 * What one PEOPLE search (§7 Stage 4) is assumed to cost.
 *
 * Measured (§12): 5 people at quillfort.ai, all with `linkedin.com/in` URLs,
 * all grounded high, **$0.012 and 4.8s** for a `numResults: 10` anchored
 * people search. Same reasoning as the account card: ONE call per company —
 * `people_per_company` caps how many of the returned people are kept, it does
 * not multiply the calls — reconciled from `res.costDollars` immediately after.
 */
export const ESTIMATED_PEOPLE_CALL_DOLLARS = 0.012

/**
 * What ONE ICP card costs — the single own-domain search `fireIcpCard` fires
 * to learn what the workspace's own company sells and to whom.
 *
 * Same call shape as the account card (§12 measured $0.012 for an own-domain
 * anchored search with a flat card schema), so it carries the same number.
 * It lives here rather than as a literal in the one prose string that quotes
 * it because `research_my_company` now REFUSES an un-quoted call that would
 * fire this card, and the refusal has to name the price the model is then
 * expected to quote.
 */
export const ESTIMATED_ICP_CARD_DOLLARS = 0.012

/**
 * How long one per-company call takes, for the gate's "roughly N minutes"
 * line. §12 measured 4.8s for people and 5–15s for an account card; 10s is the
 * honest middle and the copy says "roughly" rather than pretending precision.
 */
export const ESTIMATED_SECONDS_PER_COMPANY = 10

/**
 * How many entries one `account_card` or `people` run may target (§9's
 * guardrail table, "Explicit target_entry_ids selection").
 *
 * The kickoff route rejects a larger `entry_ids` with a 400, so the gate
 * states the number that will actually run rather than letting a 60-company
 * selection surface as a validation error. It also bounds one press's wall
 * clock: 50 companies at ~10s each is already the far end of what a user will
 * sit through.
 */
export const MAX_ENTRIES_PER_TARGETED_RUN = 50

/** Floor and ceiling for a caller-supplied `budget_dollars` override on the
 *  kickoff route. Below the floor a run cannot afford a single call; above the
 *  ceiling one run could eat the entire monthly workspace allowance. */
export const MIN_RUN_BUDGET_DOLLARS = 0.25
export const MAX_RUN_BUDGET_DOLLARS = 20

/** `error` written on a run parked by the monthly ceiling. The UI branches on
 *  this exact string to offer "raise the cap" rather than "try again". */
export const MONTHLY_CAP_ERROR = 'monthly_cap'

/** `error` written on a run parked by its own per-run cap. */
export const RUN_CAP_ERROR = 'run_cap'

// ---------------------------------------------------------------------------
// The per-run budget
// ---------------------------------------------------------------------------

export interface BudgetVerdict {
  /** True when the next call fits under the cap and may be made. */
  ok: boolean
  /** `spent + estimate` — what the run would stand at if the call is made. */
  projected: number
  /** How much room is left BEFORE the call. Never negative. */
  remaining: number
}

/**
 * May the run afford one more call?
 *
 * The rule, verbatim from the contract: `spent + estimated > budget` parks the
 * run. Note the strict `>`: a call that lands exactly ON the cap is allowed,
 * because a $2.00 budget that refuses the call that would make the total
 * exactly $2.00 is a $1.97 budget with a confusing label.
 *
 * A non-finite or negative budget is treated as ZERO rather than as "no
 * limit". An unbounded run is never the safe reading of a corrupt number.
 */
export function budgetVerdict(
  spentDollars: number,
  budgetDollars: number,
  estimatedCallDollars: number = ESTIMATED_DISCOVERY_CALL_DOLLARS,
): BudgetVerdict {
  const spent = safeAmount(spentDollars)
  const budget = safeAmount(budgetDollars)
  const estimate = safeAmount(estimatedCallDollars)
  const projected = round6(spent + estimate)
  return {
    ok: projected <= budget,
    projected,
    remaining: round6(Math.max(0, budget - spent)),
  }
}

// ---------------------------------------------------------------------------
// The monthly workspace ceiling
// ---------------------------------------------------------------------------

export interface MonthlyCapVerdict {
  ok: boolean
  /** The workspace's spend so far this calendar month, EXCLUDING this run. */
  spent: number
  cap: number
  remaining: number
}

/**
 * Is the workspace under its monthly ceiling?
 *
 * `spentThisMonth` is summed by the caller from `prospecting_run.spent_dollars`
 * for the current UTC calendar month, **excluding the run being started** — a
 * retry of a run that already spent $3 must not count that $3 against itself
 * twice.
 *
 * The comparison is `>=`, not `>`: a workspace already exactly at the cap has
 * no room for a call, and a run admitted there would spend past it on its
 * first search.
 */
export function monthlyCapVerdict(
  spentThisMonth: number,
  cap: number = PROSPECTING_MONTHLY_CAP_DOLLARS,
): MonthlyCapVerdict {
  const spent = safeAmount(spentThisMonth)
  const ceiling = safeAmount(cap)
  return {
    ok: spent < ceiling,
    spent,
    cap: ceiling,
    remaining: round6(Math.max(0, ceiling - spent)),
  }
}

/**
 * The inclusive start of the UTC calendar month containing `now`, as an ISO
 * string for a `.gte('created_at', …)` filter.
 *
 * UTC, deliberately and consistently: a workspace-wide budget cannot be
 * scoped to one member's timezone, and the alternative — the workspace
 * owner's local month — would make the ceiling move when they travel.
 */
export function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/** Sum a page of run rows' `spent_dollars`, tolerating nulls and the strings
 *  PostgREST returns for `numeric` columns on some client versions. */
export function sumSpend(rows: readonly { spent_dollars?: unknown }[]): number {
  let total = 0
  for (const row of rows) total += safeAmount(row?.spent_dollars)
  return round6(total)
}

// ---------------------------------------------------------------------------

/**
 * Clamp a caller-supplied per-run budget into the allowed band. A missing or
 * unusable value falls back to `fallback` (the list's own `max_spend_dollars`),
 * which is itself clamped — a corrupt column must not create an unbounded run.
 */
export function clampRunBudget(requested: unknown, fallback: number): number {
  const raw = safeAmount(requested)
  const base = raw > 0 ? raw : safeAmount(fallback)
  if (base <= 0) return MIN_RUN_BUDGET_DOLLARS
  return round6(Math.min(MAX_RUN_BUDGET_DOLLARS, Math.max(MIN_RUN_BUDGET_DOLLARS, base)))
}

/** A number, or 0 for anything that is not a usable non-negative amount.
 *  Accepts the numeric-as-string shape PostgREST can return. */
function safeAmount(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

/** `spent_dollars` is `numeric(10,6)`; keeping the in-memory number at the same
 *  precision stops float drift from turning $0.11 into $0.11000000000000001 in
 *  the progress payload the UI renders. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
