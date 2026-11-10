import { describe, expect, it } from 'vitest'
import { newColumnKey, planUndo, touchedBy, validateOps, type UndoState } from '../ops'
import type { DataChange, DataChangeEntry } from '../types'

const ROW_A = '11111111-1111-4111-8111-111111111111'
const ROW_B = '22222222-2222-4222-8222-222222222222'

const columns = [
  { key: 'status', label: 'Status', field_type: 'select' as const, options: ['Todo', 'Done'], deleted_at: null, position: 0 },
  { key: 'amount', label: 'Amount', field_type: 'number' as const, options: [], deleted_at: null, position: 1 },
  { key: 'old', label: 'Old', field_type: 'text' as const, options: [], deleted_at: '2026-11-01T00:00:00Z', position: 2 },
]

describe('newColumnKey', () => {
  it('slugs the label, and steps past every key the table used, deleted ones too', () => {
    expect(newColumnKey('Due date', [])).toBe('due_date')
    expect(newColumnKey('Status', ['status'])).toBe('status_2')
    expect(newColumnKey('Status', ['status', 'status_2'])).toBe('status_3')
    expect(newColumnKey('!!!', [])).toBe('')
    expect(newColumnKey('x'.repeat(60), ['x'.repeat(40)])).toHaveLength(40)
  })
})

describe('validateOps', () => {
  it('coerces values the way custom fields do: a select’s own spelling, a number from text', () => {
    const r = validateOps(columns, [{ op: 'update_row', row_id: ROW_A, title: '  Fernhill order ', values: { status: 'done', amount: '1,200' } }])
    expect(r).toEqual({ ok: true, value: [{ op: 'update_row', row_id: ROW_A, title: 'Fernhill order', values: { status: 'Done', amount: 1200 } }] })
  })

  it('refuses a value that does not fit, a column that is not there or was deleted, and the whole batch with it', () => {
    expect(validateOps(columns, [{ op: 'update_row', row_id: ROW_A, values: { status: 'Maybe' } }])).toMatchObject({ ok: false, error: expect.stringContaining('Todo, Done') })
    expect(validateOps(columns, [{ op: 'update_row', row_id: ROW_A, values: { nope: 1 } }])).toMatchObject({ ok: false, error: 'No column "nope" in this table.' })
    expect(validateOps(columns, [{ op: 'update_row', row_id: ROW_A, values: { old: 'x' } }])).toMatchObject({ ok: false })
    expect(validateOps(columns, [{ op: 'archive_rows', row_ids: [ROW_A] }, { op: 'nope' }])).toMatchObject({ ok: false, error: 'Unknown op "nope".' })
  })

  it('makes a new column’s key and lets later ops in the batch use it', () => {
    const r = validateOps(columns, [
      { op: 'create_column', label: 'Status', field_type: 'select', options: ['A', 'a', 'B'] },
      { op: 'insert_rows', rows: [{ title: 'One', values: { status_2: 'b' } }] },
    ])
    expect(r).toEqual({
      ok: true,
      value: [
        { op: 'create_column', key: 'status_2', label: 'Status', field_type: 'select', options: ['A', 'B'] },
        { op: 'insert_rows', rows: [{ title: 'One', values: { status_2: 'B' } }] },
      ],
    })
  })

  it('takes a deleted column back, and refuses it in a batch after its delete', () => {
    expect(validateOps(columns, [{ op: 'restore_column', key: 'old' }, { op: 'update_row', row_id: ROW_A, values: { old: 'kept' } }])).toMatchObject({ ok: true })
    expect(validateOps(columns, [{ op: 'delete_column', key: 'amount' }, { op: 'update_row', row_id: ROW_A, values: { amount: 1 } }])).toMatchObject({ ok: false })
  })

  it('checks the shapes: ids, empty batches, limits, positions', () => {
    expect(validateOps(columns, [])).toMatchObject({ ok: false, error: 'Nothing to change.' })
    expect(validateOps(columns, 'x')).toMatchObject({ ok: false })
    expect(validateOps(columns, [{ op: 'update_row', row_id: 'r1', title: 'x' }])).toMatchObject({ ok: false })
    expect(validateOps(columns, [{ op: 'update_row', row_id: ROW_A }])).toMatchObject({ ok: false, error: 'update_row changes nothing.' })
    expect(validateOps(columns, [{ op: 'insert_rows', rows: Array.from({ length: 1001 }, () => ({})) }])).toMatchObject({ ok: false })
    expect(validateOps(columns, Array.from({ length: 501 }, () => ({ op: 'archive_table' })))).toMatchObject({ ok: false })
    expect(validateOps(columns, [{ op: 'move_row', row_id: ROW_A, position: '1.5' }])).toMatchObject({ ok: true })
    expect(validateOps(columns, [{ op: 'move_row', row_id: ROW_A, position: '1; drop' }])).toMatchObject({ ok: false })
    expect(validateOps(columns, [{ op: 'move_row', row_id: ROW_A, after_row_id: ROW_A }])).toMatchObject({ ok: false })
    expect(validateOps(columns, [{ op: 'update_table', name: '  ' }])).toMatchObject({ ok: false, error: 'A table needs a name.' })
    expect(validateOps(columns, [{ op: 'update_table', visibility: 'team' }])).toMatchObject({ ok: false })
    expect(validateOps(columns, [{ op: 'reorder_columns', keys: ['amount', 'amount'] }])).toMatchObject({ ok: false })
    expect(validateOps(columns, [{ op: 'reorder_columns', keys: ['amount', 'status'] }])).toMatchObject({ ok: true })
  })

  it('drops a cleared value from a new row (nothing to clear yet)', () => {
    expect(validateOps(columns, [{ op: 'insert_rows', rows: [{ values: { status: null, amount: 3 } }] }])).toEqual({
      ok: true,
      value: [{ op: 'insert_rows', rows: [{ title: '', values: { amount: 3 } }] }],
    })
  })
})

