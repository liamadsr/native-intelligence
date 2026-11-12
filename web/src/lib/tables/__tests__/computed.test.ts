import { beforeEach, describe, expect, it, vi } from 'vitest'

const visible = vi.hoisted(() => ({ ids: new Set<string>(), calls: [] as Array<{ userId: string | null; grants?: boolean; kind: string; ids: string[] }> }))
vi.mock('@/lib/crm/custom-field-references', () => ({
  visibleRelationTargets: async (_db: unknown, scope: { userId: string | null; grants?: boolean }, target: { kind: string }, ids: string[]) => {
    visible.calls.push({ userId: scope.userId, grants: scope.grants, kind: target.kind, ids: [...ids] })
    return new Set(ids.filter((id) => visible.ids.has(id)))
  },
}))
vi.mock('@/lib/knowledge/graph-map/source', () => ({
  resolveEntityLabels: async (_db: unknown, _ws: string, byType: Map<string, Set<string>>) =>
    new Map([...byType].flatMap(([type, ids]) => [...ids].map((id) => [`${type}:${id}`, `Deal ${id.slice(0, 4)}`] as [string, string]))),
}))

import { aggregate, cellMatches, compareValues, computeRow, planComputed, rollupResultType, todayIn } from '../computed'
import { attachComputed, computedContext, annotateColumns } from '../computed-server'
import { validateOps } from '../ops'
import type { DataColumn, DataRow } from '../types'
import { fakeTablesDb } from './fake-tables-db'

const WS = '00000000-0000-4000-8000-000000000001'
const TABLE = '00000000-0000-4000-8000-0000000000a1'
const LINKED = '00000000-0000-4000-8000-0000000000b1'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const col = (key: string, label: string, field_type: DataColumn['field_type'], config: DataColumn['config'] = {}): DataColumn => ({
  id: `c-${key}`,
  table_id: TABLE,
  key,
  label,
  field_type,
  options: [],
  config,
  position: 0,
  deleted_at: null,
})

const orders = col('orders', 'Orders', 'relation', { target: { kind: 'data_row', table_id: LINKED }, multiple: true })
const base = [col('price', 'Price', 'number'), col('qty', 'Qty', 'number'), orders]

describe('planComputed', () => {
  it('types each formula, in the order they depend on each other', () => {
    const cols = [...base, col('total', 'Total', 'formula', { expression: '{#subtotal} * 1.2' }), col('subtotal', 'Subtotal', 'formula', { expression: '{#price} * {#qty}' })]
    const plan = planComputed(cols)
    expect(plan.order).toEqual(['subtotal', 'total'])
    expect(plan.entries.get('total')).toMatchObject({ result: 'number' })
  })

  it('finds a cycle and puts every formula on it in error', () => {
    const cols = [...base, col('a', 'A', 'formula', { expression: '{#b} + 1' }), col('b', 'B', 'formula', { expression: '{#a} + 1' }), col('c', 'C', 'formula', { expression: '{#price}' })]
    const plan = planComputed(cols)
    expect(plan.entries.get('a')?.error).toMatch(/refers back to itself/)
    expect(plan.entries.get('b')?.error).toMatch(/refers back to itself/)
    expect(plan.entries.get('c')?.error).toBeUndefined()
    expect(plan.order).toEqual(['c'])
  })

  it('a formula naming a deleted column, or one in error, says so', () => {
    const cols = [...base, col('gone', 'Gone', 'text'), col('f', 'F', 'formula', { expression: '{#gone}' }), col('g', 'G', 'formula', { expression: '{#f}' })]
    cols[3] = { ...cols[3], deleted_at: '2026-11-01' }
    const plan = planComputed(cols)
    expect(plan.entries.get('f')?.error).toBe('No column named {gone}.')
    expect(plan.entries.get('g')?.error).toBeTruthy()
  })

  it('a formula can’t read a relation directly, only through a rollup', () => {
    const plan = planComputed([...base, col('f', 'F', 'formula', { expression: '{#orders}' })])
    expect(plan.entries.get('f')?.error).toBe('{Orders} is a relation column: read it with a rollup.')
  })

  it('a rollup’s type follows its function and the linked field', () => {
    expect(rollupResultType('count', null)).toEqual({ type: 'number' })
    expect(rollupResultType('sum', 'currency')).toEqual({ type: 'number' })
    expect(rollupResultType('max', 'date')).toEqual({ type: 'date' })
    expect(rollupResultType('sum', 'text')).toEqual({ error: 'Sum needs a number or currency field.' })
    expect(rollupResultType('earliest', 'number')).toEqual({ error: 'Earliest needs a date field.' })
    expect(rollupResultType('list', 'person')).toMatchObject({ error: expect.any(String) })
    const plan = planComputed([...base, col('n', 'N', 'rollup', { relation: 'orders', fn: 'count', field: null }), col('gone', 'G', 'rollup', { relation: 'qty', fn: 'count', field: null })])
    expect(plan.entries.get('n')).toMatchObject({ result: 'number' })
    expect(plan.entries.get('gone')?.error).toBe('The relation column this rollup reads is gone.')
  })
})

