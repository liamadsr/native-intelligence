/**
 * Shared row fixtures for the Evals UI suites.
 *
 * Every builder returns a COMPLETE row — one field per column of migration 252
 * — with overrides applied last. Partial fixtures are what let a component
 * read a field the test never set and pass by accident; a complete one makes
 * an added column a compile error here rather than a runtime `undefined` on
 * screen.
 */

import type {
  EvalCaseRow,
  EvalRunRow,
  EvalSuiteRow,
  EvalTrialRow,
} from '@/lib/evals/types'
import type { SuiteSummary, TrialWithChecks } from '../api'

export function suiteRow(over: Partial<EvalSuiteRow> = {}): EvalSuiteRow {
  return {
    id: 'suite-1',
    workspace_id: 'ws-1',
    name: 'Sales Discovery',
    description: null,
    target_kind: 'agent',
    target_recipe_id: 'recipe-1',
    suite_kind: 'capability',
    watch: false,
    judge_model: null,
    created_by: 'user-1',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    // Denormalized summary (migration 255) — trigger-owned, so a fresh suite
    // has zero cases and no run.
    case_count: 0,
    last_run_at: null,
    last_run_mode: null,
    last_outcome: null,
    ...over,
  }
}

export function suiteSummary(over: Partial<SuiteSummary> = {}): SuiteSummary {
  return {
    ...suiteRow(),
    case_count: 3,
    last_run: null,
    ...over,
  }
}

export function caseRow(over: Partial<EvalCaseRow> = {}): EvalCaseRow {
  return {
    id: 'case-1',
    suite_id: 'suite-1',
    workspace_id: 'ws-1',
    name: 'Prospect stalls on pricing',
    capture_id: 'capture-1',
    capture_is_eval: true,
    script: [],
    chunks: [],
    expected: {},
    modes: ['batch', 'live'],
    polarity: 'positive',
    seeded_from_capture_id: null,
    visibility: 'workspace',
    created_by: null,
    sort_order: 0,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

/**
 * A run. `is_live` is set INDEPENDENTLY of `status` on purpose: it is a
 * generated column server-side, and a test that derived it here would be
 * asserting the client's guess rather than the server's answer — which is the
 * exact bug the poll's gate exists to prevent.
 */
export function runRow(over: Partial<EvalRunRow> = {}): EvalRunRow {
  const status = over.status ?? 'completed'
  return {
    id: 'run-1',
    suite_id: 'suite-1',
    workspace_id: 'ws-1',
    mode: 'batch',
    speed: 'instant',
    driver: 'server',
    trials_per_case: 1,
    target_recipe_id: 'recipe-1',
    target_prompt_version_id: null,
    target_prompt_hash: 'hash-a',
    target_system_prompt: null,
    target_agent_config: null,
    target_model: null,
    status,
    is_live: status === 'queued' || status === 'running',
    progress: { cases_total: 3, trials_total: 3, trials_done: 3, stage: 'grading' },
    outcome: 'passed',
    scores: {
      proposals: { pass: 5, fail: 1, unknown: 0, skipped: 0, rate: 5 / 6 },
      summary: { pass: 0, fail: 0, unknown: 2, skipped: 0, rate: null },
    },
    estimated_cost_usd: 0.12,
    cost_usd: 0.1043,
    max_cost_usd: 0.36,
    tokens_in: 41200,
    tokens_out: 3100,
    duration_ms: 84_000,
    baseline_run_id: null,
    started_by: 'user-1',
    started_at: '2026-09-01T00:00:00.000Z',
    ended_at: '2026-09-01T00:01:24.000Z',
    error_code: null,
    error_message: null,
    ...over,
  }
}

export function trialRow(over: Partial<TrialWithChecks> = {}): TrialWithChecks {
  const base: EvalTrialRow = {
    id: 'trial-1',
    run_id: 'run-1',
    case_id: 'case-1',
    workspace_id: 'ws-1',
    trial_index: 0,
    capture_id: 'capture-2',
    capture_is_eval: true,
    status: 'completed',
    outcome: 'passed',
    trace: {},
    cost_usd: 0.0119,
    tokens_in: 4100,
    tokens_out: 310,
    duration_ms: 4210,
    is_pinned: false,
    started_at: '2026-09-01T00:00:00.000Z',
    ended_at: '2026-09-01T00:00:04.210Z',
    error_code: null,
    error_message: null,
  }
  return { ...base, checks: [], case_name: 'Prospect stalls on pricing', ...over }
}
