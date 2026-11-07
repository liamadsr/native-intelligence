/**
 * The read layer: what it asks for, and how it folds the answers.
 *
 * Two things are worth locking in here. First, the FIELD LISTS: `script`,
 * `chunks` and `trace` are kilobytes each, and a list screen that pulls them
 * turns a twenty-case suite into a megabyte of transcripts nobody renders. A
 * regression there is invisible until the page is slow. Second, the BASELINE
 * rule: two runs of the same prompt are variance samples, never a before/after
 * pair — the hash exclusion is what keeps the compare view honest.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase, filterArgs, type Captured } from './fake-supabase'
import {
  caseRunnableBy,
  CASE_FIELDS,
  CASE_LIST_FIELDS,
  TRIAL_FIELDS,
  TRIAL_LIST_FIELDS,
  getCase,
  getRunDetail,
  getSuite,
  latestCompletedRun,
  listCases,
  listRuns,
  listSuites,
} from '../queries'

const WS = 'ws-1'

/** The `select(...)` argument a query actually sent. */
function selectedFields(q: Captured): string {
  return String(filterArgs(q, 'select')[0]?.[0] ?? '')
}

describe('field lists', () => {
  it('omits the fat jsonb columns from the LIST shapes', () => {
    for (const fat of ['script', 'chunks', 'expected']) {
      expect(CASE_FIELDS).toContain(fat)
      expect(CASE_LIST_FIELDS).not.toContain(fat)
    }
    expect(TRIAL_FIELDS).toContain('trace')
    expect(TRIAL_LIST_FIELDS).not.toContain('trace')
  })
})

describe('listSuites', () => {
  const SUITES = [
    {
      id: 's1', workspace_id: WS, name: 'Sales Discovery',
      case_count: 2, last_run_at: '2026-09-08T10:00:00Z', last_run_mode: 'batch',
      last_outcome: 'passed',
    },
    {
      id: 's2', workspace_id: WS, name: 'Standup',
      case_count: 1, last_run_at: null, last_run_mode: null, last_outcome: null,
    },
  ]

  it('reads the summary off eval_suite in ONE query', async () => {
    // Migration 255 denormalized case_count and the last run onto the suite
    // behind triggers, so the two child-table sweeps this used to do are gone.
    // A regression here is not a wrong answer — it is N+2 queries returning the
    // same numbers, which nothing would fail on.
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'eval_suite' ? { data: SUITES } : { data: null },
    )

    const suites = await listSuites(client, WS)
    expect(queries).toHaveLength(1)
    expect(queries[0].table).toBe('eval_suite')
    expect(suites[0]).toMatchObject({
      id: 's1',
      case_count: 2,
      last_run: { outcome: 'passed', started_at: '2026-09-08T10:00:00Z', mode: 'batch' },
    })
    // A suite with no runs is a null last_run, not a missing key.
    expect(suites[1]).toMatchObject({ id: 's2', case_count: 1, last_run: null })
  })

  it('selects the four summary columns', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: SUITES }))
    await listSuites(client, WS)
    const selected = selectedFields(queries[0])
    for (const column of ['case_count', 'last_run_at', 'last_run_mode', 'last_outcome']) {
      expect(selected).toContain(column)
    }
  })

  it('a run in flight keeps the previous verdict rather than clearing it', async () => {
    // 255's semantics: last_run_at follows the most recent run of ANY status,
    // last_outcome the most recent SETTLED one. The two disagreeing is the
    // feature — "running now, and last time it passed".
    const { client } = makeFakeSupabase(() => ({
      data: [{ ...SUITES[0], last_run_at: '2026-09-09T09:00:00Z', last_run_mode: 'live' }],
    }))
    const [suite] = await listSuites(client, WS)
    expect(suite.last_run).toEqual({
      outcome: 'passed',
      started_at: '2026-09-09T09:00:00Z',
      mode: 'live',
    })
  })

  it('scopes the read to the workspace', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: SUITES }))
    await listSuites(client, WS)
    expect(filterArgs(queries[0], 'eq')).toContainEqual(['workspace_id', WS])
  })

  it('returns an empty list rather than throwing on a DB error', async () => {
    const { client } = makeFakeSupabase(() => ({ data: null, error: { message: 'boom' } }))
    expect(await listSuites(client, WS)).toEqual([])
  })
})

describe('getSuite', () => {
  it('reads one suite scoped to the workspace', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: { id: 's1', name: 'Sales Discovery' } }))
    const suite = await getSuite(client, WS, 's1')
    expect(suite).toMatchObject({ id: 's1' })
    expect(filterArgs(queries[0], 'eq')).toContainEqual(['workspace_id', WS])
    expect(filterArgs(queries[0], 'eq')).toContainEqual(['id', 's1'])
  })

  it('returns null for a suite in another workspace', async () => {
    const { client } = makeFakeSupabase(() => ({ data: null }))
    expect(await getSuite(client, WS, 's-other')).toBeNull()
  })
})

