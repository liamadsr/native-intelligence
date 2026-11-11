/**
 * The tables routes (Tables, phase 1): list and make tables, read one, a batch
 * of ops (409 on a stale version), a page of rows, the history and Undo. The
 * session client's RLS is the fake's rows; the RPCs are answered here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { fakeTablesDb, type FakeTablesDb } from '@/lib/tables/__tests__/fake-tables-db'

const WS = 'ws-1'
const USER = 'u-1'
const T = '33333333-3333-4333-8333-333333333333'
const ROW = '11111111-1111-4111-8111-111111111111'
const CHANGE = '44444444-4444-4444-8444-444444444444'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

const { GET: listTables, POST: createTable } = await import('@/app/api/account/tables/route')
const { GET: getTable, PATCH: patchTable } = await import('@/app/api/account/tables/[id]/route')
const { POST: postOps } = await import('@/app/api/account/tables/[id]/ops/route')
const { GET: getRows } = await import('@/app/api/account/tables/[id]/rows/route')
const { GET: getChanges } = await import('@/app/api/account/tables/[id]/changes/route')
const { POST: postUndo } = await import('@/app/api/account/tables/[id]/undo/route')

type Rpc = (name: string, args: Record<string, unknown>) => { data: unknown; error: { code?: string; message: string; details?: string } | null }
const applied: Rpc = () => ({ data: { version: 5, change_id: 'ch-new', inserted_row_ids: [], created_column_ids: {} }, error: null })

let f: FakeTablesDb
function seed(rpc: Rpc = applied) {
  f = fakeTablesDb(
    {
      data_table: [{ id: T, workspace_id: WS, name: 'Orders', icon: null, description: null, owner_member_id: 'm-1', visibility: 'workspace', version: 4, position: 0, archived_at: null, created_at: '', updated_at: '' }],
      custom_field_definition: [{ id: 'c-1', workspace_id: WS, entity_type: 'data_row', table_id: T, key: 'status', label: 'Status', field_type: 'select', options: ['Todo', 'Done'], position: 0, deleted_at: null }],
      data_row: [{ id: ROW, workspace_id: WS, table_id: T, title: 'Order 1', custom_fields: { status: 'Done' }, archived_at: null, position: 1 }],
      data_change: [
        { id: CHANGE, workspace_id: WS, table_id: T, version: 4, source: 'person', changes: [{ op: 'update_row', row_id: ROW, fields: { title: { from: '', to: 'Order 1' } } }], undo_of: null, undone_at: null, created_at: '2026-11-10T10:00:00Z' },
      ],
      member: [{ id: 'm-1', workspace_id: WS, user_id: USER }],
    },
    rpc,
  )
  hoisted.requireWorkspace.mockResolvedValue({ supabase: f.client, user: { id: USER }, workspaceId: WS })
}

const get = (url: string) => ({ nextUrl: new URL(url) }) as unknown as NextRequest
const send = (url: string, method: string, body: unknown) => buildRequest({ url, method, body }) as unknown as NextRequest
const ctx = (id = T) => ({ params: Promise.resolve({ id }) })
const base = 'https://x.test/api/account/tables'

beforeEach(() => seed())

describe('GET and POST /api/account/tables', () => {
  it('lists the tables the caller can read', async () => {
    const res = await listTables(get(base))
    expect(res.status).toBe(200)
    expect((await readJson<{ tables: Array<{ name: string }> }>(res)).tables.map((t) => t.name)).toEqual(['Orders'])
  })

  it('makes a table with three blank rows and answers it with its columns', async () => {
    seed(() => ({ data: { table_id: T, version: 1, change_id: 'ch-1', inserted_row_ids: ['a', 'b', 'c'], created_column_ids: {} }, error: null }))
    const res = await createTable(send(base, 'POST', { name: 'Orders' }))
    expect(res.status).toBe(201)
    const json = await readJson<{ table: { id: string; columns: unknown[] }; version: number }>(res)
    expect(json.table.id).toBe(T)
    expect(json.version).toBe(1)
    expect(f.rpcCalls[0].args.p_ops).toEqual([{ op: 'insert_rows', rows: [{ title: '' }, { title: '' }, { title: '' }] }])
  })

  it('refuses a table without a name', async () => {
    expect((await createTable(send(base, 'POST', { name: '' }))).status).toBe(400)
    expect((await createTable(send(base, 'POST', { name: 'X', visibility: 'everyone' }))).status).toBe(400)
  })
})

describe('/api/account/tables/[id]', () => {
  it('reads a table with its columns, and 404s one the caller can’t read', async () => {
    const res = await getTable(get(`${base}/${T}`), ctx())
    expect((await readJson<{ table: { columns: Array<{ key: string }> } }>(res)).table.columns.map((c) => c.key)).toEqual(['status'])
    expect((await getTable(get(`${base}/x`), ctx('55555555-5555-4555-8555-555555555555'))).status).toBe(404)
  })

  it('renames through one batch with no version check (the actions menu’s Rename)', async () => {
    const res = await patchTable(send(`${base}/${T}`, 'PATCH', { name: 'Customer orders' }), ctx())
    expect(res.status).toBe(200)
    expect(f.rpcCalls[0].args).toMatchObject({ p_base_version: null, p_ops: [{ op: 'update_table', name: 'Customer orders' }] })
  })
})

describe('POST /api/account/tables/[id]/ops', () => {
  it('applies a batch and answers the new version', async () => {
    const res = await postOps(send(`${base}/${T}/ops`, 'POST', { base_version: 4, ops: [{ op: 'update_row', row_id: ROW, title: 'Order one' }] }), ctx())
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ version: 5, change_id: 'ch-new', inserted_row_ids: [], created_column_ids: {} })
  })

  it('needs the version it read', async () => {
    expect((await postOps(send(`${base}/${T}/ops`, 'POST', { ops: [{ op: 'archive_table' }] }), ctx())).status).toBe(400)
  })

  it('is a 409 with the version now when someone wrote in between', async () => {
    seed(() => ({ data: null, error: { code: 'PT409', message: 'the table changed since version 3', details: '4' } }))
    const res = await postOps(send(`${base}/${T}/ops`, 'POST', { base_version: 3, ops: [{ op: 'archive_table' }] }), ctx())
    expect(res.status).toBe(409)
    expect(await readJson(res)).toMatchObject({ code: 'VERSION_CONFLICT', details: { version: 4 } })
  })

  it('is a 403 for a view-only reader, and a 400 for a value that does not fit', async () => {
    seed(() => ({ data: null, error: { code: '42501', message: 'you can view this table but not change it' } }))
    expect((await postOps(send(`${base}/${T}/ops`, 'POST', { base_version: 4, ops: [{ op: 'archive_table' }] }), ctx())).status).toBe(403)
    const bad = await postOps(send(`${base}/${T}/ops`, 'POST', { base_version: 4, ops: [{ op: 'update_row', row_id: ROW, values: { status: 'Maybe' } }] }), ctx())
    expect(bad.status).toBe(400)
  })
})

describe('rows, history and undo', () => {
  it('pages the rows', async () => {
    const res = await getRows(get(`${base}/${T}/rows?limit=10`), ctx())
    expect(await readJson(res)).toMatchObject({ rows: [{ id: ROW, title: 'Order 1' }], has_more: false })
  })

  it('lists the history, newest first', async () => {
    const res = await getChanges(get(`${base}/${T}/changes`), ctx())
    expect((await readJson<{ changes: Array<{ id: string }> }>(res)).changes.map((c) => c.id)).toEqual([CHANGE])
  })

  it('undoes a change, and says why it can’t when it can’t', async () => {
    const res = await postUndo(send(`${base}/${T}/undo`, 'POST', { change_id: CHANGE }), ctx())
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ undone_change_id: CHANGE, restored: ['the name of “Order 1”'], kept: [] })
    expect(f.rpcCalls[0].args).toMatchObject({ p_undo_of: CHANGE, p_ops: [{ op: 'update_row', row_id: ROW, title: '' }] })
    f.rows.data_row[0].title = 'Renamed since'
    const refused = await postUndo(send(`${base}/${T}/undo`, 'POST', { change_id: CHANGE }), ctx())
    expect(refused.status).toBe(400)
  })
})

describe('a failed database read', () => {
  it('answers 500 in the api-errors shape on every write route, never a bare throw', async () => {
    const broken = () => {
      throw new Error('connection reset')
    }
    Object.assign(f.client, { from: broken, rpc: broken })
    const answers = await Promise.all([
      createTable(send(base, 'POST', { name: 'Hires' })),
      patchTable(send(`${base}/${T}`, 'PATCH', { name: 'X' }), ctx()),
      postOps(send(`${base}/${T}/ops`, 'POST', { base_version: 4, ops: [{ op: 'archive_table' }] }), ctx()),
      postUndo(send(`${base}/${T}/undo`, 'POST', {}), ctx()),
    ])
    for (const res of answers) {
      expect(res.status).toBe(500)
      expect(await readJson(res)).toMatchObject({ error: expect.any(String) })
    }
  })
})
