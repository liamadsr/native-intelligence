/**
 * PROSPECT_LIST_VIEW_SELECT and the prospect_list query's three shape
 * decisions — what a list row carries, how the newest run gets embedded, and
 * the archived-by-default contract.
 *
 * The select half exists for the reason the sibling entry test exists: every
 * accessor in the row component degrades to null on a missing key, so a
 * dropped column renders a permanently blank chip and nothing throws or logs.
 *
 * The DEFAULT half is the one that would be a real bug. `buildEntityQuery`
 * cannot see the caller's filters and `applyFilters` is SKIPPED by the query
 * route when a view carries none — which is precisely the unfiltered index
 * that still has to hide archived lists. `applyEntityDefaults` owns that rule
 * and both callers must invoke it; these tests pin the rule and its escape
 * hatch.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildEntityQuery, applyEntityDefaults } from '@/lib/views/query-engine'
import type { ViewFilter } from '@/lib/views/types'

/** A Supabase query builder that records everything the engine hands it. */
function makeSupabase() {
  const selects: string[] = []
  const orders: Array<[string, unknown]> = []
  const limits: Array<[number, unknown]> = []
  const eqs: Array<[string, unknown]> = []
  const chain = {
    select: vi.fn((columns: string) => {
      selects.push(columns)
      return chain
    }),
    eq: vi.fn((col: string, value: unknown) => {
      eqs.push([col, value])
      return chain
    }),
    or: vi.fn(() => chain),
    is: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    order: vi.fn((col: string, opts: unknown) => {
      orders.push([col, opts])
      return chain
    }),
    limit: vi.fn((n: number, opts: unknown) => {
      limits.push([n, opts])
      return chain
    }),
  }
  return { supabase: { from: vi.fn(() => chain) }, chain, selects, orders, limits, eqs }
}

function build() {
  const rec = makeSupabase()
  const query = buildEntityQuery(rec.supabase as never, 'prospect_list', 'ws-1', 'user-1')
  return { ...rec, query }
}

const filter = (field: string, operator: ViewFilter['operator'] = 'is', value: unknown = 'archived'): ViewFilter =>
  ({ id: `f-${field}`, field, operator, value } as ViewFilter)

describe('PROSPECT_LIST_VIEW_SELECT', () => {
  it('reads from prospect_list and counts exactly', () => {
    const { supabase, chain } = build()
    expect(supabase.from).toHaveBeenCalledWith('prospect_list')
    expect(chain.select).toHaveBeenCalledWith(expect.any(String), { count: 'exact' })
  })

  it('ships every column a row cell reads', () => {
    const { selects } = build()
    const columns = selects[0].split(',').map((c) => c.trim())
    for (const column of [
      // Identity + routing.
      'id', 'workspace_id', 'name', 'description', 'purpose',
      // The chips: status (archived), and the policy fields a filter targets.
      'status', 'exclude_contacted', 'max_spend_dollars',
      // Ordering + the "updated 2h ago" cell.
      'created_at', 'updated_at',
    ]) {
      expect(columns, `missing "${column}"`).toContain(column)
    }
  })

  it('embeds the newest prospecting_run, ordered and limited to one', () => {
    // Modelled on the flow case: without the referencedTable order+limit the
    // embed returns the WHOLE run history on every row, and index 0 stops
    // being the last run.
    const { selects, orders, limits } = build()
    expect(selects[0]).toContain('prospecting_run:prospecting_run(')
    expect(orders).toContainEqual([
      'created_at',
      { referencedTable: 'prospecting_run', ascending: false },
    ])
    expect(limits).toContainEqual([1, { referencedTable: 'prospecting_run' }])
  })

  it('the embedded run carries exactly what the run chip needs', () => {
    const { selects } = build()
    const embed = selects[0].match(/prospecting_run:prospecting_run\(([^)]*)\)/)
    expect(embed).toBeTruthy()
    const fields = embed![1].split(',').map((c) => c.trim())
    // `progress` is the "N new" number — the run engine already wrote it, so
    // counting entries by discovered_by_run_id would be a second query per row.
    for (const f of ['id', 'kind', 'status', 'spent_dollars', 'progress', 'started_at', 'finished_at', 'created_at']) {
      expect(fields, `run embed missing "${f}"`).toContain(f)
    }
  })

  it('does NOT ship the three big run blobs', () => {
    // icp_snapshot / counts / exclusion_snapshot are the run DETAIL page's
    // material, they are the largest things on the row, and no index cell
    // reads them. A future "just add the rest" edit is what this stops.
    const { selects } = build()
    for (const blob of ['icp_snapshot', 'counts', 'exclusion_snapshot']) {
      expect(selects[0]).not.toContain(blob)
    }
  })

  it('does NOT ship the list icp blob either — the index never renders it', () => {
    // `icp` is prose the list detail page edits; `icp_version` (the number a
    // row could show) IS shipped.
    const { selects } = build()
    const columns = selects[0].split(',').map((c) => c.trim())
    expect(columns).not.toContain('icp')
    expect(columns).toContain('icp_version')
  })
})

describe('prospect_list archived-by-default', () => {
  it('buildEntityQuery does NOT apply the default — it cannot see the filters', () => {
    const { eqs } = build()
    expect(eqs).toEqual([['workspace_id', 'ws-1']])
  })

  it('applyEntityDefaults hides archived lists when no status filter is sent', () => {
    const { query, chain } = build()
    applyEntityDefaults(query as never, 'prospect_list', [])
    expect(chain.eq).toHaveBeenCalledWith('status', 'active')
  })

  it('an EXPLICIT status filter turns the default off, whatever the operator', () => {
    // A user asking `status is_not active`, or `is_any_of [active, archived]`,
    // has said what they want to see — a hidden .eq('status','active') on top
    // would silently return nothing.
    for (const operator of ['is', 'is_not', 'is_any_of', 'is_none_of'] as const) {
      const { query, chain } = build()
      applyEntityDefaults(query as never, 'prospect_list', [filter('status', operator)])
      const statusEqs = chain.eq.mock.calls.filter((c) => c[0] === 'status')
      expect(statusEqs, `operator ${operator} should suppress the default`).toEqual([])
    }
  })

  it('a filter on some OTHER field leaves the default in place', () => {
    const { query, chain } = build()
    applyEntityDefaults(query as never, 'prospect_list', [filter('purpose', 'is', 'investors')])
    expect(chain.eq).toHaveBeenCalledWith('status', 'active')
  })

  it('is a no-op for every other entity', () => {
    const { query, chain } = build()
    applyEntityDefaults(query as never, 'sequence', [])
    expect(chain.eq.mock.calls.filter((c) => c[0] === 'status')).toEqual([])
  })
})
