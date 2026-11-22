/**
 * Comment threads on a spreadsheet's cells (migration 675): list as threads,
 * post a thread or a reply, edit one's own words, resolve and reopen, move an
 * anchor, delete. The database is an in-memory stand-in; the row policies and
 * the comment guard are migration 675's and are pinned in migration-675.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { memoryDb } from '@/test/memory-db'
import { blankWorkbook } from '@/lib/spreadsheets/store'

const WS = 'ws-1'
const ME = 'm-1'
const S = '33333333-3333-4333-8333-333333333333'
const C1 = 'cccccccc-1111-4111-8111-111111111111'

const hoisted = vi.hoisted(() => ({ requireWorkspaceMember: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: hoisted.requireWorkspaceMember }))

const { GET: list, POST: post } = await import('@/app/api/account/spreadsheets/[id]/comments/route')
const { PATCH: patch, DELETE: remove } = await import('@/app/api/account/spreadsheets/[id]/comments/[commentId]/route')

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

function seed() {
  tables = {
    spreadsheet: [
      { id: S, workspace_id: WS, title: 'Plan', created_by: ME, visibility: 'workspace', status: 'active', revision: 1, sheet_names: ['Sheet1'], workbook: blankWorkbook(), extras: {}, updated_at: '2026-11-20T10:00:00Z' },
    ],
    spreadsheet_comment: [],
    member: [
      { id: ME, workspace_id: WS, display_name: 'Dana Okafor' },
      { id: 'm-2', workspace_id: WS, display_name: 'Priya Chandra' },
    ],
  }
  hoisted.requireWorkspaceMember.mockResolvedValue({ supabase: memoryDb(tables), user: { id: 'u-1' }, workspaceId: WS, member: { id: ME } })
}

const get = (url: string) => ({ nextUrl: new URL(url) }) as unknown as NextRequest
const send = (url: string, method: string, body: unknown) => buildRequest({ url, method, body }) as unknown as NextRequest
const ctx = (id = S) => ({ params: Promise.resolve({ id }) })
const cctx = (commentId: string, id = S) => ({ params: Promise.resolve({ id, commentId }) })
const base = `https://x.test/api/account/spreadsheets/${S}/comments`

beforeEach(() => seed())

describe('POST and GET comments', () => {
  it('starts a thread, normalising the anchor, and lists it with the author', async () => {
    const res = await post(send(base, 'POST', { sheet_id: 7, anchor: 'b3', body: '  Check this  ' }), ctx())
    expect(res.status).toBe(201)
    const row = tables.spreadsheet_comment[0]
    expect(row).toMatchObject({ sheet_id: 7, anchor: 'B3', body: 'Check this', author_id: ME, parent_id: null })

    const json = await readJson<{ threads: Array<Record<string, unknown>> }>(await list(get(base), ctx()))
    expect(json.threads).toHaveLength(1)
    expect(json.threads[0]).toMatchObject({ anchor: 'B3', reply_count: 0 })
    expect((json.threads[0].root as Record<string, unknown>).author_name).toBe('Dana Okafor')
  })

  it('refuses an empty body or an anchor that is not a cell', async () => {
    expect((await post(send(base, 'POST', { sheet_id: 0, anchor: 'A1', body: '   ' }), ctx())).status).toBe(400)
    expect((await post(send(base, 'POST', { sheet_id: 0, anchor: 'nope', body: 'hi' }), ctx())).status).toBe(400)
  })

  it('404s a spreadsheet the caller cannot read', async () => {
    tables.spreadsheet = []
    expect((await list(get(base), ctx())).status).toBe(404)
    expect((await post(send(base, 'POST', { sheet_id: 0, anchor: 'A1', body: 'hi' }), ctx())).status).toBe(404)
  })

  it('adds a reply under a thread and groups it', async () => {
    await post(send(base, 'POST', { sheet_id: 0, anchor: 'A1', body: 'root' }), ctx())
    const root = tables.spreadsheet_comment[0].id as string
    const res = await post(send(base, 'POST', { parent_id: root, body: 'a reply' }), ctx())
    expect(res.status).toBe(201)
    const json = await readJson<{ threads: Array<Record<string, unknown>> }>(await list(get(base), ctx()))
    expect(json.threads).toHaveLength(1)
    expect(json.threads[0].reply_count).toBe(1)
    expect((json.threads[0].replies as Array<Record<string, unknown>>)[0].body).toBe('a reply')
  })
})

describe('PATCH and DELETE a comment', () => {
  beforeEach(async () => {
    seed()
    tables.spreadsheet_comment.push({
      id: C1, spreadsheet_id: S, workspace_id: WS, parent_id: null, sheet_id: 0, anchor: 'A1', body: 'first',
      mentions: [], author_id: ME, resolved_at: null, resolved_by: null, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z',
    })
  })

  it('edits the body', async () => {
    const res = await patch(send(`${base}/${C1}`, 'PATCH', { body: 'edited' }), cctx(C1))
    expect(res.status).toBe(200)
    expect(tables.spreadsheet_comment[0].body).toBe('edited')
  })

  it('resolves as oneself and reopens', async () => {
    await patch(send(`${base}/${C1}`, 'PATCH', { resolved: true }), cctx(C1))
    expect(tables.spreadsheet_comment[0].resolved_by).toBe(ME)
    expect(tables.spreadsheet_comment[0].resolved_at).toBeTruthy()
    await patch(send(`${base}/${C1}`, 'PATCH', { resolved: false }), cctx(C1))
    expect(tables.spreadsheet_comment[0].resolved_at).toBeNull()
  })

  it('moves the anchor', async () => {
    const res = await patch(send(`${base}/${C1}`, 'PATCH', { anchor: 'c9', sheet_id: 2 }), cctx(C1))
    expect(res.status).toBe(200)
    expect(tables.spreadsheet_comment[0]).toMatchObject({ anchor: 'C9', sheet_id: 2 })
  })

  it('deletes it', async () => {
    expect((await remove(get(`${base}/${C1}`), cctx(C1))).status).toBe(200)
    expect(tables.spreadsheet_comment).toHaveLength(0)
  })
})
