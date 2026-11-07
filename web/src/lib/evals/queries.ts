/**
 * The Evals data-access layer: reads, and nothing else.
 *
 * Every function takes the Supabase client as its first argument and does NO
 * auth of its own — the routes pass the RLS-scoped client after
 * `requireWorkspace`, the Inngest lane and the chat tools pass the service
 * client. That split is the same one `src/lib/prospecting/lists.ts` states at
 * its top, and it is why every query here carries an explicit `workspace_id`
 * (or an id already resolved under one): RLS is never the only boundary.
 *
 * WHY THE FIELD LISTS ARE EXPORTED CONSTANTS: three of these tables carry fat
 * jsonb columns — a case's `script` and `chunks`, a trial's `trace` — that are
 * kilobytes each and useless in a list. `*_LIST_FIELDS` omits them, so the
 * suite screen and the run detail load a page of rows instead of a megabyte of
 * transcripts. Anything that actually needs the jsonb asks for one row by id
 * with the full `*_FIELDS`.
 *
 * Reads return `null`/`[]` on failure after logging, rather than throwing: the
 * callers are routes and tools that turn an absent row into a 404, and a
 * thrown error there reads as a 500 the user cannot act on.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  EvalCaseRow,
  EvalCheckRow,
  EvalMode,
  EvalRunRow,
  EvalSuiteRow,
  EvalTrialRow,
  RunOutcome,
} from './types'

/**
 * May this run starter's run execute this case?
 *
 * Runs load cases on the SERVICE client, and a run's trials and checks (the
 * trace's chunk text, nudge evidence, judge quotes) are readable by every
 * member. So a `private` case, which only its creator can read (eval_case's
 * SELECT policy), runs only when its creator starts the run; anyone else's
 * run skips it rather than republishing its transcript workspace-wide. Pure.
 */
export function caseRunnableBy(
  row: { visibility?: string | null; created_by?: string | null },
  runStarterUserId: string | null | undefined,
): boolean {
  if (row.visibility !== 'private') return true
  return !!runStarterUserId && row.created_by === runStarterUserId
}

// ---------------------------------------------------------------------------
// Field lists
// ---------------------------------------------------------------------------

export const SUITE_FIELDS = `
  id, workspace_id, name, description, target_kind, target_recipe_id,
  suite_kind, watch, judge_model, created_by, created_at, updated_at,
  case_count, last_run_at, last_run_mode, last_outcome
` as const

/** No `script`, `chunks` or `expected` — the three fat columns. A case list
 *  renders name, polarity, modes and counts, none of which need a transcript. */
export const CASE_LIST_FIELDS = `
  id, suite_id, workspace_id, name, capture_id, capture_is_eval, modes,
  polarity, seeded_from_capture_id, visibility, created_by, sort_order,
  created_at, updated_at
` as const

export const CASE_FIELDS = `
  id, suite_id, workspace_id, name, capture_id, capture_is_eval, script, chunks,
  expected, modes, polarity, seeded_from_capture_id, visibility, created_by,
  sort_order, created_at, updated_at
` as const

export const RUN_FIELDS = `
  id, suite_id, workspace_id, mode, speed, driver, trials_per_case,
  target_recipe_id, target_prompt_version_id, target_prompt_hash,
  target_system_prompt, target_agent_config, target_model, status, is_live,
  progress, outcome, scores, estimated_cost_usd, cost_usd, max_cost_usd,
  tokens_in, tokens_out, duration_ms, baseline_run_id, started_by, started_at,
  ended_at, error_code, error_message
` as const

/** No `trace`. A run detail lists one row per trial; the trace loads when a
 *  row is opened. */
export const TRIAL_LIST_FIELDS = `
  id, run_id, case_id, workspace_id, trial_index, capture_id, capture_is_eval,
  status, outcome, cost_usd, tokens_in, tokens_out, duration_ms, is_pinned,
  started_at, ended_at, error_code, error_message
` as const