describe('computeRow', () => {
  it('runs the formulas on the row and takes the rollups as given', () => {
    const cols = [...base, col('n', 'Orders count', 'rollup', { relation: 'orders', fn: 'count', field: null }), col('f', 'Busy', 'formula', { expression: 'if({#n} > 1, concat({#_title}, " is busy"), "")' })]
    const plan = planComputed(cols)
    const out = computeRow({ title: 'Bay Street', custom_fields: {} }, cols, plan, { n: { value: 3 } }, { today: '2026-11-11' })
    expect(out).toEqual({ n: { value: 3 }, f: { value: 'Bay Street is busy' } })
  })

  it('a cell’s error stays in its cell', () => {
    const cols = [...base, col('f', 'Each', 'formula', { expression: '{#price} / {#qty}' })]
    const plan = planComputed(cols)
    expect(computeRow({ title: '', custom_fields: { price: 4, qty: 0 } }, cols, plan, {}, { today: '2026-11-11' })).toEqual({ f: { error: 'Division by zero.' } })
    expect(computeRow({ title: '', custom_fields: { price: 4, qty: 2 } }, cols, plan, {}, { today: '2026-11-11' })).toEqual({ f: { value: 2 } })
  })
})

describe('a column keyed like an object’s own property', () => {
  it('reads the row’s own value, never one the prototype lends', () => {
    const cols = [col('constructor', 'Constructor', 'number'), col('f', 'F', 'formula', { expression: 'empty({#constructor})' })]
    const plan = planComputed(cols)
    expect(computeRow({ title: '', custom_fields: {} }, cols, plan, {}, { today: '2026-11-11' })).toEqual({ f: { value: true } })
    expect(computeRow({ title: '', custom_fields: { constructor: 3 } as Record<string, unknown> }, cols, plan, {}, { today: '2026-11-11' })).toEqual({ f: { value: false } })
  })
})

describe('aggregate', () => {
  const items = [
    { name: 'A', value: 10 },
    { name: 'B', value: 5 },
    { name: 'C', value: null },
  ]
  it('counts, sums, averages, and finds the smallest and largest', () => {
    expect(aggregate('count', null, items)).toEqual({ t: 'number', v: 3 })
    expect(aggregate('count', 'number', items)).toEqual({ t: 'number', v: 2 })
    expect(aggregate('sum', 'number', items)).toEqual({ t: 'number', v: 15 })
    expect(aggregate('avg', 'number', items)).toEqual({ t: 'number', v: 7.5 })
    expect(aggregate('min', 'number', items)).toEqual({ t: 'number', v: 5 })
    expect(aggregate('max', 'number', items)).toEqual({ t: 'number', v: 10 })
    expect(aggregate('sum', 'currency', [{ name: 'A', value: { amount: 12.5, currency: 'USD' } }, { name: 'B', value: { amount: 2.5, currency: 'USD' } }])).toEqual({ t: 'number', v: 15 })
    expect(aggregate('avg', 'number', [])).toBeNull()
    expect(aggregate('sum', 'number', [])).toEqual({ t: 'number', v: 0 })
  })
  it('finds the earliest and latest dates, and lists', () => {
    const dates = [{ name: 'A', value: '2026-05-01' }, { name: 'B', value: '2026-01-15' }]
    expect(aggregate('earliest', 'date', dates)).toEqual({ t: 'date', v: '2026-01-15' })
    expect(aggregate('latest', 'date', dates)).toEqual({ t: 'date', v: '2026-05-01' })
    expect(aggregate('list', null, dates)).toEqual({ t: 'text', v: 'A, B' })
    expect(aggregate('list', 'date', dates)).toEqual({ t: 'text', v: '2026-05-01, 2026-01-15' })
  })
})

