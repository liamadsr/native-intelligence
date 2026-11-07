import { describe, it, expect, vi } from 'vitest'
import { applyFilters, NoMatchSignal, NO_MATCH_FILTER_VALUE } from '@/lib/views/query-engine'
import type { ViewFilter } from '@/lib/views/types'

/**
 * Regression coverage for the prod 500 (2026-07-23):
 *   invalid input syntax for type uuid: "__no_match__"
 *
 * The sentinel `__no_match__` used to reach Postgres as a value compared
 * against uuid columns (id / status_id), crashing the query instead of
 * yielding zero rows. The fix short-circuits ABOVE the query builder by
 * throwing NoMatchSignal, so no sentinel string ever hits the DB.
 *
 * These assert at the mock level that NO query method that would dispatch the
 * bad comparison (eq/in/not/etc.) ever runs on the guaranteed-no-match path.
 */

/**
 * A query spy that records every builder method the filter layer touches and
 * returns itself so chains compose. If any method runs on a no-match path,
 * the sentinel would have been about to reach the DB — the tests assert none do.
 */
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

/** Minimal supabase mock: every table select resolves to the given rows. */
function makeSupabase(rows: unknown[]) {
  const result = { data: rows, error: null }
  const chain: Record<string, unknown> = new Proxy(
    {
      then: (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve),
    },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop]
        return () => chain
      },
    },
  )
  return { from: vi.fn(() => chain) }
}

describe('no-match short-circuit — prod regression', () => {
  it('the exact prod shape (id is __no_match__) throws NoMatchSignal and never touches the query', async () => {
    const { query, calls } = makeQuerySpy()
    const filters: ViewFilter[] = [{ id: '__scope_contact', field: 'id', operator: 'is', value: NO_MATCH_FILTER_VALUE }]

    await expect(applyFilters(query as never, 'capture', filters)).rejects.toBeInstanceOf(NoMatchSignal)

    // No query method dispatched → no eq('id', '__no_match__') → no uuid cast.
    expect(calls).toEqual([])
  })

  it('recognizes the LITERAL string (already-deployed clients) not just the exported constant', async () => {
    const { query, calls } = makeQuerySpy()
    const filters: ViewFilter[] = [{ id: '__scope_contact', field: 'id', operator: 'is', value: '__no_match__' }]

    await expect(applyFilters(query as never, 'capture', filters)).rejects.toBeInstanceOf(NoMatchSignal)
    expect(calls).toEqual([])
  })

  it('short-circuits on is_any_of with an all-sentinel array', async () => {
    const { query, calls } = makeQuerySpy()
    const filters: ViewFilter[] = [{ id: 'f', field: 'id', operator: 'is_any_of', value: ['__no_match__'] }]

    await expect(applyFilters(query as never, 'capture', filters)).rejects.toBeInstanceOf(NoMatchSignal)
    expect(calls).toEqual([])
  })

  it('strips sentinel elements out of a MIXED is_any_of array so they never reach a uuid cast', async () => {
    const { query, calls } = makeQuerySpy()
    const real = '2c63c0e7-8dab-4db6-973e-ac114e2bac54'
    const filters: ViewFilter[] = [{ id: 'f', field: 'id', operator: 'is_any_of', value: [real, '__no_match__'] }]

    // Not all-sentinel → no short-circuit; the real value still filters, but the
    // sentinel element must be stripped before the in() dispatch.
    await applyFilters(query as never, 'capture', filters)
    const inCall = calls.find((c) => c.method === 'in')
    expect(inCall?.args).toEqual(['id', [real]])
  })

  it('status-category filter resolving to zero states throws instead of casting a sentinel to uuid', async () => {
    const { query, calls } = makeQuerySpy()
    // No workflow_state rows come back → zero matching state IDs.
    const supabase = makeSupabase([])
    const filters: ViewFilter[] = [{ id: 'f', field: 'status_type', operator: 'is', value: 'completed' }]

    await expect(
      applyFilters(query as never, 'action', filters, supabase as never, 'w1'),
    ).rejects.toBeInstanceOf(NoMatchSignal)

    // Never called query.in('status_id', ['__no_match__']).
    expect(calls.find((c) => c.method === 'in')).toBeUndefined()
  })

  it('label filter matching zero entities throws instead of casting a sentinel to uuid', async () => {
    const { query, calls } = makeQuerySpy()
    // No junction rows → zero matching entity IDs.
    const supabase = makeSupabase([])
    const filters: ViewFilter[] = [{ id: 'f', field: 'labels', operator: 'equals', value: 'label-1' }]

    await expect(
      applyFilters(query as never, 'action', filters, supabase as never, 'w1'),
    ).rejects.toBeInstanceOf(NoMatchSignal)

    // Never called query.in('id', ['__no_match__']).
    expect(calls.find((c) => c.method === 'in')).toBeUndefined()
  })
})

describe('no-match sentinel — negation semantics', () => {
  it('is_not __no_match__ is vacuously true → no-op filter (does NOT force empty)', async () => {
    const { query, calls } = makeQuerySpy()
    const filters: ViewFilter[] = [{ id: 'f', field: 'id', operator: 'is_not', value: NO_MATCH_FILTER_VALUE }]

    // Must not throw — the view is not forced empty.
    await expect(applyFilters(query as never, 'capture', filters)).resolves.toBeUndefined()

    // And it's a no-op: no neq('id', '__no_match__') dispatched either.
    expect(calls).toEqual([])
  })

  it('is_none_of an all-sentinel array is likewise a no-op', async () => {
    const { query, calls } = makeQuerySpy()
    const filters: ViewFilter[] = [{ id: 'f', field: 'id', operator: 'is_none_of', value: ['__no_match__'] }]

    await expect(applyFilters(query as never, 'capture', filters)).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  it('a real (non-sentinel) value still filters normally', async () => {
    const { query, calls } = makeQuerySpy()
    const filters: ViewFilter[] = [{ id: 'f', field: 'id', operator: 'is', value: 'real-uuid' }]

    await expect(applyFilters(query as never, 'capture', filters)).resolves.toBeUndefined()
    // Normal eq dispatched with the real value.
    expect(calls).toEqual([{ method: 'eq', args: ['id', 'real-uuid'] }])
  })
})
