/**
 * The editor's routes for what Dial8 has learned (migration 317). On the
 * person's own session RLS decides the rows; these pin what the routes add:
 * the caller's standing for the editor, the add's scope rules (the same
 * saveMemoryLine the `remember` tool uses, as an edit), and errors that name
 * the fix. The [id] routes say "not yours" for a line RLS hid or refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), requireUser: vi.fn() }))
vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  requireWorkspace: hoisted.requireWorkspace,
  requireUser: hoisted.requireUser,
}))

import { GET, POST } from '../route'
import { PATCH, DELETE } from '../[id]/route'

const W = 'ws-1'
const ME = 'user-me'

let db: FakeSupabase
function signIn(role: string) {
  db = makeFakeSupabase({ project: true, defaults: { area_memory: { updated_at: '2026-10-08T00:00:00Z' } } })
  db.seed('member', [{ workspace_id: W, user_id: ME, role }])
  hoisted.requireWorkspace.mockResolvedValue({ supabase: db, user: { id: ME }, workspaceId: W })
  hoisted.requireUser.mockResolvedValue({ supabase: db, user: { id: ME } })
}

const req = (url: string, method: string, body?: unknown) => buildRequest({ url: `https://dial8.ai${url}`, method, body }) as unknown as NextRequest
// buildRequest gives a plain Request; the routes read nextUrl.
function withNextUrl(r: NextRequest): NextRequest {
  Object.defineProperty(r, 'nextUrl', { value: new URL(r.url) })
  return r
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => vi.clearAllMocks())

describe('GET /api/account/memory', () => {
  it('returns the lines and whether the caller may manage the workspace’s', async () => {
    signIn('member')
    db.seed('area_memory', [{ id: 'a', workspace_id: W, area: 'mail', scope: 'personal', user_id: ME, text: 'x', status: 'active', source: 'told' }])
    const body = await readJson(await GET(withNextUrl(req('/api/account/memory', 'GET'))))
    expect(body).toMatchObject({ userId: ME, canManageWorkspace: false })
    expect((body as { lines: unknown[] }).lines).toHaveLength(1)
    signIn('admin')
    expect(await readJson(await GET(withNextUrl(req('/api/account/memory?area=mail', 'GET'))))).toMatchObject({ canManageWorkspace: true })
  })

  it('names the areas on a bad area', async () => {
    signIn('member')
    const res = await GET(withNextUrl(req('/api/account/memory?area=email', 'GET')))
    expect(res.status).toBe(400)
    expect(((await readJson(res)) as { error: string }).error).toMatch(/area must be one of calendar, actions/)
  })
})

describe('POST /api/account/memory', () => {
  it('adds a personal line as edited and active', async () => {
    signIn('member')
    const res = await POST(withNextUrl(req('/api/account/memory', 'POST', { area: 'mail', scope: 'personal', text: 'Be brief' })))
    expect(res.status).toBe(201)
    expect(db.rows('area_memory')[0]).toMatchObject({ scope: 'personal', user_id: ME, status: 'active', source: 'edited' })
  })

  it('proposes a member’s workspace line; an admin’s is active', async () => {
    signIn('member')
    await POST(withNextUrl(req('/api/account/memory', 'POST', { area: 'crm', scope: 'workspace', text: 'Log calls' })))
    expect(db.rows('area_memory')[0]).toMatchObject({ status: 'proposed', user_id: null })
    signIn('owner')
    await POST(withNextUrl(req('/api/account/memory', 'POST', { area: 'crm', scope: 'workspace', text: 'Log calls' })))
    expect(db.rows('area_memory')[0]).toMatchObject({ status: 'active' })
  })

  it('refuses a bad scope or a secret with the fix', async () => {
    signIn('member')
    const bad = await POST(withNextUrl(req('/api/account/memory', 'POST', { area: 'mail', scope: 'team', text: 'x' })))
    expect(bad.status).toBe(400)
    expect(((await readJson(bad)) as { error: string }).error).toBe('scope must be personal or workspace.')
    const secret = await POST(withNextUrl(req('/api/account/memory', 'POST', { area: 'mail', scope: 'personal', text: 'api key: sk-abcdefghijklmnop' })))
    expect(secret.status).toBe(400)
    expect(db.rows('area_memory')).toHaveLength(0)
  })
})

describe('/api/account/memory/[id]', () => {
  it('accepts only a proposed line, and edits a line as edited', async () => {
    signIn('admin')
    db.seed('area_memory', [{ id: 'p', workspace_id: W, area: 'crm', scope: 'workspace', user_id: null, text: 'Log calls', status: 'proposed', source: 'told' }])
    const ok = await PATCH(req('/api/account/memory/p', 'PATCH', { status: 'active' }), params('p'))
    expect(ok.status).toBe(200)
    expect(db.rows('area_memory')[0].status).toBe('active')
    // Already active: nothing to accept, and the answer says so.
    expect((await PATCH(req('/api/account/memory/p', 'PATCH', { status: 'active' }), params('p'))).status).toBe(404)
    const edited = await PATCH(req('/api/account/memory/p', 'PATCH', { text: '  Log every call  ' }), params('p'))
    expect(edited.status).toBe(200)
    expect(db.rows('area_memory')[0]).toMatchObject({ text: 'Log every call', source: 'edited' })
  })

  it('refuses status other than active, and an empty edit, naming the fix', async () => {
    signIn('member')
    const r1 = await PATCH(req('/api/account/memory/p', 'PATCH', { status: 'proposed' }), params('p'))
    expect(((await readJson(r1)) as { error: string }).error).toMatch(/To dismiss a proposal, DELETE it/)
    const r2 = await PATCH(req('/api/account/memory/p', 'PATCH', { text: '   ' }), params('p'))
    expect(r2.status).toBe(400)
  })

  it('DELETE says not yours when RLS deleted nothing, ok when it did', async () => {
    const deleted: string[][] = [[], ['x']]
    const supabase = {
      from: () => ({ delete: () => ({ eq: () => ({ select: async () => ({ data: deleted.shift()!.map((id) => ({ id })), error: null }) }) }) }),
    }
    hoisted.requireUser.mockResolvedValue({ supabase, user: { id: ME } })
    const refused = await DELETE(req('/api/account/memory/x', 'DELETE'), params('x'))
    expect(refused.status).toBe(404)
    expect(((await readJson(refused)) as { error: string }).error).toMatch(/only withdraw their own proposal/)
    expect((await DELETE(req('/api/account/memory/x', 'DELETE'), params('x'))).status).toBe(200)
  })
})
