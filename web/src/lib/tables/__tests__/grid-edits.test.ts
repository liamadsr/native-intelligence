/**
 * The grid's edits as batches (../grid-edits.ts): every type coerced to its
 * stored form, misfits kept back with their error, required-when on the
 * cell it needs, the optimistic apply, someone else's logged changes, the
 * rebase after a 409, chunking, and pasted text read per type.
 */
import { describe, expect, it } from 'vitest'
import {
  applyChanges,
  applyOpsToRows,
  chunkOps,
  clipboardText,
  lenientDate,
  mergeRows,
  pastedValue,
  planEdits,
  rebaseOps,
  TITLE_KEY,
} from '../grid-edits'
import type { DataColumn, DataOp, DataRow } from '../types'

const T = '33333333-3333-4333-8333-333333333333'
const R1 = '11111111-1111-4111-8111-111111111111'
const R2 = '22222222-2222-4222-8222-222222222222'
const NEW = '55555555-5555-4555-8555-555555555555'
const MEMBER = '66666666-6666-4666-8666-666666666666'
const LINKED = '77777777-7777-4777-8777-777777777777'

const col = (key: string, field_type: DataColumn['field_type'], extra: Partial<DataColumn> = {}): DataColumn => ({
  id: `c-${key}`,
  table_id: T,
  key,
  label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '),
  field_type,
  options: [],
  config: {},
  position: 0,
  deleted_at: null,
  ...extra,
})

const columns: DataColumn[] = [
  col('notes', 'text'),
  col('qty', 'number'),
  col('due', 'date'),
  col('stage', 'select', { options: ['Lead', 'Won', 'Lost'] }),
  col('tags', 'multi_select', { options: ['Rush', 'Gift'] }),
  col('paid', 'checkbox'),
  col('site', 'url'),
  col('email', 'email'),
  col('phone', 'phone'),
  col('owner', 'person'),
  col('price', 'currency', { config: { currency: 'EUR' } }),
  col('client', 'relation', { config: { target: { kind: 'company' }, multiple: false } }),
  col('close_date', 'date', { config: { required_when: { key: 'stage', option: 'Won' } } }),
]

const row = (id: string, title: string, custom_fields: DataRow['custom_fields'] = {}, position = 1): DataRow => ({
  id,
  table_id: T,
  title,
  custom_fields,
  position,
  archived_at: null,
  created_at: '',
  updated_at: '',
})
const rows = [row(R1, 'Oak table', { stage: 'Lead' }, 1), row(R2, 'Linen set', {}, 2)]
const byId = new Map(rows.map((r) => [r.id, r]))

