/**
 * The sequence entity's internal contact scope — `enrolled_contact_id`.
 *
 * The contact detail panel's embedded Sequences view scopes with a fixed
 * filter `{ field: 'enrolled_contact_id', operator: 'is', value: contactId }`.
 * PostgREST can't express EXISTS on a non-embedded table, so the engine
 * resolves the contact's enrolled sequence ids first (sequence_enrollment
 * subquery) and then filters `id in (...)` — the same two-step shape as the
 * label 'equals' subquery. These tests pin:
 *
 *  - membership resolution (dedup + workspace defence-in-depth),
 *  - fail-closed short-circuits (unsupported operator, zero enrollments,
 *    sentinel value, missing supabase client) via NoMatchSignal so the
 *    sentinel never reaches the uuid `id` column and an unscoped list is
 *    never leaked — a silent no-op on this synthetic field would mean "no
 *    filter", i.e. the full workspace list.
 */
import { describe, it, expect, vi } from 'vitest'
import { applyFilters, NoMatchSignal, NO_MATCH_FILTER_VALUE } from '@/lib/views/query-engine'
import type { ViewFilter } from '@/lib/views/types'

/** Records every builder method the filter layer dispatches on the OUTER query. */
function makeQuerySpy() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (...args: unknown[]) => {
          calls.push({ method: prop, args })
          return proxy
        }
      },
    },
  )
  return { query: proxy, calls }
}

/** Supabase mock that records from() tables + subquery method calls and
 *  resolves every chain to the given rows. */
function makeSupabase(rows: unknown[]) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const tables: string[] = []
  const makeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = new Proxy(
      {
        then: (resolve: (r: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      },
      {
        get(target, prop: string) {
          if (prop in target) return (target as Record<string, unknown>)[prop]
          return (...args: unknown[]) => {
            calls.push({ method: prop, args })
            return chain
          }
        },
      },
    )
    return chain
  }
  const from = vi.fn((table: string) => {
    tables.push(table)
    return makeChain()
  })
  return { supabase: { from }, calls, tables }
}

const scopeFilter = (value: unknown, operator: ViewFilter['operator'] = 'is'): ViewFilter[] => [
  { id: '__scope_contact', field: 'enrolled_contact_id', operator, value: value as ViewFilter['value'] },
]

describe('sequence enrolled_contact_id scope', () => {
  it('resolves the enrolled sequence ids and filters id in(...) — deduped', async () => {
    const { query, calls } = makeQuerySpy()
    const { supabase, calls: subCalls, tables } = makeSupabase([
      { sequence_id: 'seq-1' },
      { sequence_id: 'seq-2' },
      { sequence_id: 'seq-1' }, // re-enrollment history — one membership
    ])
    await applyFilters(query as never, 'sequence', scopeFilter('contact-1'), supabase as never, 'ws-1')

    expect(tables).toEqual(['sequence_enrollment'])
    // Subquery scoped to the contact AND the workspace (defence-in-depth).
    expect(subCalls).toContainEqual({ method: 'in', args: ['contact_id', ['contact-1']] })
    expect(subCalls).toContainEqual({ method: 'eq', args: ['workspace_id', 'ws-1'] })
    // Outer query: membership only — never an eq on the raw scope field.
    expect(calls).toEqual([{ method: 'in', args: ['id', ['seq-1', 'seq-2']] }])
  })

  it('zero enrollments → NoMatchSignal, outer query untouched (fail closed)', async () => {
    const { query, calls } = makeQuerySpy()
    const { supabase } = makeSupabase([])
    await expect(
      applyFilters(query as never, 'sequence', scopeFilter('contact-1'), supabase as never, 'ws-1'),
    ).rejects.toBeInstanceOf(NoMatchSignal)
    expect(calls).toEqual([])
  })

  it('the no-match sentinel short-circuits before ever hitting the DB', async () => {
    const { query, calls } = makeQuerySpy()
    const { supabase } = makeSupabase([{ sequence_id: 'seq-1' }])
    await expect(
      applyFilters(query as never, 'sequence', scopeFilter(NO_MATCH_FILTER_VALUE), supabase as never, 'ws-1'),
    ).rejects.toBeInstanceOf(NoMatchSignal)
    expect(supabase.from).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('missing supabase client fails closed rather than leaking an unscoped list', async () => {
    const { query, calls } = makeQuerySpy()
    await expect(
      applyFilters(query as never, 'sequence', scopeFilter('contact-1')),
    ).rejects.toBeInstanceOf(NoMatchSignal)
    expect(calls).toEqual([])
  })

  it('unsupported operators fail closed — never degrade to an unscoped list', async () => {
    // The field only supports positive membership ('is' / 'is_any_of'); it is
    // synthetic, so "skip the filter" would mean the FULL workspace list, not
    // a vacuously-true negation. Any other operator must throw NoMatchSignal.
    const { query, calls } = makeQuerySpy()
    const { supabase } = makeSupabase([{ sequence_id: 'seq-1' }])
    await expect(
      applyFilters(
        query as never,
        'sequence',
        scopeFilter('contact-1', 'is_not'),
        supabase as never,
        'ws-1',
      ),
    ).rejects.toBeInstanceOf(NoMatchSignal)
    expect(supabase.from).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})
