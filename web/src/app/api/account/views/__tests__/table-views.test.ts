/**
 * A table's saved views through /api/account/views (Tables, phase 4): a view
 * of a table's rows names its table and takes only the grid, board, calendar
 * and gallery; its metadata (widths, hidden columns, layout picks) is kept;
 * the three table-only layouts are refused elsewhere; and a table's views
 * are listed only to someone who can read the table.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  getTable: vi.fn(),
  viewInsert: vi.fn(),
  viewReads: 0,
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/tables/store', () => ({ getTable: hoisted.getTable }))

const T = '33333333-3333-4333-8333-333333333333'

function chain(result: unknown) {
  const target: Record<string, unknown> = { then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb) }
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, prop: string) {
      if (prop in t) return t[prop]
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      return () => new Proxy(target, handler)
    },
  }
  return new Proxy(target, handler)
}

const VIEW = { id: 'v-1', name: 'Pipeline', entity_type: 'data_row', scope_type: 'data_table', scope_id: T, layout: 'board', visibility: 'workspace' }
const supabase = {
  from: (table: string) => {
    if (table === 'view') {
      return {
        select: () => {
          hoisted.viewReads++
          return chain({ data: [VIEW], count: 1, error: null })
        },
        insert: (payload: unknown) => {
          hoisted.viewInsert(payload)
          return chain({ data: { id: 'view-new', ...(payload as Record<string, unknown>) }, error: null })
        },
      }
    }
    return chain({ data: [], error: null })
  },
}

const { GET, POST } = await import('@/app/api/account/views/route')

const getReq = (query: string) => {
  const url = `https://nativeintelligence.dev/api/account/views${query}`
  const req = buildRequest({ url, method: 'GET' }) as Request & { nextUrl: URL }
  req.nextUrl = new URL(url)
  return req as unknown as NextRequest
}
const postReq = (body: unknown) => buildRequest({ url: 'https://nativeintelligence.dev/api/account/views', method: 'POST', body }) as unknown as NextRequest

beforeEach(() => {
  hoisted.requireWorkspace.mockReset().mockResolvedValue({ supabase, user: { id: 'user-1' }, workspaceId: 'ws-1' })
  hoisted.getTable.mockReset().mockResolvedValue({ id: T, columns: [] })
  hoisted.viewInsert.mockReset()
  hoisted.viewReads = 0
})

describe('POST a table’s view', () => {
  it('keeps its layout, scope, column order and metadata', async () => {
    const metadata = { table: { widths: { title: 320 }, hidden: ['notes'], total_key: 'price' } }
    const res = await POST(postReq({ name: 'Pipeline', entity_type: 'data_row', layout: 'board', visibility: 'workspace', filters: [], ordering: [], grouping: { field: 'custom_fields.stage', direction: 'asc' }, display_properties: ['stage', 'price'], scope_type: 'data_table', scope_id: T, metadata }))
    expect(res.status).toBe(201)
    expect(hoisted.viewInsert).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'data_row',
      layout: 'board',
      visibility: 'workspace',
      scope_type: 'data_table',
      scope_id: T,
      display_properties: ['stage', 'price'],
      grouping: { field: 'custom_fields.stage', direction: 'asc' },
      metadata,
      // A table's board names its own group; there is no kind-wide default.
      board_group_by: null,
    }))
  })

  it('opens on the grid when it names no layout', async () => {
    await POST(postReq({ name: 'All', entity_type: 'data_row', filters: [], ordering: [], scope_type: 'data_table', scope_id: T }))
    expect(hoisted.viewInsert).toHaveBeenCalledWith(expect.objectContaining({ layout: 'grid', ordering: [] }))
  })

  it('refuses a list layout, and a view that names no table', async () => {
    const list = await POST(postReq({ name: 'x', entity_type: 'data_row', layout: 'list', scope_type: 'data_table', scope_id: T }))
    expect(list.status).toBe(400)
    const unscoped = await POST(postReq({ name: 'x', entity_type: 'data_row', layout: 'grid' }))
    expect(unscoped.status).toBe(400)
    expect(((await readJson(unscoped)) as { error: string }).error).toMatch(/names its table/)
    expect(hoisted.viewInsert).not.toHaveBeenCalled()
  })

  it('refuses the table-only layouts for any other kind (a board stays every kind’s)', async () => {
    for (const layout of ['grid', 'calendar', 'gallery']) {
      const res = await POST(postReq({ name: 'x', entity_type: 'contact', layout }))
      expect(res.status, layout).toBe(400)
    }
    const board = await POST(postReq({ name: 'x', entity_type: 'contact', layout: 'board' }))
    expect(board.status).toBe(201)
  })
})

describe('GET a table’s views', () => {
  it('lists them to a reader of the table', async () => {
    const res = await GET(getReq(`?entity_type=data_row&scope_type=data_table&scope_id=${T}`))
    expect(((await readJson(res)) as { views: unknown[] }).views).toHaveLength(1)
    expect(hoisted.getTable).toHaveBeenCalledWith(supabase, 'ws-1', T)
  })

  it('lists none, and reads none, to someone who can’t read the table', async () => {
    hoisted.getTable.mockResolvedValue(null)
    const res = await GET(getReq(`?entity_type=data_row&scope_type=data_table&scope_id=${T}`))
    expect(await readJson(res)).toEqual({ views: [], total: 0 })
    expect(hoisted.viewReads).toBe(0)
  })
})
