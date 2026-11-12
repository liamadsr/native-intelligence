/**
 * A view's page of a table's rows (store.ts queryRows): the live rows of the
 * one table, filtered and sorted by the views engine with each column read
 * by its own type (the table's columns are the types), then the table's own
 * order; a filter or sort on a column since deleted is dropped; "me" on a
 * person column is the caller's member row; one more row than the page says
 * whether there is another.
 */
import { describe, expect, it } from 'vitest'
import { queryRows } from '../store'

const WS = 'ws-1'
const T = '33333333-3333-4333-8333-333333333333'

function spyDb(rows: unknown[] = [], member: { id: string } | null = { id: 'member-me' }) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const db = {
    from(table: string) {
      const result = table === 'member' ? { data: member, error: null } : { data: rows, error: null }
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
            if (prop === 'maybeSingle') return () => Promise.resolve(result)
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

const COLUMNS = [
  { key: 'stage', field_type: 'select' as const },
  { key: 'tags', field_type: 'multi_select' as const },
  { key: 'owner', field_type: 'person' as const },
  { key: 'price', field_type: 'currency' as const },
]

describe('queryRows', () => {
  it('scopes to the table’s live rows, reads each column by its type, then orders by the table', async () => {
    const { db, calls } = spyDb([])
    await queryRows(db as never, WS, T, COLUMNS, {
      filters: [
        { id: 'a', field: 'custom_fields.stage', operator: 'is_not', value: 'Won' },
        { id: 'b', field: 'custom_fields.tags', operator: 'includes', value: ['Rush'] },
        { id: 'c', field: 'title', operator: 'contains', value: 'oak' },
      ],
      ordering: [{ field: 'custom_fields.price', direction: 'desc' }],
      offset: 50,
      limit: 25,
    })
    const rowCalls = calls.filter((c) => c.table === 'data_row').map((c) => [c.method, ...c.args])
    expect(rowCalls).toEqual([
      ['select', 'id, table_id, title, custom_fields, position, archived_at, created_at, updated_at'],
      ['eq', 'workspace_id', WS],
      ['eq', 'table_id', T],
      ['is', 'archived_at', null],
      ['not', 'custom_fields->>stage', 'is', null],
      ['not', 'custom_fields', 'cs', '{"stage":"Won"}'],
      ['contains', 'custom_fields', { tags: ['Rush'] }],
      ['ilike', 'title', '%oak%'],
      ['order', 'custom_fields->price->currency', { ascending: true, nullsFirst: false }],
      ['order', 'custom_fields->price->amount', { ascending: false, nullsFirst: false }],
      ['order', 'position', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['range', 50, 75],
    ])
  })

  it('drops a filter or a sort on a column the table no longer has, and any field a row lacks', async () => {
    const { db, calls } = spyDb([])
    await queryRows(db as never, WS, T, COLUMNS, {
      filters: [
        { id: 'a', field: 'custom_fields.gone', operator: 'is', value: 'x' },
        { id: 'b', field: 'workspace_id', operator: 'is', value: 'other' },
      ],
      ordering: [{ field: 'custom_fields.gone', direction: 'asc' }],
    })
    const methods = calls.filter((c) => c.table === 'data_row').map((c) => c.method)
    expect(methods).toEqual(['select', 'eq', 'eq', 'is', 'order', 'order', 'range'])
  })

  it('"me" on a person column is the caller’s member row in this workspace', async () => {
    const { db, calls } = spyDb([])
    await queryRows(db as never, WS, T, COLUMNS, { filters: [{ id: 'a', field: 'custom_fields.owner', operator: 'is', value: '@me' }], userId: 'user-1' })
    expect(calls.filter((c) => c.table === 'member').map((c) => [c.method, ...c.args])).toEqual([
      ['select', 'id'],
      ['eq', 'user_id', 'user-1'],
      ['eq', 'workspace_id', WS],
    ])
    expect(calls).toContainEqual({ table: 'data_row', method: 'contains', args: ['custom_fields', { owner: 'member-me' }] })
  })

  it('reads one more than the page to say whether there is another', async () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, table_id: T, title: `Row ${i}`, custom_fields: null }))
    const more = await queryRows(spyDb(make(3)).db as never, WS, T, COLUMNS, { limit: 2 })
    expect(more.hasMore).toBe(true)
    expect(more.rows.map((r) => r.id)).toEqual(['r0', 'r1'])
    expect(more.rows[0].custom_fields).toEqual({})
    const last = await queryRows(spyDb(make(2)).db as never, WS, T, COLUMNS, { limit: 2 })
    expect(last.hasMore).toBe(false)
  })
})
