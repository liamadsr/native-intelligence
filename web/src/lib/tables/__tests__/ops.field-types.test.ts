/**
 * Tables, phase 2, the pure half: columns of the new types and their
 * settings, a column's type change, required-when, and their undo.
 */
import { describe, expect, it } from 'vitest'
import { planUndo, requiredWhenProblem, validateOps, type UndoState } from '../ops'
import type { DataChangeEntry } from '../types'

const ROW_A = '11111111-1111-4111-8111-111111111111'
const ROW_B = '22222222-2222-4222-8222-222222222222'
const TABLE = '33333333-3333-4333-8333-333333333333'

const columns = [
  { key: 'stage', label: 'Stage', field_type: 'select' as const, options: ['Open', 'Won'], config: {}, deleted_at: null, position: 0 },
  {
    key: 'value',
    label: 'Value',
    field_type: 'currency' as const,
    options: [],
    config: { currency: 'USD', required_when: { key: 'stage', option: 'Won' } },
    deleted_at: null,
    position: 1,
  },
  { key: 'note', label: 'Note', field_type: 'text' as const, options: [], config: {}, deleted_at: null, position: 2 },
  { key: 'link', label: 'Link', field_type: 'relation' as const, options: [], config: { target: { kind: 'data_row' as const, table_id: TABLE }, multiple: true }, deleted_at: null, position: 3 },
]