describe('listCases / getCase', () => {
  it('lists without the transcript columns, ordered for authoring', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [{ id: 'c1' }] }))
    await listCases(client, 's1')
    expect(selectedFields(queries[0])).not.toContain('script')
    expect(filterArgs(queries[0], 'order')).toContainEqual(['sort_order', { ascending: true }])
  })

  it('fetches one case WITH its script and chunks', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: { id: 'c1', script: [] } }))
    await getCase(client, 'c1')
    expect(selectedFields(queries[0])).toContain('script')
    expect(selectedFields(queries[0])).toContain('chunks')
  })
})

describe('listRuns', () => {
  it('returns the newest runs first, capped', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [{ id: 'r1' }] }))
    await listRuns(client, 's1', 5)
    expect(filterArgs(queries[0], 'order')).toContainEqual(['started_at', { ascending: false }])
    expect(filterArgs(queries[0], 'limit')).toContainEqual([5])
  })
})

describe('getRunDetail', () => {
  it('attaches each trial\'s checks and its case name, without the traces', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'eval_run') return { data: { id: 'r1', suite_id: 's1' } }
      if (q.table === 'eval_trial') {
        return { data: [{ id: 't1', case_id: 'c1', trial_index: 0 }, { id: 't2', case_id: 'c2', trial_index: 1 }] }
      }
      if (q.table === 'eval_check') {
        return { data: [{ id: 'k1', trial_id: 't1', check_key: 'send_questionnaire' }] }
      }
      if (q.table === 'eval_case') return { data: [{ id: 'c1', name: 'Renewal call' }] }
      return { data: null }
    })

    const detail = await getRunDetail(client, 'r1')
    expect(detail!.run.id).toBe('r1')
    expect(detail!.trials[0]).toMatchObject({ id: 't1', case_name: 'Renewal call' })
    expect(detail!.trials[0].checks.map((c) => c.check_key)).toEqual(['send_questionnaire'])
    // A trial whose case row did not come back still renders, with an empty name.
    expect(detail!.trials[1]).toMatchObject({ id: 't2', case_name: '', checks: [] })

    const trialQuery = queries.find((q) => q.table === 'eval_trial')!
    expect(selectedFields(trialQuery)).not.toContain('trace')
  })

  it('returns null for an unknown run', async () => {
    const { client } = makeFakeSupabase(() => ({ data: null }))
    expect(await getRunDetail(client, 'nope')).toBeNull()
  })

  it('returns the run with no trials rather than null when it has none yet', async () => {
    const { client } = makeFakeSupabase((q) =>
      q.table === 'eval_run' ? { data: { id: 'r1' } } : { data: [] },
    )
    const detail = await getRunDetail(client, 'r1')
    expect(detail).toMatchObject({ trials: [] })
  })
})

describe('latestCompletedRun', () => {
  it('excludes the candidate\'s own prompt hash — same prompt is variance, not a baseline', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [{ id: 'r0' }] }))
    await latestCompletedRun(client, 's1', 'batch', 'hash-abc')
    expect(filterArgs(queries[0], 'neq')).toContainEqual(['target_prompt_hash', 'hash-abc'])
    expect(filterArgs(queries[0], 'eq')).toContainEqual(['status', 'completed'])
    expect(filterArgs(queries[0], 'eq')).toContainEqual(['mode', 'batch'])
  })

  it('omits the exclusion when no hash is given', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [{ id: 'r0' }] }))
    await latestCompletedRun(client, 's1', 'live')
    expect(filterArgs(queries[0], 'neq')).toEqual([])
  })

  it('returns null when this prompt is the only one ever run', async () => {
    const { client } = makeFakeSupabase(() => ({ data: [] }))
    expect(await latestCompletedRun(client, 's1', 'batch', 'hash-abc')).toBeNull()
  })
})

describe('caseRunnableBy — a private case runs only for its creator', () => {
  it('runs a workspace case for anyone, and a private one only for its creator', () => {
    expect(caseRunnableBy({ visibility: 'workspace', created_by: 'a' }, 'b')).toBe(true)
    expect(caseRunnableBy({ visibility: 'private', created_by: 'a' }, 'a')).toBe(true)
    expect(caseRunnableBy({ visibility: 'private', created_by: 'a' }, 'b')).toBe(false)
  })

  it('fails closed on a private case with no creator, or no run starter', () => {
    expect(caseRunnableBy({ visibility: 'private', created_by: null }, 'a')).toBe(false)
    expect(caseRunnableBy({ visibility: 'private', created_by: 'a' }, null)).toBe(false)
  })
})
