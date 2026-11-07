/**
 * `between` with a half-filled range: the filter UI saves `{ from, to }` as the
 * person types, so one bound can be empty. Only the bounds that are set may
 * reach the query; an unset one used to go out as `lte.undefined` and fail it.
 */
import { describe, it, expect } from 'vitest'
import { applyFilters } from '@/lib/views/query-engine'
import type { ViewFilter } from '@/lib/views/types'

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

async function run(value: unknown) {
  const { query, calls } = makeQuerySpy()
  const f: ViewFilter = { id: 'f', field: 'due_at', operator: 'between', value: value as ViewFilter['value'] }
  await applyFilters(query as never, 'action', [f])
  return calls.filter((c) => c.method === 'gte' || c.method === 'lte')
}

describe('between filter', () => {
  it('applies both bounds when both are set', async () => {
    expect(await run({ from: '2026-01-01', to: '2026-02-01' })).toEqual([
      { method: 'gte', args: ['due_at', '2026-01-01'] },
      { method: 'lte', args: ['due_at', '2026-02-01'] },
    ])
  })

  it('applies only the lower bound when the upper is unset', async () => {
    expect(await run({ from: '2026-01-01' })).toEqual([{ method: 'gte', args: ['due_at', '2026-01-01'] }])
    expect(await run({ from: '2026-01-01', to: '' })).toEqual([{ method: 'gte', args: ['due_at', '2026-01-01'] }])
  })

  it('applies only the upper bound when the lower is unset', async () => {
    expect(await run({ from: '', to: '2026-02-01' })).toEqual([{ method: 'lte', args: ['due_at', '2026-02-01'] }])
  })

  it('keeps a numeric 0 bound', async () => {
    const { query, calls } = makeQuerySpy()
    await applyFilters(query as never, 'action', [
      { id: 'f', field: 'estimate', operator: 'between', value: { from: 0, to: 3 } },
    ])
    expect(calls.filter((c) => c.method === 'gte' || c.method === 'lte')).toEqual([
      { method: 'gte', args: ['estimate', 0] },
      { method: 'lte', args: ['estimate', 3] },
    ])
  })
})