describe('filters and sorts on a computed column', () => {
  it('matches each type’s operators', () => {
    expect(cellMatches({ value: 12 }, 'number', { operator: 'gt', value: 10 })).toBe(true)
    expect(cellMatches({ value: 12 }, 'number', { operator: 'between', value: { from: 1, to: 5 } })).toBe(false)
    expect(cellMatches({ value: 'Shipped' }, 'text', { operator: 'contains', value: 'ship' })).toBe(true)
    expect(cellMatches({ value: null }, 'text', { operator: 'is_empty', value: '' })).toBe(true)
    expect(cellMatches({ error: 'x' }, 'number', { operator: 'is_not_empty', value: '' })).toBe(false)
    expect(cellMatches({ value: true }, 'checkbox', { operator: 'is', value: true })).toBe(true)
    expect(cellMatches({ value: '2026-11-20' }, 'date', { operator: 'is_relative', value: { unit: 'week', direction: 'future', count: 2 } }, { window: () => ({ from: '2026-11-11', to: '2026-11-25' }) })).toBe(true)
  })
  it('orders values with empty ones last both ways', () => {
    const sorted = (dir: 'asc' | 'desc') => [3, null, 1, 2].sort((a, b) => compareValues(a, b, dir))
    expect(sorted('asc')).toEqual([1, 2, 3, null])
    expect(sorted('desc')).toEqual([3, 2, 1, null])
  })
  it('today is the reader’s day', () => {
    expect(todayIn('Pacific/Auckland', new Date('2026-11-11T20:00:00Z'))).toBe('2026-11-12')
    expect(todayIn('America/Los_Angeles', new Date('2026-11-11T05:00:00Z'))).toBe('2026-11-10')
  })
})

