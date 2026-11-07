/**
 * Client-side fetch layer for the Evals UI — one place that knows the route
 * shapes (src/app/api/account/evals/*) and the error envelope
 * ({ error, code, details } via src/lib/api-errors).
 *
 * Modelled on src/app/account/(dashboard)/prospecting/api.ts, including the
 * thrown-error class carrying the parsed code, because Evals has the same one
 * non-generic failure the UI must branch on: `budget_exceeded` (409 from the
 * monthly eval ceiling) is a fixable state with its own banner, not a toast.
 *
 * TWO deliberate non-throws:
 *
 *  1. `startRun` returns 202 with `adopted: true` when the one-live-run unique
 *     index already held a run for this suite+mode. That is the database
 *     refusing a duplicate, which is the guarantee working — the UI adopts the
 *     in-flight run rather than showing a failure (spec §4.1).
 *  2. `cancelRun` answers 409 only when the run had already settled; the route
 *     returns the run either way, so the caller re-reads the real status
 *     instead of guessing.
 */

import type {
  EvalCaseRow,
  EvalCheckRow,
  EvalMode,
  EvalParticipant,
  EvalRunRow,
  EvalSpeed,
  EvalSuiteKind,
  EvalSuiteRow,
  EvalTargetKind,
  EvalTrialRow,
} from '@/lib/evals/types'
import type { SuiteWithSummary } from '@/lib/evals/queries'

// ── Shapes returned by the routes ────────────────────────────────────────

/**
 * One row of the Evals index. Aliased to the server's own summary type rather
 * than re-declared, so a renamed field moves the compile here instead of
 * leaving the index rendering `undefined` under a correct-looking header.
 *
 * The INDEX itself no longer fetches this — it runs on the views system now.
 * The shape survives for `list_evals` (chat + MCP) and the `/create-eval`
 * skill, which read GET /suites.
 */
export type SuiteSummary = SuiteWithSummary

/** The recipe a suite grades, resolved from `target_recipe_id`. `null` when
 *  the suite names no recipe, or when the one it names is gone or invisible to
 *  this caller — the page then says "an agent" rather than naming one. */
export interface SuiteTarget {
  id: string
  name: string
  category: string
}

/** GET /suites/[id] — the suite, its cases (list fields: no script/chunks/
 *  expected), its run history newest first, and the target recipe by NAME.
 *
 *  `target` is optional on the type because an older client payload (or a test
 *  fixture written before it existed) simply omits it, and a suite that cannot
 *  name its target must still render. */
export interface SuiteDetailPayload {
  suite: EvalSuiteRow
  cases: EvalCaseRow[]
  runs: EvalRunRow[]
  target?: SuiteTarget | null
}

/** One trial on a run detail. Traces are NOT included — the route returns
 *  `TRIAL_LIST_FIELDS`, and a twenty-case run's traces together are megabytes.
 *  A trial's trace loads when its row is opened. */
export type TrialWithChecks = EvalTrialRow & {
  checks: EvalCheckRow[]
  case_name: string
}

export interface RunDetailPayload {
  run: EvalRunRow
  trials: TrialWithChecks[]
}

/** POST /runs — 202. `adopted` says the unique index handed back a run that
 *  was already in flight rather than creating a new one. */
export interface StartRunResult {
  run: EvalRunRow
  adopted: boolean
  estimated_cost_usd: number
}

// ── Errors ───────────────────────────────────────────────────────────────

export interface EvalsApiError {
  message: string
  /** The envelope code ('budget_exceeded', 'RUN_ALREADY_LIVE', 'BAD_REQUEST', …). */
  code: string
  details: Record<string, unknown> | null
  status: number
}

export class EvalsRequestError extends Error {
  apiError: EvalsApiError
  constructor(apiError: EvalsApiError) {
    super(apiError.message)
    this.name = 'EvalsRequestError'
    this.apiError = apiError
  }
}

