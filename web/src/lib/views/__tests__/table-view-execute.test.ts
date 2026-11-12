/**
 * A saved table view run on the server (executeView, the path the agent will
 * use): only its own table's rows, read by that table's columns (a
 * currency's amounts in its code), and nothing at all for a table view that
 * names no table.
 */
import { describe, expect, it } from 'vitest'
import { executeView } from '@/lib/views/query-engine'
import type { View } from '@/lib/views/types'

function spyDb() {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const db = {
    from(table: string) {
      const result =
        table === 'custom_field_definition'
          ? { data: [{ key: 'price', field_type: 'currency', config: { currency: 'EUR' } }], error: null }
          : { data: [], count: 0, error: null }
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
            if (prop === 'maybeSingle') return () => Promise.resolve({ data: null, error: null })
            return (...args: unknown[]) => {
              calls.push({ table, method: prop, args })
              return chain
            }
          },
        },
      )
      return chain
    },
  }
  return { db, calls }
}

const base = {
  id: 'v-1',
  workspace_id: 'ws-1',
  entity_type: 'data_row',
  name: 'Pipeline',
  layout: 'grid',
  filters: [{ id: 'f', field: 'custom_fields.price', operator: 'gte', value: 10 }],
  ordering: [],
  display_properties: [],
  grouping: null,
  sub_grouping: null,
} as unknown as View

describe('executeView on a table’s view', () => {
  it('reads only its table’s rows, by that table’s columns', async () => {
    const { db, calls } = spyDb()
    await executeView(db as never, { ...base, scope_type: 'data_table', scope_id: 't-1' } as View, 'user-1')
    const rows = calls.filter((c) => c.table === 'data_row').map((c) => [c.method, ...c.args])
    expect(rows).toContainEqual(['eq', 'table_id', 't-1'])
    expect(rows).toContainEqual(['contains', 'custom_fields', { price: { currency: 'EUR' } }])
    expect(rows).toContainEqual(['gte', 'custom_fields->price->amount', 10])
    expect(calls.filter((c) => c.table === 'custom_field_definition').map((c) => [c.method, ...c.args])).toContainEqual(['eq', 'table_id', 't-1'])
  })

  it('a table view that names no table shows nothing and filters nothing', async () => {
    const { db, calls } = spyDb()
    const out = await executeView(db as never, { ...base, scope_type: null, scope_id: null } as View, 'user-1')
    expect(out.data).toEqual([])
    expect(calls.some((c) => c.table === 'custom_field_definition')).toBe(false)
    expect(calls.some((c) => c.method === 'range' || c.method === 'gte')).toBe(false)
  })
})