describe('validateOps: computed columns', () => {
  it('stores a formula by key and refuses a bad one', () => {
    const ok = validateOps(base, [{ op: 'create_column', label: 'Total', field_type: 'formula', config: { expression: '{Price} * {Qty}' } }])
    expect(ok).toEqual({ ok: true, value: [{ op: 'create_column', key: 'total', label: 'Total', field_type: 'formula', config: { expression: '{#price} * {#qty}' } }] })
    expect(validateOps(base, [{ op: 'create_column', label: 'T', field_type: 'formula', config: { expression: '{Price} + "x"' } }])).toMatchObject({ ok: false, error: expect.stringMatching(/^T: Can't add/) })
    expect(validateOps(base, [{ op: 'create_column', label: 'T', field_type: 'formula', config: { expression: '{T} + 1' } }])).toMatchObject({ ok: false, error: 'No column named {T}.' })
  })

  it('refuses a formula that would close a loop', () => {
    const cols = [...base, col('a', 'A', 'formula', { expression: '{#price}' }), col('b', 'B', 'formula', { expression: '{#a} + 1' })]
    expect(validateOps(cols, [{ op: 'update_column', key: 'a', config: { expression: '{B} * 2' } }])).toMatchObject({ ok: false, error: expect.stringMatching(/refers back to itself/) })
  })

  it('checks a rollup’s relation and function', () => {
    expect(validateOps(base, [{ op: 'create_column', label: 'Spend', field_type: 'rollup', config: { relation: 'orders', fn: 'sum', field: 'amount' } }])).toMatchObject({ ok: true })
    expect(validateOps(base, [{ op: 'create_column', label: 'Spend', field_type: 'rollup', config: { relation: 'price', fn: 'sum', field: 'amount' } }])).toMatchObject({ ok: false, error: 'A rollup reads through one of this table’s relation columns.' })
    expect(validateOps(base, [{ op: 'create_column', label: 'Spend', field_type: 'rollup', config: { relation: 'orders', fn: 'sum' } }])).toMatchObject({ ok: false, error: 'Sum needs a field of the linked records.' })
    expect(validateOps(base, [{ op: 'create_column', label: 'N', field_type: 'rollup', config: { relation: 'orders', fn: 'median' } }])).toMatchObject({ ok: false })
  })

  it('never takes a value for a computed column, and keeps its type', () => {
    const cols = [...base, col('total', 'Total', 'formula', { expression: '{#price}' })]
    expect(validateOps(cols, [{ op: 'update_row', row_id: id(1), values: { total: 3 } }])).toEqual({ ok: false, error: 'Total is worked out from other columns, so it can\'t be set.' })
    expect(validateOps(cols, [{ op: 'change_column_type', key: 'total', field_type: 'number' }])).toMatchObject({ ok: false })
    expect(validateOps(cols, [{ op: 'change_column_type', key: 'price', field_type: 'formula' }])).toMatchObject({ ok: false })
  })
})

describe('rollups read only what the reader can read', () => {
  const linkedRows = [
    { id: id(11), workspace_id: WS, table_id: LINKED, title: 'Order 11', custom_fields: { amount: 100, placed: '2026-10-01' }, archived_at: null },
    { id: id(12), workspace_id: WS, table_id: LINKED, title: 'Order 12', custom_fields: { amount: 50, placed: '2026-11-01' }, archived_at: null },
    { id: id(13), workspace_id: WS, table_id: LINKED, title: 'Order 13', custom_fields: { amount: 999 }, archived_at: null },
    { id: id(14), workspace_id: WS, table_id: LINKED, title: 'Order 14', custom_fields: { amount: 7 }, archived_at: '2026-11-02' },
  ]
  const defs = [
    { workspace_id: WS, entity_type: 'data_row', table_id: LINKED, key: 'amount', field_type: 'number', deleted_at: null },
    { workspace_id: WS, entity_type: 'data_row', table_id: LINKED, key: 'placed', field_type: 'date', deleted_at: null },
  ]
  const cols = [
    ...base,
    col('n', 'Orders', 'rollup', { relation: 'orders', fn: 'count', field: null }),
    col('spend', 'Spend', 'rollup', { relation: 'orders', fn: 'sum', field: 'amount' }),
    col('last', 'Last order', 'rollup', { relation: 'orders', fn: 'latest', field: 'placed' }),
    col('names', 'Names', 'rollup', { relation: 'orders', fn: 'list', field: '_title' }),
    col('big', 'Big', 'formula', { expression: '{#spend} >= 150' }),
  ]
  const row: DataRow = { id: id(1), table_id: TABLE, title: 'Bay Street', custom_fields: { orders: [id(11), id(12), id(13), id(14)] }, position: 1, archived_at: null, created_at: '', updated_at: '' }

  beforeEach(() => {
    visible.ids = new Set([id(11), id(12), id(14)])
    visible.calls = []
  })

  it('aggregates only the linked rows the reader may read, and not archived ones', async () => {
    const db = fakeTablesDb({ data_row: linkedRows, custom_field_definition: defs }, () => ({ data: null, error: null }))
    const ctx = await computedContext(db.client, WS, cols)
    const [out] = await attachComputed(db.client, ctx, [row], { workspaceId: WS, userId: 'user-1', timeZone: 'UTC' })
    // Order 13 is out of sight, order 14 archived.
    expect(out.computed).toEqual({
      n: { value: 2 },
      spend: { value: 150 },
      last: { value: '2026-11-01' },
      names: { value: 'Order 11, Order 12' },
      big: { value: true },
    })
    expect(visible.calls).toEqual([{ userId: 'user-1', grants: undefined, kind: 'data_row', ids: [id(11), id(12), id(13), id(14)] }])
  })

  it('a guest’s turn reads without grants', async () => {
    const db = fakeTablesDb({ data_row: linkedRows, custom_field_definition: defs }, () => ({ data: null, error: null }))
    const ctx = await computedContext(db.client, WS, cols)
    await attachComputed(db.client, ctx, [row], { workspaceId: WS, userId: 'user-2', grants: false })
    expect(visible.calls[0]).toMatchObject({ userId: 'user-2', grants: false })
  })

  it('sees nothing when nothing is readable, and says when the linked table is out of sight', async () => {
    visible.ids = new Set()
    const db = fakeTablesDb({ data_row: linkedRows, custom_field_definition: [] }, () => ({ data: null, error: null }))
    const ctx = await computedContext(db.client, WS, cols)
    const annotated = annotateColumns(ctx)
    expect(annotated.find((c) => c.key === 'spend')?.computed).toEqual({ result: null, error: 'You can’t open the table this rollup reads.' })
    expect(annotated.find((c) => c.key === 'n')?.computed).toEqual({ result: 'number' })
    const [out] = await attachComputed(db.client, ctx, [row], { workspaceId: WS, userId: 'user-3' })
    expect(out.computed?.n).toEqual({ value: 0 })
    expect(out.computed?.spend).toBeUndefined()
  })

  it('a kind’s records: names from the reader’s own reads', async () => {
    visible.ids = new Set([id(21)])
    const dealCols = [col('deals', 'Deals', 'relation', { target: { kind: 'deal' }, multiple: true }), col('names', 'Deal names', 'rollup', { relation: 'deals', fn: 'list', field: null })]
    const db = fakeTablesDb({ custom_field_definition: [] }, () => ({ data: null, error: null }))
    const ctx = await computedContext(db.client, WS, dealCols)
    const [out] = await attachComputed(db.client, ctx, [{ ...row, custom_fields: { deals: [id(21), id(22)] } }], { workspaceId: WS, userId: 'user-1' })
    expect(out.computed?.names).toEqual({ value: 'Deal 0000' })
  })
})