async function parseError(res: Response): Promise<EvalsApiError> {
  let body: Record<string, unknown> = {}
  try {
    body = await res.json()
  } catch {
    /* non-JSON error body */
  }
  const details =
    body.details && typeof body.details === 'object'
      ? (body.details as Record<string, unknown>)
      : null
  return {
    message: typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
    // The envelope's own `code` is the contract (@/lib/api-errors); `details.code`
    // is only a fallback for any route that still tucks it in there.
    code:
      (typeof body.code === 'string' && body.code !== 'BAD_REQUEST' ? body.code : null) ??
      (details && typeof details.code === 'string' ? details.code : null) ??
      (typeof body.code === 'string' ? body.code : 'UNKNOWN'),
    details,
    status: res.status,
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new EvalsRequestError(await parseError(res))
  return (await res.json()) as T
}

/** The parsed code for a thrown request error, or null for anything else. */
export function errorCode(err: unknown): string | null {
  return err instanceof EvalsRequestError ? err.apiError.code : null
}

/** A message safe to show the user for any thrown value. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof EvalsRequestError) return err.apiError.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

function jsonBody(body: unknown): RequestInit {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

// ── Suites ───────────────────────────────────────────────────────────────

export async function fetchSuites(): Promise<SuiteSummary[]> {
  // The route answers `{ suites: [...] }`, NOT a bare array — unwrap it here.
  // `jsonOrThrow` is an unchecked cast, so typing the body as the array would
  // compile cleanly and hand every caller an object with no `.map`: a render
  // crash rather than an empty list.
  const body = await jsonOrThrow<{ suites?: SuiteSummary[] }>(
    await fetch('/api/account/evals/suites'),
  )
  return Array.isArray(body?.suites) ? body.suites : []
}

export interface CreateSuiteBody {
  name: string
  description?: string | null
  target_kind: EvalTargetKind
  target_recipe_id?: string | null
  suite_kind?: EvalSuiteKind
  judge_model?: string | null
}

export async function createSuite(body: CreateSuiteBody): Promise<EvalSuiteRow> {
  const data = await jsonOrThrow<{ suite: EvalSuiteRow }>(
    await fetch('/api/account/evals/suites', { method: 'POST', ...jsonBody(body) }),
  )
  return data.suite
}

export async function fetchSuite(suiteId: string): Promise<SuiteDetailPayload> {
  return jsonOrThrow<SuiteDetailPayload>(await fetch(`/api/account/evals/suites/${suiteId}`))
}

export interface UpdateSuiteBody {
  name?: string
  description?: string | null
  suite_kind?: EvalSuiteKind
  watch?: boolean
  judge_model?: string | null
  target_recipe_id?: string | null
}

export async function patchSuite(
  suiteId: string,
  body: UpdateSuiteBody,
): Promise<EvalSuiteRow> {
  const data = await jsonOrThrow<{ suite: EvalSuiteRow }>(
    await fetch(`/api/account/evals/suites/${suiteId}`, { method: 'PATCH', ...jsonBody(body) }),
  )
  return data.suite
}

/**
 * Delete a suite and everything under it.
 *
 * Refused with code `RUN_ALREADY_LIVE` (409) while a run is in flight:
 * `eval_run` cascades from the suite, so a mid-run delete would drop the row an
 * Inngest step is about to write.
 */
export async function deleteSuite(suiteId: string): Promise<void> {
  await jsonOrThrow<{ deleted: true; id: string }>(
    await fetch(`/api/account/evals/suites/${suiteId}`, { method: 'DELETE' }),
  )
}

// ── Cases ────────────────────────────────────────────────────────────────

/** This suite's cases — LIST fields only (no script, chunks or expected). */
export async function fetchCases(suiteId: string): Promise<EvalCaseRow[]> {
  const body = await jsonOrThrow<{ cases?: EvalCaseRow[] }>(
    await fetch(`/api/account/evals/suites/${suiteId}/cases`),
  )
  return Array.isArray(body?.cases) ? body.cases : []
}

/**
 * One case, with its script, frozen chunks and expected outcomes — AND the
 * template capture's participants.
 *
 * The participants are not decoration. `participants` on a PATCH replaces the
 * list wholesale, so an editor that dropped them here could only ever send a
 * partial list, and every save would delete the speakers it had not seen.
 */
export async function fetchCase(
  caseId: string,
): Promise<{ case: EvalCaseRow; participants: EvalParticipant[] }> {
  const data = await jsonOrThrow<{ case: EvalCaseRow; participants?: EvalParticipant[] }>(
    await fetch(`/api/account/evals/cases/${caseId}`),
  )
  return { case: data.case, participants: Array.isArray(data.participants) ? data.participants : [] }
}

export async function deleteCase(caseId: string): Promise<void> {
  await jsonOrThrow<{ deleted: true; id: string }>(
    await fetch(`/api/account/evals/cases/${caseId}`, { method: 'DELETE' }),
  )
}

// ── Runs ─────────────────────────────────────────────────────────────────

/**
 * `is_live` comes from the SERVER — it is a GENERATED column on `eval_run`
 * (`status in ('queued','running')`), and the poll gates on it rather than on a
 * client-side status list. A loop that recomputed liveness locally would have
 * to keep its own copy of a five-value CHECK constraint in step with the
 * migration, which is exactly the bug the generated column exists to prevent.
 */
export async function fetchRuns(suiteId: string, limit?: number): Promise<EvalRunRow[]> {
  const qs = limit === undefined ? '' : `&limit=${limit}`
  const body = await jsonOrThrow<{ runs?: EvalRunRow[] }>(
    await fetch(`/api/account/evals/runs?suite_id=${encodeURIComponent(suiteId)}${qs}`),
  )
  return Array.isArray(body?.runs) ? body.runs : []
}

export interface StartRunBody {
  suite_id: string
  mode: EvalMode
  speed?: EvalSpeed
  trials_per_case?: number
  case_ids?: string[]
}

/**
 * Queue a run. Answers 202 — nothing has executed when it returns.
 *
 * A second press while a run of the same suite+mode is live comes back with
 * `adopted: true` and the run already in flight, because `startEvalRun` adopts
 * on the unique-index conflict. A double-click and the chat tool racing the UI
 * therefore converge on ONE run rather than one of them erroring.
 *
 * Throws {@link EvalsRequestError} with code `budget_exceeded` (409) when the
 * workspace's monthly eval ceiling would be crossed.
 */
export async function startRun(body: StartRunBody): Promise<StartRunResult> {
  return jsonOrThrow<StartRunResult>(
    await fetch('/api/account/evals/runs', { method: 'POST', ...jsonBody(body) }),
  )
}

/** One run with its trials and their checks — the run-detail payload. Trials
 *  arrive WITHOUT traces; this is the 3s poll target while a run is live. */
export async function fetchRun(runId: string): Promise<RunDetailPayload> {
  return jsonOrThrow<RunDetailPayload>(await fetch(`/api/account/evals/runs/${runId}`))
}

/**
 * Ask a live run to stop.
 *
 * A run that had ALREADY settled answers 409 `NOT_CANCELABLE` and this throws —
 * the error envelope carries the real status in `details` but no `run`, so there
 * is nothing to adopt. That is not a failure to report to the user: pressing
 * Stop a second after a run finished did exactly what was asked. Callers branch
 * on `errorCode(err) === 'NOT_CANCELABLE'` and stay quiet, then re-read.
 */
export async function cancelRun(runId: string): Promise<EvalRunRow> {
  const data = await jsonOrThrow<{ run: EvalRunRow; status: string }>(
    await fetch(`/api/account/evals/runs/${runId}/cancel`, { method: 'POST' }),
  )
  return data.run
}
