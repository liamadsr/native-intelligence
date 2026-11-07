/**
 * Run-surface fixtures (§15: "the §9 stepper copy renders from that fixture").
 *
 * `progress` and `counts` are the interface between the Inngest writer and the
 * polling UI, and both are untyped jsonb on the wire — which is exactly the
 * shape that degrades silently. Building every UI assertion from a
 * `ProspectingRunProgress`-TYPED literal means a renamed field breaks the
 * compile here rather than producing a permanently blank rail in production
 * that no test catches.
 */

import { PROSPECT_SUPPRESSION_SOURCES } from '@/lib/prospecting/types'
import type {
  ProspectingRunCounts,
  ProspectingRunProgress,
  ProspectingRunStatus,
} from '@/lib/prospecting/types'
import type { RunPayload } from '../api'

export function progress(
  overrides: Partial<ProspectingRunProgress> = {},
): ProspectingRunProgress {
  return {
    stage: 'discover',
    round: 2,
    max_rounds: 2,
    angle_index: 1,
    found: 24,
    suppressed: 6,
    new: 12,
    invalid: 1,
    accounts_done: 0,
    accounts_total: 0,
    people_found: 0,
    people_target: 0,
    spent_dollars: 0.42,
    exa_calls: 6,
    updated_at: '2026-09-04T12:00:00.000Z',
    ...overrides,
  }
}

/**
 * A full `ProspectingRunCounts`, every suppression source at zero except the
 * three the ledger sentence actually renders.
 *
 * The zero floor is built by ITERATING `PROSPECT_SUPPRESSION_SOURCES` so a new
 * source (251 added `over_cap` and `noise_host`) cannot leave this fixture
 * asserting against a shape the engine no longer writes.
 */
export function counts(overrides: Partial<ProspectingRunCounts> = {}): ProspectingRunCounts {
  const zeroed = {} as ProspectingRunCounts
  for (const key of PROSPECT_SUPPRESSION_SOURCES) zeroed[key] = 0
  return {
    ...zeroed,
    this_list: 6,
    crm: 4,
    dismissed_global: 2,
    ...overrides,
  }
}

/** `is_live` is the SERVER's answer, never recomputed from `status` — the
 *  fixtures keep the two independent so a test can pin the poll's gate. */
export function run(
  overrides: Partial<RunPayload> & { status?: ProspectingRunStatus } = {},
): RunPayload {
  const status = overrides.status ?? 'running'
  return {
    id: 'run-1',
    workspace_id: 'ws-1',
    list_id: 'list-1',
    kind: 'discover',
    round_index: 2,
    status,
    stage: 'discover',
    icp_snapshot: null,
    target_entry_ids: null,
    budget_dollars: 2,
    spent_dollars: 0.42,
    exa_calls: 6,
    progress: progress(),
    counts: counts(),
    exclusion_snapshot: null,
    error: null,
    started_by: 'user-1',
    started_at: '2026-09-04T12:00:00.000Z',
    finished_at: null,
    created_at: '2026-09-04T12:00:00.000Z',
    is_live: status === 'running' || status === 'queued' || status === 'canceling',
    ...overrides,
  }
}