export const TRIAL_FIELDS = `
  id, run_id, case_id, workspace_id, trial_index, capture_id, capture_is_eval,
  status, outcome, trace, cost_usd, tokens_in, tokens_out, duration_ms,
  is_pinned, started_at, ended_at, error_code, error_message
` as const

export const CHECK_FIELDS = `
  id, trial_id, workspace_id, dimension, grader, check_key, label, severity,
  outcome, score, threshold, rationale, evidence, human_override, human_note,
  created_at
` as const

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

/**
 * One row of the Evals index: the suite, how many cases it holds, and how its
 * last run went.
 *
 * The three summary facts are REAL columns on eval_suite since migration 255
 * (triggers on eval_case / eval_run keep them current). `last_run` is still
 * exposed as a nested object because both chat tools return it verbatim and a
 * shape change would ripple into their prompts — but it carries NO run id any
 * more: nothing reads one, and looking it up would put back the extra query
 * 255 exists to remove.
 */
export type SuiteWithSummary = EvalSuiteRow & {
  case_count: number
  last_run: { outcome: RunOutcome | null; started_at: string; mode: EvalMode } | null
}

/**
 * The Evals index. ONE read: migration 255 denormalized the case count and the
 * last run onto eval_suite, so the two child-table sweeps this used to do are
 * gone. `last_outcome` and `last_run_at` disagree on purpose — the timestamp
 * follows the most recent run of ANY status, the outcome the most recent
 * SETTLED one, so a queued run says "running now" without wiping the previous
 * verdict.
 */
