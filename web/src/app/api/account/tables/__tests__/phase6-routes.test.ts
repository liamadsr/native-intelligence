/**
 * Tables phase 6 routes: a spreadsheet import is ONE batch with source
 * `import` (so one Undo takes it back), a starter table is made in the one
 * batch that makes it, and a doc's embed answers 404 for a table the reader
 * can't open, saying nothing of it. The session client's RLS is the fake's
 * rows; the RPCs are recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { fakeTablesDb, type FakeTablesDb } from '@/lib/tables/__tests__/fake-tables-db'

const WS = 'ws-1'
const USER = 'u-1'
const T = '33333333-3333-4333-8333-333333333333'
const HIDDEN = '55555555-5555-4555-8555-555555555555'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

const { POST: postImport } = await import('@/app/api/account/tables/[id]/import/route')
const { POST: createTable } = await import('@/app/api/account/tables/route')
const { GET: getEmbed } = await import('@/app/api/account/tables/[id]/embed/route')

let f: FakeTablesDb
beforeEach(() => {
  f = fakeTablesDb(
    {
      data_table: [{ id: T, workspace_id: WS, name: 'Leads', icon: null, description: null, owner_member_id: 'm-1', visibility: 'workspace', version: 4, position: 0, archived_at: null, created_at: '', updated_at: '' }],
      custom_field_definition: [{ id: 'c-1', workspace_id: WS, entity_type: 'data_row', table_id: T, key: 'stage', label: 'Stage', field_type: 'select', options: ['Lead', 'Won'], config: {}, position: 0, deleted_at: null }],
      data_row: [],
      member: [{ id: 'm-1', workspace_id: WS, user_id: USER }],
    },
    (name) =>
      name === 'create_data_table'
        ? { data: { table_id: T, version: 1, change_id: 'ch-made', inserted_row_ids: [], created_column_ids: {} }, error: null }
        : { data: { version: 5, change_id: 'ch-import', inserted_row_ids: [], created_column_ids: {} }, error: null },
  )
  hoisted.requireWorkspace.mockResolvedValue({ supabase: f.client, user: { id: USER }, workspaceId: WS })
})

const send = (url: string, body: unknown) => buildRequest({ url, method: 'POST', body }) as unknown as NextRequest
const get = (url: string) => ({ nextUrl: new URL(url) }) as unknown as NextRequest
const ctx = (id = T) => ({ params: Promise.resolve({ id }) })
const base = 'https://x.test/api/account/tables'

describe('POST /api/account/tables/[id]/import', () => {
  it('writes the file as one batch with source import, and answers its change for Undo', async () => {
    const res = await postImport(
      send(`${base}/${T}/import`, {
        file_name: 'leads.csv',
        headers: ['Name', 'Stage', 'Budget'],
        rows: [
          ['Bayside Bakery', 'Lead', '1200'],
          ['Copper Kettle', 'Won', 'lots'],
        ],
        targets: [{ kind: 'title' }, { kind: 'column', key: 'stage' }, { kind: 'new', label: 'Budget', field_type: 'number' }],
      }),
      ctx(),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ change_id: string; rows: number; misfits: unknown[] }>(res)
    expect(body).toMatchObject({ change_id: 'ch-import', rows: 2, misfits: [{ header: 'Budget', count: 1, example: 'lots' }] })
    expect(f.rpcCalls).toHaveLength(1)
    const call = f.rpcCalls[0]
    expect(call.name).toBe('apply_data_ops')
    expect(call.args).toMatchObject({ p_source: 'import', p_reason: 'Imported 2 rows from leads.csv' })
    expect((call.args.p_ops as Array<{ op: string }>).map((o) => o.op)).toEqual(['create_column', 'insert_rows'])
  })

  it('refuses a request over 6 MB by its length, and reads a body only up to that', async () => {
    const declared = await postImport(buildRequest({ url: `${base}/${T}/import`, method: 'POST', headers: { 'content-length': String(7 * 1024 * 1024) }, body: { headers: [], rows: [], targets: [] } }) as unknown as NextRequest, ctx())
    expect(declared.status).toBe(413)
    const huge = 'x'.repeat(2000)
    const rows = Array.from({ length: 3200 }, () => [huge])
    const big = await postImport(send(`${base}/${T}/import`, { headers: ['Name'], rows, targets: [{ kind: 'title' }] }), ctx())
    expect(big.status).toBe(413)
    expect(f.rpcCalls).toHaveLength(0)
  })

  it('refuses a file over the cap, and a column no file fills', async () => {
    const big = await postImport(send(`${base}/${T}/import`, { headers: ['Name'], rows: Array.from({ length: 5001 }, () => ['x']), targets: [{ kind: 'title' }] }), ctx())
    expect(big.status).toBe(400)
    const rel = await postImport(send(`${base}/${T}/import`, { headers: ['Who'], rows: [['x']], targets: [{ kind: 'new', label: 'Who', field_type: 'relation' }] }), ctx())
    expect(rel.status).toBe(400)
    expect(f.rpcCalls).toHaveLength(0)
  })
})

describe('POST /api/account/tables with a template', () => {
  it('makes the starter’s columns and example rows in the one batch that makes the table', async () => {
    const res = await createTable(send(base, { template: 'inventory' }))
    expect(res.status).toBe(201)
    const call = f.rpcCalls.find((c) => c.name === 'create_data_table')!
    expect(call.args.p_name).toBe('Inventory')
    const ops = call.args.p_ops as Array<{ op: string; key?: string; config?: unknown; rows?: unknown[] }>
    expect(ops.filter((o) => o.op === 'create_column').map((o) => o.key)).toEqual(['sku', 'category', 'in_stock', 'reorder_at', 'unit_cost', 'stock_value', 'reorder'])
    expect(ops.find((o) => o.key === 'stock_value')?.config).toEqual({ expression: '{#in_stock} * {#unit_cost}' })
    expect(ops.find((o) => o.op === 'insert_rows')?.rows).toHaveLength(3)
  })

  it('refuses a starter it doesn’t have', async () => {
    expect((await createTable(send(base, { template: 'crm' }))).status).toBe(400)
  })
})

describe('GET /api/account/tables/[id]/embed', () => {
  it('a table the reader can’t open is a 404 that names nothing', async () => {
    const res = await getEmbed(get(`${base}/${HIDDEN}/embed`), ctx(HIDDEN))
    expect(res.status).toBe(404)
    const body = await readJson<Record<string, unknown>>(res)
    expect(body).toEqual({ error: 'Table not found', locked: true })
  })

  it('answers the table, its shown columns and first rows', async () => {
    const res = await getEmbed(get(`${base}/${T}/embed`), ctx())
    expect(res.status).toBe(200)
    const body = await readJson<{ table: { name: string }; columns: Array<{ key: string }>; rows: unknown[]; view: unknown }>(res)
    expect(body.table.name).toBe('Leads')
    expect(body.columns.map((c) => c.key)).toEqual(['stage'])
    expect(body.view).toBeNull()
  })
})
