/**
 * A view filtered or sorted by a formula (store.ts queryRows, phase 6): the
 * rows are worked out as they are read, so the view runs in memory over at
 * most COMPUTED_SCAN_ROWS of them; past that its formula filters and sorts
 * are dropped and the answer says so. Without the reader (`computed`), a
 * formula filter is dropped as an unknown field always was.
 */
import { describe, expect, it } from 'vitest'
import { COMPUTED_SCAN_ROWS, queryRows } from '../store'
import type { DataColumn } from '../types'
import { fakeTablesDb } from './fake-tables-db'

const WS = 'ws-1'
const T = '33333333-3333-4333-8333-333333333333'
const col = (key: string, label: string, field_type: DataColumn['field_type'], config: DataColumn['config'] = {}): DataColumn => ({ id: key, table_id: T, key, label, field_type, options: [], config, position: 0, deleted_at: null })
const COLUMNS = [col('qty', 'Qty', 'number'), col('price', 'Price', 'number'), col('total', 'Total', 'formula', { expression: '{#qty} * {#price}' })]
const row = (n: number, qty: number, price: number) => ({ id: `r${n}`, workspace_id: WS, table_id: T, title: `Item ${n}`, custom_fields: { qty, price }, position: n, archived_at: null, created_at: '', updated_at: '' })
const reader = { workspaceId: WS, userId: 'u1', timeZone: 'UTC' }

describe('queryRows on a formula', () => {
  const rows = [row(1, 2, 10), row(2, 1, 5), row(3, 4, 30), row(4, 3, 1)]
  const db = () => fakeTablesDb({ data_row: rows }, () => ({ data: null, error: null })).client

  it('filters and sorts by the worked-out value, then pages', async () => {
    const page = await queryRows(db(), WS, T, COLUMNS, {
      filters: [{ id: 'f', field: 'custom_fields.total', operator: 'gte', value: 5 }],
      ordering: [{ field: 'custom_fields.total', direction: 'desc' }],
      limit: 2,
      computed: reader,
    })
    expect(page.rows.map((r) => [r.title, r.computed?.total])).toEqual([
      ['Item 3', { value: 120 }],
      ['Item 1', { value: 20 }],
    ])
    expect(page.hasMore).toBe(true)
    expect(page.computedSkipped).toBeUndefined()
  })

  it('every page of a plain view carries the cells too', async () => {
    const page = await queryRows(db(), WS, T, COLUMNS, { computed: reader })
    expect(page.rows.map((r) => r.computed?.total)).toEqual([{ value: 20 }, { value: 5 }, { value: 120 }, { value: 3 }])
  })

  it('whole: a view run in memory answers every matching row at once, and nothing past it', async () => {
    const first = await queryRows(db(), WS, T, COLUMNS, { ordering: [{ field: 'custom_fields.total', direction: 'asc' }], limit: 2, computed: reader, computedWhole: true })
    expect(first.rows.map((r) => r.title)).toEqual(['Item 4', 'Item 2', 'Item 1', 'Item 3'])
    expect(first.hasMore).toBe(false)
    const next = await queryRows(db(), WS, T, COLUMNS, { ordering: [{ field: 'custom_fields.total', direction: 'asc' }], offset: 200, computed: reader, computedWhole: true })
    expect(next.rows).toEqual([])
  })

  it('without a reader, a formula filter is not dropped silently: the answer says it was left out', async () => {
    const page = await queryRows(db(), WS, T, COLUMNS, { filters: [{ id: 'f', field: 'custom_fields.total', operator: 'gt', value: 50 }] })
    expect(page.computedSkipped).toBe(true)
    expect(page.rows).toHaveLength(4)
  })

  it('past the cap, the formula’s filter and sort are dropped and the answer says so', async () => {
    const many = Array.from({ length: COMPUTED_SCAN_ROWS + 5 }, (_, i) => row(i + 1, 1, i))
    const big = fakeTablesDb({ data_row: many }, () => ({ data: null, error: null })).client
    const page = await queryRows(big, WS, T, COLUMNS, { filters: [{ id: 'f', field: 'custom_fields.total', operator: 'gt', value: 1e9 }], limit: 3, computed: reader })
    expect(page.computedSkipped).toBe(true)
    expect(page.rows).toHaveLength(3)
  })
})