describe('planEdits', () => {
  it('turns what was typed into the stored form for every type, one update_row per row', () => {
    const { ops, errors } = planEdits(columns, byId, [
      { rowId: R1, key: 'notes', value: '  hand oiled  ' },
      { rowId: R1, key: 'qty', value: '1,200' },
      { rowId: R1, key: 'due', value: '2026-12-01' },
      { rowId: R1, key: 'tags', value: 'rush, GIFT' },
      { rowId: R1, key: 'paid', value: 'yes' },
      { rowId: R1, key: 'site', value: 'fernhill.example/oak' },
      { rowId: R1, key: 'email', value: 'Orders@Fernhill.Example' },
      { rowId: R1, key: 'owner', value: MEMBER },
      { rowId: R1, key: 'price', value: '1200' },
      { rowId: R1, key: 'client', value: [LINKED] },
      { rowId: R2, key: TITLE_KEY, value: '  Linen set, blue ' },
      { rowId: R2, key: 'stage', value: 'lost' },
    ])
    expect(errors).toEqual([])
    expect(ops).toHaveLength(2)
    const one = ops.find((o) => o.op === 'update_row' && o.row_id === R1) as Extract<DataOp, { op: 'update_row' }>
    expect(one.values).toEqual({
      notes: 'hand oiled',
      qty: 1200,
      due: '2026-12-01',
      tags: ['Rush', 'Gift'],
      paid: true,
      site: 'https://fernhill.example/oak',
      email: 'orders@fernhill.example',
      owner: MEMBER,
      price: { amount: 1200, currency: 'EUR' },
      client: [LINKED],
    })
    const two = ops.find((o) => o.op === 'update_row' && o.row_id === R2) as Extract<DataOp, { op: 'update_row' }>
    expect(two).toEqual({ op: 'update_row', row_id: R2, title: 'Linen set, blue', values: { stage: 'Lost' } })
  })

  it('keeps a cell that doesn’t fit out of the batch, with its error, and sends the rest', () => {
    const { ops, errors } = planEdits(columns, byId, [
      { rowId: R1, key: 'qty', value: 'twelve' },
      { rowId: R1, key: 'stage', value: 'Maybe' },
      { rowId: R1, key: 'notes', value: 'fine' },
      { rowId: R2, key: 'due', value: 'next week' },
    ])
    expect(errors.map((e) => [e.rowId, e.key])).toEqual([
      [R1, 'qty'],
      [R1, 'stage'],
      [R2, 'due'],
    ])
    expect(errors[0].error).toBe('Qty needs a number')
    expect(ops).toEqual([{ op: 'update_row', row_id: R1, values: { notes: 'fine' } }])
  })

  it('sends nothing for a value that is already stored', () => {
    expect(planEdits(columns, byId, [{ rowId: R1, key: 'stage', value: 'lead' }]).ops).toEqual([])
    expect(planEdits(columns, byId, [{ rowId: R1, key: TITLE_KEY, value: 'Oak table ' }]).ops).toEqual([])
  })

  it('clears with null and an empty title', () => {
    const { ops } = planEdits(columns, byId, [
      { rowId: R1, key: 'stage', value: null },
      { rowId: R1, key: TITLE_KEY, value: '' },
    ])
    expect(ops).toEqual([{ op: 'update_row', row_id: R1, title: '', values: { stage: null } }])
  })

  it('refuses a row that breaks required-when, with the error on the cell it needs', () => {
    const { ops, errors } = planEdits(columns, byId, [{ rowId: R1, key: 'stage', value: 'Won' }])
    expect(ops).toEqual([])
    expect(errors).toEqual([{ rowId: R1, key: 'close_date', error: 'Close date is needed when Stage is Won (row “Oak table”).' }])
    // With the date in the same batch it goes.
    expect(planEdits(columns, byId, [{ rowId: R1, key: 'stage', value: 'Won' }, { rowId: R1, key: 'close_date', value: '2026-12-24' }]).errors).toEqual([])
  })

  it('makes new rows in one insert_rows, coerced, before the edits', () => {
    const { ops, errors } = planEdits(columns, byId, [{ rowId: R2, key: 'qty', value: '3' }], [{ id: NEW, title: 'Walnut shelf', values: { qty: '2', stage: 'lead', paid: 'nope' } }])
    expect(errors.map((e) => e.key)).toEqual(['paid'])
    expect(ops[0]).toEqual({ op: 'insert_rows', rows: [{ id: NEW, title: 'Walnut shelf', values: { qty: 2, stage: 'Lead' } }] })
    expect(ops[1]).toEqual({ op: 'update_row', row_id: R2, values: { qty: 3 } })
  })
})

describe('applyOpsToRows', () => {
  it('merges edits (null clears), adds new rows at the end, and drops archived ones', () => {
    const next = applyOpsToRows(
      rows,
      [
        { op: 'update_row', row_id: R1, title: 'Oak table, large', values: { stage: null, qty: 2 } },
        { op: 'insert_rows', rows: [{ id: NEW, title: 'Walnut shelf', values: { qty: 1 } }] },
        { op: 'archive_rows', row_ids: [R2] },
      ],
      T,
    )
    expect(next.map((r) => r.id)).toEqual([R1, NEW])
    expect(next[0].title).toBe('Oak table, large')
    expect(next[0].custom_fields).toEqual({ qty: 2 })
    expect(next[1].custom_fields).toEqual({ qty: 1 })
    expect(Number(next[1].position)).toBeGreaterThan(2)
    // The rows in hand are not changed in place.
    expect(rows[0].title).toBe('Oak table')
  })
})

describe('applyChanges', () => {
  it('applies a teammate’s edits and archives, and lists what needs a read', () => {
    const { rows: next, needs } = applyChanges(rows, [
      { changes: [{ op: 'update_row', row_id: R1, fields: { title: { from: 'Oak table', to: 'Oak desk' }, 'values.qty': { from: null, to: 4 } } }] },
      { changes: [{ op: 'archive_rows', row_ids: [R2] }, { op: 'insert_rows', row_ids: [NEW] }, { op: 'create_column', key: 'size', column_id: 'x', label: 'Size', field_type: 'text', options: [] }] },
    ])
    expect(next.map((r) => [r.title, r.custom_fields.qty ?? null])).toEqual([['Oak desk', 4]])
    expect(needs).toEqual({ rowIds: [NEW], columns: true, table: false, allRows: false })
  })

  it('takes a type change’s values, or asks for every row when the log summarised them', () => {
    const typed = applyChanges(rows, [
      { changes: [{ op: 'change_column_type', key: 'qty', fields: { field_type: { from: 'text', to: 'number' }, options: { from: [], to: [] }, config: { from: {}, to: {} } }, values: { [R1]: { from: '4', to: 4 } } }] },
    ])
    expect(typed.rows[0].custom_fields.qty).toBe(4)
    expect(typed.needs.allRows).toBe(false)
    const summarised = applyChanges(rows, [
      { changes: [{ op: 'change_column_type', key: 'qty', fields: { field_type: { from: 'text', to: 'number' }, options: { from: [], to: [] }, config: { from: {}, to: {} } }, values: {}, value_count: 2 }] },
    ])
    expect(summarised.needs.allRows).toBe(true)
  })
})

