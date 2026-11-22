/**
 * The canvas routes (migration 676): list and make canvases, read one with its
 * items, patch it, archive/delete it, and write a batch of items. The session
 * client's RLS is the fake's rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { fakeCanvasDb, type FakeCanvasDb } from '@/lib/canvas/__tests__/fake-canvas-db'

const WS = 'ws-1'
const USER = 'u-1'
const MEMBER = 'm-1'
const C = '33333333-3333-4333-8333-333333333333'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), requireWorkspaceMember: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace, requireWorkspaceMember: hoisted.requireWorkspaceMember }))

const { GET: listCanvases, POST: createCanvas } = await import('@/app/api/account/canvases/route')
const { GET: getCanvas, PATCH: patchCanvas, DELETE: deleteCanvas } = await import('@/app/api/account/canvases/[id]/route')
const { POST: postItems } = await import('@/app/api/account/canvases/[id]/items/route')

let f: FakeCanvasDb
function seed() {
  f = fakeCanvasDb({
    canvas: [{ id: C, workspace_id: WS, title: 'Plan', visibility: 'workspace', project_id: null, owner_member_id: MEMBER, settings: {}, version: 2, archived_at: null, created_at: '', updated_at: '' }],
    canvas_item: [{ canvas_id: C, id: 'a', workspace_id: WS, parent_id: null, sort_key: 'a0', kind: 'rectangle', data: { x: 0 } }],
    member: [{ id: MEMBER, workspace_id: WS, user_id: USER }],
  })
  hoisted.requireWorkspace.mockResolvedValue({ supabase: f.client, user: { id: USER }, workspaceId: WS })
  hoisted.requireWorkspaceMember.mockResolvedValue({ supabase: f.client, user: { id: USER }, workspaceId: WS, member: { id: MEMBER } })
}

const get = (url: string) => ({ nextUrl: new URL(url) }) as unknown as NextRequest
const send = (url: string, method: string, body: unknown) => buildRequest({ url, method, body }) as unknown as NextRequest
const ctx = (id = C) => ({ params: Promise.resolve({ id }) })
const base = 'https://x.test/api/account/canvases'

beforeEach(() => seed())

describe('GET and POST /api/account/canvases', () => {
  it('lists the canvases', async () => {
    const res = await listCanvases(get(base))
    expect(res.status).toBe(200)
    expect((await readJson<{ canvases: Array<{ title: string }> }>(res)).canvases.map((c) => c.title)).toEqual(['Plan'])
  })

  it('makes a canvas owned by the caller (201)', async () => {
    const res = await createCanvas(send(base, 'POST', { title: 'Sketch' }))
    expect(res.status).toBe(201)
    const json = await readJson<{ canvas: { title: string; owner_member_id: string } }>(res)
    expect(json.canvas.title).toBe('Sketch')
    expect(json.canvas.owner_member_id).toBe(MEMBER)
  })
})

describe('/api/account/canvases/[id]', () => {
  it('reads a canvas with its items and can_edit, 404s a hidden one', async () => {
    const res = await getCanvas(get(`${base}/${C}`), ctx())
    const json = await readJson<{ canvas: { title: string }; items: unknown[]; can_edit: boolean }>(res)
    expect(json.canvas.title).toBe('Plan')
    expect(json.items).toHaveLength(1)
    expect(json.can_edit).toBe(true)
    expect((await getCanvas(get(`${base}/x`), ctx('55555555-5555-4555-8555-555555555555'))).status).toBe(404)
  })

  it('renames through PATCH', async () => {
    const res = await patchCanvas(send(`${base}/${C}`, 'PATCH', { title: 'Roadmap' }), ctx())
    expect(res.status).toBe(200)
    expect(f.rows.canvas[0].title).toBe('Roadmap')
  })

  it('archives on DELETE and deletes for good with ?permanent=1', async () => {
    const archived = await deleteCanvas(get(`${base}/${C}`), ctx())
    expect(archived.status).toBe(200)
    expect(f.rows.canvas[0].archived_at).not.toBeNull()
    const gone = await deleteCanvas(get(`${base}/${C}?permanent=1`), ctx())
    expect(gone.status).toBe(200)
    expect(f.rows.canvas).toHaveLength(0)
  })
})

describe('POST /api/account/canvases/[id]/items', () => {
  it('writes a batch and answers the new version', async () => {
    const res = await postItems(send(`${base}/${C}/items`, 'POST', { upsert: [{ id: 'b', parent_id: null, sort_key: 'a1', kind: 'ellipse', data: {} }], remove: ['a'] }), ctx())
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ ok: true, version: 3 })
    expect(f.rows.canvas_item.map((i) => i.id)).toEqual(['b'])
  })

  it('400s an unknown kind', async () => {
    const res = await postItems(send(`${base}/${C}/items`, 'POST', { upsert: [{ id: 'b', parent_id: null, sort_key: 'a1', kind: 'star', data: {} }] }), ctx())
    expect(res.status).toBe(400)
  })
})