// ── Undo ────────────────────────────────────────────────────────────────────

const change = (changes: DataChangeEntry[], extra: Partial<DataChange> = {}) => ({ changes, undo_of: null, undone_at: null, ...extra })

function state(rows: Record<string, Partial<{ title: string; custom_fields: Record<string, string | number | null>; archived_at: string | null; position: string }>>, extra: Partial<UndoState> = {}): UndoState {
  return {
    table: { name: 'Orders', icon: null, description: null, visibility: 'workspace', archived_at: null },
    isOwner: true,
    columns,
    rows: new Map(Object.entries(rows).map(([id, r]) => [id, { title: '', custom_fields: {}, archived_at: null, position: '1', ...r }])),
    ...extra,
  }
}

describe('planUndo', () => {
  it('puts each field back unless it changed since, and says which it kept', () => {
    const c = change([
      { op: 'update_row', row_id: ROW_A, fields: { title: { from: 'Old', to: 'New' }, 'values.status': { from: 'Todo', to: 'Done' }, 'values.amount': { from: null, to: 5 } } },
    ])
    const plan = planUndo(c, state({ [ROW_A]: { title: 'New', custom_fields: { status: 'Done', amount: 7 } } }))
    expect(plan).toMatchObject({ ok: true, ops: [{ op: 'update_row', row_id: ROW_A, title: 'Old', values: { status: 'Todo' } }] })
    if (plan.ok) {
      expect(plan.restored).toHaveLength(2)
      expect(plan.kept).toEqual(['“Amount” on “New” (changed since)'])
    }
  })

  it('clears a value that was not set before', () => {
    const plan = planUndo(change([{ op: 'update_row', row_id: ROW_A, fields: { 'values.amount': { from: null, to: 5 } } }]), state({ [ROW_A]: { custom_fields: { amount: 5 } } }))
    expect(plan).toMatchObject({ ok: true, ops: [{ op: 'update_row', row_id: ROW_A, values: { amount: null } }] })
  })

  it('keeps a value whose column is deleted, or whose old value no longer fits', () => {
    const plan = planUndo(
      change([{ op: 'update_row', row_id: ROW_A, fields: { 'values.old': { from: 'a', to: 'b' }, 'values.status': { from: 'Gone', to: 'Done' } } }]),
      state({ [ROW_A]: { custom_fields: { old: 'b', status: 'Done' } } }),
    )
    expect(plan).toEqual({ ok: false, error: 'Nothing to restore: everything it changed has changed again since.' })
  })

  it('archives the rows a batch added, brings back the ones it archived, in reverse order', () => {
    const plan = planUndo(
      change([
        { op: 'archive_rows', row_ids: [ROW_B] },
        { op: 'insert_rows', row_ids: [ROW_A] },
      ]),
      state({ [ROW_A]: {}, [ROW_B]: { archived_at: '2026-11-10T00:00:00Z' } }),
    )
    expect(plan).toMatchObject({ ok: true, ops: [{ op: 'archive_rows', row_ids: [ROW_A] }, { op: 'restore_rows', row_ids: [ROW_B] }] })
  })

  it('takes columns back: a new one deleted, a deleted one restored, a rename and the order reversed', () => {
    const plan = planUndo(
      change([
        { op: 'create_column', key: 'amount', column_id: 'c2', label: 'Amount', field_type: 'number', options: [] },
        { op: 'delete_column', key: 'old' },
        { op: 'update_column', key: 'status', fields: { label: { from: 'State', to: 'Status' } } },
        { op: 'reorder_columns', from: ['amount', 'status'], to: ['status', 'amount'] },
      ]),
      state({}),
    )
    expect(plan).toMatchObject({
      ok: true,
      ops: [
        { op: 'reorder_columns', keys: ['amount', 'status'] },
        { op: 'update_column', key: 'status', label: 'State' },
        { op: 'restore_column', key: 'old' },
        { op: 'delete_column', key: 'amount' },
      ],
    })
  })

  it('moves a row back to its exact place, unless it moved since', () => {
    const c = change([{ op: 'move_row', row_id: ROW_A, from: '2', to: '1.5' }])
    expect(planUndo(c, state({ [ROW_A]: { position: '1.5' } }))).toMatchObject({ ok: true, ops: [{ op: 'move_row', row_id: ROW_A, position: '2' }] })
    expect(planUndo(c, state({ [ROW_A]: { position: '3' } }))).toMatchObject({ ok: false })
  })

  it('leaves who sees the table to its owner', () => {
    const c = change([{ op: 'update_table', fields: { visibility: { from: 'workspace', to: 'private' }, name: { from: 'A', to: 'Orders' } } }])
    const plan = planUndo(c, state({}, { isOwner: false, table: { name: 'Orders', icon: null, description: null, visibility: 'private', archived_at: null } }))
    expect(plan).toMatchObject({ ok: true, ops: [{ op: 'update_table', name: 'A' }], kept: ['who sees the table (only its owner changes that)'] })
  })

  it('refuses the batch that made the table, an undo, and one already undone', () => {
    expect(planUndo(change([{ op: 'create_table' }, { op: 'insert_rows', row_ids: [ROW_A] }]), state({ [ROW_A]: {} }))).toMatchObject({ ok: false, error: expect.stringContaining('made the table') })
    expect(planUndo(change([{ op: 'archive_table' }], { undo_of: 'c0' }), state({}))).toMatchObject({ ok: false, error: 'That change was itself an undo.' })
    expect(planUndo(change([{ op: 'archive_table' }], { undone_at: '2026-11-10' }), state({}))).toMatchObject({ ok: false, error: 'That change was already undone.' })
  })
})

describe('touchedBy', () => {
  it('lists every row a change names, once', () => {
    expect(touchedBy(change([{ op: 'insert_rows', row_ids: [ROW_A, ROW_B] }, { op: 'update_row', row_id: ROW_A, fields: {} }, { op: 'archive_table' }])).rowIds).toEqual([ROW_A, ROW_B])
  })
})