export async function listSuites(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<SuiteWithSummary[]> {
  const { data, error } = await supabase
    .from('eval_suite')
    .select(SUITE_FIELDS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[evals] listSuites failed:', error.message)
    return []
  }

  return ((data ?? []) as unknown as (EvalSuiteRow & {
    case_count: number | null
    last_run_at: string | null
    last_run_mode: EvalMode | null
    last_outcome: RunOutcome | null
  })[]).map((s) => ({
    ...s,
    case_count: s.case_count ?? 0,
    last_run: s.last_run_at
      ? {
          outcome: s.last_outcome,
          started_at: s.last_run_at,
          mode: s.last_run_mode ?? 'batch',
        }
      : null,
  }))
}

/** One suite, scoped to the workspace. `null` when it does not exist there. */
export async function getSuite(
  supabase: SupabaseClient,
  workspaceId: string,
  suiteId: string,
): Promise<EvalSuiteRow | null> {
  const { data, error } = await supabase
    .from('eval_suite')
    .select(SUITE_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('id', suiteId)
    .maybeSingle()

  if (error) {
    console.error('[evals] getSuite failed:', error.message)
    return null
  }
  return (data as unknown as EvalSuiteRow | null) ?? null
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/**
 * A suite's cases in authoring order. LIST fields only — a suite of twenty
 * cases carries twenty transcripts, and the screen shows none of them.
 */
export async function listCases(
  supabase: SupabaseClient,
  suiteId: string,
): Promise<EvalCaseRow[]> {
  const { data, error } = await supabase
    .from('eval_case')
    .select(CASE_LIST_FIELDS)
    .eq('suite_id', suiteId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[evals] listCases failed:', error.message)
    return []
  }
  return (data ?? []) as unknown as EvalCaseRow[]
}

/** One case with its script, chunks and expected outcomes — what the case
 *  editor and every trial need. */
export async function getCase(
  supabase: SupabaseClient,
  caseId: string,
): Promise<EvalCaseRow | null> {
  const { data, error } = await supabase
    .from('eval_case')
    .select(CASE_FIELDS)
    .eq('id', caseId)
    .maybeSingle()

  if (error) {
    console.error('[evals] getCase failed:', error.message)
    return null
  }
  return (data as unknown as EvalCaseRow | null) ?? null
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** A suite's runs, newest first — the runs strip and the sparkline. */
export async function listRuns(
  supabase: SupabaseClient,
  suiteId: string,
  limit = 20,
): Promise<EvalRunRow[]> {
  const { data, error } = await supabase
    .from('eval_run')
    .select(RUN_FIELDS)
    .eq('suite_id', suiteId)
    .order('started_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[evals] listRuns failed:', error.message)
    return []
  }
  return (data ?? []) as unknown as EvalRunRow[]
}

/** One trial of a run detail: the row, its checks, and the case's name (which
 *  is what the screen actually labels the row with). */
export type TrialWithChecks = EvalTrialRow & {
  checks: EvalCheckRow[]
  case_name: string
}

/**
 * A run and everything under it. Trials come back WITHOUT their traces — the
 * run detail lists one row per case and loads a trace only when a row is
 * opened, and a twenty-case run's traces together are megabytes.
 */
export async function getRunDetail(
  supabase: SupabaseClient,
  runId: string,
): Promise<{ run: EvalRunRow; trials: TrialWithChecks[] } | null> {
  const { data: runData, error: runError } = await supabase
    .from('eval_run')
    .select(RUN_FIELDS)
    .eq('id', runId)
    .maybeSingle()

  if (runError) {
    console.error('[evals] getRunDetail run read failed:', runError.message)
    return null
  }
  const run = (runData as unknown as EvalRunRow | null) ?? null
  if (!run) return null

  const { data: trialData, error: trialError } = await supabase
    .from('eval_trial')
    .select(TRIAL_LIST_FIELDS)
    .eq('run_id', runId)
    .order('trial_index', { ascending: true })

  if (trialError) {
    console.error('[evals] getRunDetail trials read failed:', trialError.message)
    return { run, trials: [] }
  }
  const trials = (trialData ?? []) as unknown as EvalTrialRow[]
  if (trials.length === 0) return { run, trials: [] }

  const trialIds = trials.map((t) => t.id)
  const caseIds = [...new Set(trials.map((t) => t.case_id))]

  const { data: checkData } = await supabase
    .from('eval_check')
    .select(CHECK_FIELDS)
    .in('trial_id', trialIds)
    .order('created_at', { ascending: true })

  const checksByTrial = new Map<string, EvalCheckRow[]>()
  for (const check of (checkData ?? []) as unknown as EvalCheckRow[]) {
    const list = checksByTrial.get(check.trial_id)
    if (list) list.push(check)
    else checksByTrial.set(check.trial_id, [check])
  }

  const { data: caseData } = await supabase
    .from('eval_case')
    .select('id, name')
    .in('id', caseIds)

  const caseNames = new Map<string, string>()
  for (const row of (caseData ?? []) as { id: string; name: string }[]) {
    caseNames.set(row.id, row.name)
  }

  return {
    run,
    trials: trials.map((t) => ({
      ...t,
      checks: checksByTrial.get(t.id) ?? [],
      case_name: caseNames.get(t.case_id) ?? '',
    })),
  }
}

/**
 * The baseline for a compare view: the most recent COMPLETED run of the same
 * suite and mode.
 *
 * `excludingHash` is the whole point. Two runs of the same prompt are variance
 * samples, never a before/after pair (spec §6.6) — pass the candidate run's
 * `target_prompt_hash` and the baseline resolves to the last run that tested
 * something DIFFERENT, or to nothing at all if this prompt is the only one
 * ever run.
 */
export async function latestCompletedRun(
  supabase: SupabaseClient,
  suiteId: string,
  mode: EvalMode,
  excludingHash?: string,
): Promise<EvalRunRow | null> {
  let query = supabase
    .from('eval_run')
    .select(RUN_FIELDS)
    .eq('suite_id', suiteId)
    .eq('mode', mode)
    .eq('status', 'completed')
    .order('started_at', { ascending: false })
    .limit(1)

  if (excludingHash) query = query.neq('target_prompt_hash', excludingHash)

  const { data, error } = await query
  if (error) {
    console.error('[evals] latestCompletedRun failed:', error.message)
    return null
  }
  const rows = (data ?? []) as unknown as EvalRunRow[]
  return rows[0] ?? null
}
