/**
 * The tables store: what goes to apply_data_ops and create_data_table, how
 * their answers and refusals come back, and an undo end to end (the plan's
 * own rules are ./ops.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { applyOps, createTable, listRows, undoChange } from '../store'
import { fakeTablesDb, type RpcAnswer } from './fake-tables-db'

const WS = 'ws-1'
const T = '33333333-3333-4333-8333-333333333333'
const ROW = '11111111-1111-4111-8111-111111111111'
const CHANGE = '44444444-4444-4444-8444-444444444444'

const table = { id: T, workspace_id: WS, name: 'Orders', icon: null, description: null, owner_member_id: 'm-1', visibility: 'workspace', version: 4, position: 0, archived_at: null }
const status = { id: 'c-1', workspace_id: WS, entity_type: 'data_row', table_id: T, key: 'status', label: 'Status', field_type: 'select', options: ['Todo', 'Done'], position: 0, deleted_at: null }

type Rpc = (name: string, args: Record<string, unknown>) => RpcAnswer
const applied: Rpc = () => ({ data: { version: 5, change_id: 'ch-new', inserted_row_ids: [], created_column_ids: {} }, error: null })

function db(rpc: Rpc = applied) {
  return fakeTablesDb(
    {
      data_table: [table],
      custom_field_definition: [status],
      data_row: [{ id: ROW, workspace_id: WS, table_id: T, title: 'Order 1', custom_fields: { status: 'Done' }, archived_at: null, position: 1 }],
      data_change: [
        {
          id: CHANGE,
          workspace_id: WS,
          table_id: T,
          version: 4,
          changes: [{ op: 'update_row', row_id: ROW, fields: { 'values.status': { from: 'Todo', to: 'Done' } } }],
          undo_of: null,
          undone_at: null,
          created_at: '2026-11-10T10:00:00Z',
        },
      ],
      member: [{ id: 'm-1', workspace_id: WS, user_id: 'u-1' }],
    },
    rpc,
  )
}

describe('applyOps', () => {
  it('sends the checked batch with its version, source and reason, and shapes the answer', async () => {
    const f = db()
    const res = await applyOps(f.client, WS, T, { baseVersion: 4, ops: [{ op: 'update_row', row_id: ROW, values: { status: 'todo' } }] }, { userId: 'u-1', source: 'person', reason: '  Customer asked  ' })
    expect(res).toEqual({ ok: true, value: { version: 5, change_id: 'ch-new', inserted_row_ids: [], created_column_ids: {} } })
    expect(f.rpcCalls).toEqual([
      {
        name: 'apply_data_ops',
        args: {
          p_table_id: T,
          p_base_version: 4,
          p_ops: [{ op: 'update_row', row_id: ROW, values: { status: 'Todo' } }],
          p_source: 'person',
          p_reason: 'Customer asked',
          p_undo_of: null,
          p_as_user: null,
        },
      },
    ])
  })

  it('refuses a bad value before the database, and a table the caller can’t read', async () => {
    const f = db()
    expect(await applyOps(f.client, WS, T, { baseVersion: 4, ops: [{ op: 'update_row', row_id: ROW, values: { status: 'Maybe' } }] }, { userId: 'u-1', source: 'person' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await applyOps(f.client, WS, '55555555-5555-4555-8555-555555555555', { baseVersion: 1, ops: [] }, { userId: 'u-1', source: 'person' })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(f.rpcCalls).toHaveLength(0)
  })

  it('turns the database’s refusals into reasons: PT409 a conflict with the version now, 42501 forbidden, P0002 not found', async () => {
    const ops = [{ op: 'update_row', row_id: ROW, title: 'x' }]
    const actor = { userId: 'u-1', source: 'person' as const }
    const conflict = db(() => ({ data: null, error: { code: 'PT409', message: 'the table changed since version 3', details: '4' } }))
    expect(await applyOps(conflict.client, WS, T, { baseVersion: 3, ops }, actor)).toMatchObject({ ok: false, reason: 'conflict', version: 4 })
    const forbidden = db(() => ({ data: null, error: { code: '42501', message: 'you can view this table but not change it' } }))
    expect(await applyOps(forbidden.client, WS, T, { baseVersion: 4, ops }, actor)).toEqual({ ok: false, reason: 'forbidden', error: 'You can view this table but not change it' })
    const gone = db(() => ({ data: null, error: { code: 'P0002', message: 'table not found' } }))
    expect(await applyOps(gone.client, WS, T, { baseVersion: 4, ops }, actor)).toMatchObject({ ok: false, reason: 'not_found' })
  })
})

describe('createTable', () => {
  it('makes a table with its blank rows in one call, owned by the caller', async () => {
    const f = db(() => ({ data: { table_id: T, version: 1, change_id: 'ch-1', inserted_row_ids: ['a', 'b', 'c'], created_column_ids: {} }, error: null }))
    const res = await createTable(f.client, WS, { name: '  Hiring  ' }, { userId: 'u-1', source: 'person' })
    expect(res).toMatchObject({ ok: true, value: { table_id: T, version: 1, inserted_row_ids: ['a', 'b', 'c'] } })
    expect(f.rpcCalls[0]).toMatchObject({
      name: 'create_data_table',
      args: { p_workspace_id: WS, p_name: 'Hiring', p_visibility: 'workspace', p_ops: [{ op: 'insert_rows', rows: [{ title: '' }, { title: '' }, { title: '' }] }], p_source: 'person' },
    })
  })

  it('refuses a table with no name or an unknown visibility', async () => {
    const f = db()
    expect(await createTable(f.client, WS, { name: ' ' }, { userId: 'u-1', source: 'person' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await createTable(f.client, WS, { name: 'X', visibility: 'team' as never }, { userId: 'u-1', source: 'person' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(f.rpcCalls).toHaveLength(0)
  })
})

describe('listRows', () => {
  it('pages the live rows in order and says whether there are more', async () => {
    const f = fakeTablesDb(
      { data_row: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, workspace_id: WS, table_id: T, title: `${i}`, custom_fields: null, archived_at: i === 4 ? 'x' : null, position: 5 - i })) },
      () => ({ data: null, error: null }),
    )
    const page = await listRows(f.client, WS, T, { limit: 2 })
    expect(page.rows.map((r) => r.id)).toEqual(['r3', 'r2'])
    expect(page.rows[0].custom_fields).toEqual({})
    expect(page.hasMore).toBe(true)
    expect((await listRows(f.client, WS, T, { limit: 2, offset: 2 })).hasMore).toBe(false)
    expect((await listRows(f.client, WS, T, { archived: true })).rows.map((r) => r.id)).toEqual(['r4'])
  })
})

describe('undoChange', () => {
  it('writes the old values back against the version now and names the change it takes back', async () => {
    const f = db()
    const res = await undoChange(f.client, WS, T, CHANGE, { userId: 'u-1', source: 'person' })
    expect(res).toMatchObject({ ok: true, value: { undone_change_id: CHANGE, version: 5, kept: [] } })
    expect(f.rpcCalls[0].args).toMatchObject({
      p_base_version: 4,
      p_undo_of: CHANGE,
      p_ops: [{ op: 'update_row', row_id: ROW, values: { status: 'Todo' } }],
    })
  })

  it('with no id takes the latest change that is not an undo, and says when there is none', async () => {
    const f = db()
    expect(await undoChange(f.client, WS, T, null, { userId: 'u-1', source: 'person' })).toMatchObject({ ok: true, value: { undone_change_id: CHANGE } })
    f.rows.data_change[0].undone_at = '2026-11-10T11:00:00Z'
    expect(await undoChange(f.client, WS, T, null, { userId: 'u-1', source: 'person' })).toEqual({ ok: false, reason: 'invalid', error: 'Nothing to undo on this table.' })
  })

  it('keeps what changed since, and refuses when nothing is left', async () => {
    const f = db()
    f.rows.data_row[0].custom_fields = { status: 'Todo' }
    expect(await undoChange(f.client, WS, T, CHANGE, { userId: 'u-1', source: 'person' })).toMatchObject({ ok: false, error: expect.stringContaining('Nothing to restore') })
    expect(f.rpcCalls).toHaveLength(0)
  })
})