describe('columns of the new types', () => {
  it('a multi-select keeps its options, a currency its code, a relation its target', () => {
    const r = validateOps(columns, [
      { op: 'create_column', label: 'Tags', field_type: 'multi_select', options: ['a', 'b'] },
      { op: 'create_column', label: 'Price', field_type: 'currency', config: { currency: 'eur' } },
      { op: 'create_column', label: 'Company', field_type: 'relation', config: { target: { kind: 'company' } } },
      { op: 'insert_rows', rows: [{ title: 'One', values: { tags: 'A, b', price: '12', company: [ROW_A] } }] },
    ])
    expect(r).toEqual({
      ok: true,
      value: [
        { op: 'create_column', key: 'tags', label: 'Tags', field_type: 'multi_select', options: ['a', 'b'] },
        { op: 'create_column', key: 'price', label: 'Price', field_type: 'currency', config: { currency: 'EUR' } },
        { op: 'create_column', key: 'company', label: 'Company', field_type: 'relation', config: { target: { kind: 'company' }, multiple: false } },
        { op: 'insert_rows', rows: [{ title: 'One', values: { tags: ['a', 'b'], price: { amount: 12, currency: 'EUR' }, company: [ROW_A] } }] },
      ],
    })
  })

  it('refuses a relation without a target, and a new target through update_column', () => {
    expect(validateOps(columns, [{ op: 'create_column', label: 'X', field_type: 'relation' }])).toMatchObject({ ok: false })
    expect(validateOps(columns, [{ op: 'update_column', key: 'link', config: { target: { kind: 'contact' } } }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('change its type'),
    })
    expect(validateOps(columns, [{ op: 'update_column', key: 'link', config: { target: { kind: 'data_row', table_id: TABLE }, multiple: false } }])).toMatchObject({ ok: true })
  })

  it('checks required_when against the table: another select column and one of its options', () => {
    expect(validateOps(columns, [{ op: 'update_column', key: 'note', config: { required_when: { key: 'stage', option: 'won' } } }])).toEqual({
      ok: true,
      value: [{ op: 'update_column', key: 'note', config: { required_when: { key: 'stage', option: 'Won' } } }],
    })
    expect(validateOps(columns, [{ op: 'update_column', key: 'note', config: { required_when: { key: 'stage', option: 'Lost' } } }])).toMatchObject({
      ok: false,
      error: 'Stage has no option "Lost".',
    })
    expect(validateOps(columns, [{ op: 'update_column', key: 'note', config: { required_when: { key: 'note', option: 'x' } } }])).toMatchObject({ ok: false })
    expect(validateOps(columns, [{ op: 'update_column', key: 'stage', config: { required_when: { key: 'stage', option: 'Won' } } }])).toMatchObject({ ok: false })
  })
})

describe('change_column_type', () => {
  it('names the new type, cleans its options and settings, and later ops take values of it', () => {
    const r = validateOps(columns, [
      { op: 'change_column_type', key: 'note', field_type: 'number' },
      { op: 'update_row', row_id: ROW_A, values: { note: '7' } },
    ])
    expect(r).toEqual({
      ok: true,
      value: [
        { op: 'change_column_type', key: 'note', field_type: 'number', options: [], config: {} },
        { op: 'update_row', row_id: ROW_A, values: { note: 7 } },
      ],
    })
    expect(validateOps(columns, [{ op: 'change_column_type', key: 'note', field_type: 'select', options: ['A', 'a'] }])).toMatchObject({
      ok: true,
      value: [{ op: 'change_column_type', key: 'note', field_type: 'select', options: ['A'] }],
    })
    // A select type named no options keeps the column's own, the unused ones too.
    expect(validateOps(columns, [{ op: 'change_column_type', key: 'stage', field_type: 'multi_select' }])).toMatchObject({
      ok: true,
      value: [{ op: 'change_column_type', key: 'stage', field_type: 'multi_select', options: ['Open', 'Won'] }],
    })
    expect(validateOps(columns, [{ op: 'change_column_type', key: 'note', field_type: 'colour' }])).toMatchObject({ ok: false })
    expect(validateOps(columns, [{ op: 'change_column_type', key: 'gone', field_type: 'text' }])).toMatchObject({ ok: false })
  })
})

describe('required when', () => {
  it('a new row in the rule’s option needs the column; an old row edited elsewhere does not', () => {
    expect(validateOps(columns, [{ op: 'insert_rows', rows: [{ title: 'Acme', values: { stage: 'Won' } }] }])).toEqual({
      ok: false,
      error: 'Value is needed when Stage is Won (row “Acme”).',
    })
    expect(validateOps(columns, [{ op: 'insert_rows', rows: [{ title: 'Acme', values: { stage: 'Won', value: 1200 } }] }])).toMatchObject({ ok: true })
    // The batch's own later edit of a row it made counts.
    expect(
      validateOps(columns, [
        { op: 'insert_rows', rows: [{ id: ROW_A, title: 'Acme', values: { stage: 'Won' } }] },
        { op: 'update_row', row_id: ROW_A, values: { value: 5 } },
      ]),
    ).toMatchObject({ ok: true })
    const won = { title: 'Old deal', values: { stage: 'Won' } }
    expect(requiredWhenProblem(columns, won, new Set(['note']))).toBeNull()
    expect(requiredWhenProblem(columns, won, new Set(['stage']))).toBe('Value is needed when Stage is Won (row “Old deal”).')
    expect(requiredWhenProblem(columns, { title: 'Open', values: { stage: 'Open' } }, 'all')).toBeNull()
    // A rule on a deleted select column is inert.
    const gone = columns.map((c) => (c.key === 'stage' ? { ...c, deleted_at: 'now' } : c))
    expect(requiredWhenProblem(gone, won, 'all')).toBeNull()
  })
})

describe('the undo of a type change and a setting', () => {
  const state = (cols: UndoState['columns']): UndoState => ({
    table: { name: 'Deals', icon: null, description: null, visibility: 'workspace', archived_at: null },
    isOwner: true,
    columns: cols,
    rows: new Map(),
  })
  const typeChange: DataChangeEntry = {
    op: 'change_column_type',
    key: 'note',
    fields: { field_type: { from: 'text', to: 'number' }, options: { from: [], to: [] }, config: { from: {}, to: {} } },
    values: { [ROW_A]: { from: '12', to: 12 }, [ROW_B]: { from: '7', to: 7 } },
  }

  it('goes back to the old type with each value as it was, the database converting the rest', () => {
    const now = columns.map((c) => (c.key === 'note' ? { ...c, field_type: 'number' as const } : c))
    const plan = planUndo({ changes: [typeChange], undo_of: null, undone_at: null }, state(now))
    expect(plan).toEqual({
      ok: true,
      ops: [{ op: 'change_column_type', key: 'note', field_type: 'text', options: [], config: {}, restore: typeChange.values }],
      restored: ['column “Note”\'s type'],
      kept: [],
    })
  })

  it('keeps a type that changed again since', () => {
    expect(planUndo({ changes: [typeChange], undo_of: null, undone_at: null }, state(columns))).toMatchObject({ ok: false })
  })

  it('puts a setting back unless it changed since', () => {
    const entry: DataChangeEntry = { op: 'update_column', key: 'value', fields: { config: { from: { currency: 'USD' }, to: columns[1].config } } }
    expect(planUndo({ changes: [entry], undo_of: null, undone_at: null }, state(columns))).toMatchObject({
      ok: true,
      ops: [{ op: 'update_column', key: 'value', config: { currency: 'USD' } }],
    })
  })
})
