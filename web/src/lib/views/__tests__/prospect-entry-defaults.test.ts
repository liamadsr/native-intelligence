/**
 * "STILL ON THE LIST" is the server's default for a prospect list entry.
 *
 * The list is something the user WORKS: a dismissed row has left it and lives
 * under the Dismissed tab. That rule used to be the All tab's own
 * `stage is_not dismissed` scope filter, which had two problems once the stage
 * tabs moved into the views' tab row beside custom views (Liam, 2026-09-06):
 * a custom view with no opinion about stage would show dismissed rows, and a
 * custom view built as "Stage is dismissed" would be ANDed with the All tab's
 * filter and show nothing. So the rule lives in `applyEntityDefaults`, next to
 * the prospect list's own "hide archived" rule, with the same escape hatch: a
 * filter that names the field — whatever its operator — has said what it
 * wants to see and turns the default off.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildEntityQuery, applyEntityDefaults } from '@/lib/views/query-engine'
import type { ViewFilter, FilterOperator } from '@/lib/views/types'

/** A Supabase query builder that records the predicates the engine hands it. */
function makeSupabase() {
  const eqs: Array<[string, unknown]> = []
  const neqs: Array<[string, unknown]> = []
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((col: string, value: unknown) => {
      eqs.push([col, value])
      return chain
    }),
    neq: vi.fn((col: string, value: unknown) => {
      neqs.push([col, value])
      return chain
    }),
    or: vi.fn(() => chain),
    is: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
  }
  return { supabase: { from: vi.fn(() => chain) }, chain, eqs, neqs }
}

function build() {
  const { supabase, chain, eqs, neqs } = makeSupabase()
  const query = buildEntityQuery(supabase as never, 'prospect_list_entry', 'ws-1', 'user-1')
  return { query, chain, eqs, neqs }
}

function filter(field: string, operator: FilterOperator = 'is', value: unknown = 'x'): ViewFilter {
  return { id: `f-${field}`, field, operator, value } as ViewFilter
}

describe('applyEntityDefaults — prospect list entries', () => {
  it('hides dismissed entries when no filter names stage — the unfiltered list and a stage-blind custom view', () => {
    const { query, neqs } = build()
    applyEntityDefaults(query as never, 'prospect_list_entry', [])
    expect(neqs).toEqual([['stage', 'dismissed']])
  })

  it('an EXPLICIT stage filter turns the default off, whatever the operator', () => {
    // "Stage is dismissed" is the Dismissed tab and a custom view a user can
    // build; "Stage is not saved" is a user saying what they want to see. A
    // hidden neq on top of either would silently narrow them wrongly.
    for (const operator of ['is', 'is_not', 'is_any_of', 'is_none_of'] as const) {
      const { query, neqs } = build()
      applyEntityDefaults(query as never, 'prospect_list_entry', [filter('stage', operator)])
      expect(neqs, `operator ${operator} should suppress the default`).toEqual([])
    }
  })

  it('a filter on some OTHER field leaves the default in place', () => {
    const { query, neqs } = build()
    applyEntityDefaults(query as never, 'prospect_list_entry', [
      filter('list_id', 'is', 'list-1'),
      filter('kind', 'is', 'company'),
      filter('fit_score', 'gte', 80),
    ])
    expect(neqs).toEqual([['stage', 'dismissed']])
  })

  it('does not touch the prospect LIST rule, and stays out of every other entity', () => {
    const { supabase, chain } = makeSupabase()
    const lists = buildEntityQuery(supabase as never, 'prospect_list', 'ws-1', 'user-1')
    applyEntityDefaults(lists as never, 'prospect_list', [])
    expect(chain.neq).not.toHaveBeenCalled()
    expect(chain.eq).toHaveBeenCalledWith('status', 'active')

    const other = makeSupabase()
    const seq = buildEntityQuery(other.supabase as never, 'sequence', 'ws-1', 'user-1')
    applyEntityDefaults(seq as never, 'sequence', [])
    expect(other.chain.neq).not.toHaveBeenCalled()
  })
})