describe('mergeRows', () => {
  it('replaces rows by id, places new ones by position, and drops archived ones', () => {
    const fresh = [row(NEW, 'Walnut shelf', {}, 1.5), { ...row(R2, 'Linen set'), archived_at: 'now' }]
    expect(mergeRows(rows, fresh).map((r) => r.id)).toEqual([R1, NEW])
  })
})

describe('rebaseOps', () => {
  const ours: DataOp[] = [
    { op: 'update_row', row_id: R1, title: 'Mine', values: { qty: 5, notes: 'mine' } },
    { op: 'update_row', row_id: R2, values: { qty: 1 } },
    { op: 'archive_rows', row_ids: [R1, R2] },
  ]

  it('keeps what nobody else touched and drops the cells they changed, counting them', () => {
    const r = rebaseOps(ours, [{ changes: [{ op: 'update_row', row_id: R1, fields: { 'values.qty': { from: null, to: 9 } } }] }])
    expect(r.dropped).toBe(1)
    expect(r.ops[0]).toEqual({ op: 'update_row', row_id: R1, title: 'Mine', values: { notes: 'mine' } })
    expect(r.ops).toHaveLength(3)
  })

  it('drops edits to a row they archived and to a column they retyped or deleted', () => {
    const r = rebaseOps(ours, [
      { changes: [{ op: 'archive_rows', row_ids: [R2] }] },
      { changes: [{ op: 'delete_column', key: 'notes' }] },
      { changes: [{ op: 'update_row', row_id: R1, fields: { title: { from: 'a', to: 'b' } } }] },
    ])
    expect(r.ops).toEqual([
      { op: 'update_row', row_id: R1, values: { qty: 5 } },
      { op: 'archive_rows', row_ids: [R1] },
    ])
    expect(r.dropped).toBe(3)
  })
})

describe('chunkOps', () => {
  it('splits past the server’s limits, in order', () => {
    const many: DataOp[] = Array.from({ length: 7 }, (_, i) => ({ op: 'update_row', row_id: `${i}`, title: 'x' }))
    expect(chunkOps(many, { ops: 3, rowsPerOp: 10, rowsPerBatch: 20 }).map((c) => c.length)).toEqual([3, 3, 1])
    const insert: DataOp = { op: 'insert_rows', rows: Array.from({ length: 25 }, () => ({ title: 'r' })) }
    const parts = chunkOps([insert], { ops: 50, rowsPerOp: 10, rowsPerBatch: 20 })
    expect(parts.map((b) => b.map((o) => (o.op === 'insert_rows' ? o.rows.length : 0)))).toEqual([[10, 10], [5]])
  })
})

describe('pastedValue and lenientDate', () => {
  const ctx = { members: [{ id: MEMBER, name: 'Robin Vale' }], labels: { [LINKED]: 'Fernhill Studio' } }

  it('reads a member by name, a linked record by a known name, a date as spreadsheets write it', () => {
    expect(pastedValue(columns[9], 'robin vale', ctx)).toBe(MEMBER)
    expect(pastedValue(columns[9], 'Someone new', ctx)).toBe('Someone new')
    expect(pastedValue(columns[11], 'Fernhill Studio', ctx)).toEqual([LINKED])
    expect(pastedValue(columns[2], '3/4/2026')).toBe('2026-03-04')
    expect(pastedValue(columns[0], '   ')).toBeNull()
  })

  it('lenientDate keeps ISO, trims a time, and leaves what it can’t read', () => {
    expect(lenientDate('2026-03-04')).toBe('2026-03-04')
    expect(lenientDate('2026-03-04T10:00:00Z')).toBe('2026-03-04')
    expect(lenientDate('Mar 4, 2026')).toBe('2026-03-04')
    expect(lenientDate('13/45/2026')).toBe('13/45/2026')
    expect(lenientDate('soon')).toBe('soon')
  })

  it('copies dates as YYYY-MM-DD and the rest as the cell reads', () => {
    expect(clipboardText('date', '2026-03-04')).toBe('2026-03-04')
    expect(clipboardText('currency', { amount: 1200, currency: 'EUR' })).toBe('€1,200.00')
    expect(clipboardText('person', MEMBER, ctx.labels)).toBe('')
    expect(clipboardText('relation', [LINKED], ctx.labels)).toBe('Fernhill Studio')
  })
})
