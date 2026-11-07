/**
 * EVAL_SUITE_VIEW_SELECT — what an eval-suite row carries into the views list.
 *
 * The four columns migration 255 added are the point of this pin. They are the
 * only reason the Evals index can be a views entity at all: `case_count`,
 * `last_run_at`, `last_run_mode` and `last_outcome` used to be computed at read
 * time from eval_case and eval_run, and a derived value can be DISPLAYED but
 * never grouped, filtered or sorted on — PostgREST predicates run in the
 * database. Dropping one from this select would not throw and would not log;
 * the cell would simply render blank and the board would collapse to a single
 * "Never run" column, which is the worst way for a list to be wrong.
 *
 * `description` is pinned too: the row's subtitle reads it, and unlike the
 * summary columns its absence is invisible on a suite that has no description.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildEntityQuery } from '@/lib/views/query-engine'

/** A Supabase query builder that records the select string it was handed. */
function makeSupabase() {
  const selects: string[] = []
  const chain = {
    select: vi.fn((columns: string) => {
      selects.push(columns)
      return chain
    }),
    eq: vi.fn(() => chain),
    or: vi.fn(() => chain),
    is: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
  }
  return { supabase: { from: vi.fn((t: string) => { tables.push(t); return chain }) }, selects }
}

let tables: string[] = []

function suiteColumns(): string[] {
  tables = []
  const { supabase, selects } = makeSupabase()
  buildEntityQuery(supabase as never, 'eval_suite', 'ws-1', 'user-1')
  return selects[0].split(',').map((c) => c.trim())
}

describe('EVAL_SUITE_VIEW_SELECT', () => {
  it('queries the eval_suite table, scoped to the workspace', () => {
    tables = []
    const { supabase } = makeSupabase()
    buildEntityQuery(supabase as never, 'eval_suite', 'ws-1', 'user-1')
    expect(tables).toEqual(['eval_suite'])
    expect(supabase.from).toHaveBeenCalledWith('eval_suite')
  })

  it('ships the four denormalized summary columns (migration 255)', () => {
    const columns = suiteColumns()
    for (const column of ['case_count', 'last_run_at', 'last_run_mode', 'last_outcome']) {
      expect(columns).toContain(column)
    }
  })

  it('keeps every field the row, the filters and the detail hand-off read', () => {
    const columns = suiteColumns()
    for (const column of [
      // Identity + routing.
      'id', 'workspace_id', 'name', 'description',
      // What the suite grades, and the chips.
      'target_kind', 'target_recipe_id', 'suite_kind', 'watch', 'judge_model',
      // Provenance + ordering.
      'created_by', 'created_at', 'updated_at',
    ]) {
      expect(columns).toContain(column)
    }
  })

  it('embeds nothing — the summary is on the row, so there is no join to make', () => {
    // A `case_count:eval_case(count)` embed would pull every case row onto
    // every page load and still not be groupable. The triggers are the design.
    expect(suiteColumns().join(',')).not.toContain('(')
  })
})
