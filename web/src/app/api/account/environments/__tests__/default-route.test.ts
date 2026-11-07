/**
 * GET /api/account/environments/default (the project panel's "Run my work
 * here on <Mac>" switch reads it): the caller's OWN default, for a project
 * (only ever their own Mac) or, without one, for the workspace; one that
 * can't be used any more reads as null; another workspace only when they
 * belong to it; a capture-device token is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDb, type FakeDb } from '@/lib/local-agent/__tests__/fake-db'

const ME = '11111111-1111-4111-8111-111111111111'
const TEAMMATE = '22222222-2222-4222-8222-222222222222'
const WS = '55555555-5555-4555-8555-555555555555'
const OTHER_WS = '66666666-6666-4666-8666-666666666666'
const MAC = '77777777-7777-4777-8777-777777777777'
const MAC_ENV = '99999999-9999-4999-8999-999999999901'
const SHARED = '99999999-9999-4999-8999-999999999903'
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), db: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.db }))

const route = await import('../default/route')

let db: FakeDb

const get = (query: string, headers: Record<string, string> = {}) =>
  route.GET(new Request(`http://localhost/api/account/environments/default${query}`, { headers }))

beforeEach(() => {
  db = fakeDb({
    member: [{ workspace_id: WS, user_id: ME, role: 'member' }],
    workspace: [{ id: WS, default_cloud_environment_id: SHARED }],
    projects: [{ id: PROJECT, workspace_id: WS, environment_id: null }],
    environment: [
      { id: MAC_ENV, kind: 'mac', name: 'Liam’s Mac', owner_user_id: ME, device_id: MAC, workspace_id: null, archived_at: null },
      { id: SHARED, kind: 'cloud', name: 'Default cloud', workspace_id: WS, created_by: TEAMMATE, shared: true, network_access: 'trusted', archived_at: null },
    ],
    environment_default: [
      { id: 'd1', user_id: ME, workspace_id: WS, project_id: PROJECT, environment_id: MAC_ENV },
      { id: 'd2', user_id: ME, workspace_id: WS, project_id: null, environment_id: SHARED },
      { id: 'd3', user_id: TEAMMATE, workspace_id: WS, project_id: PROJECT, environment_id: MAC_ENV },
    ],
  })
  hoisted.db = db
  hoisted.requireWorkspace.mockReset().mockResolvedValue({ supabase: {}, user: { id: ME }, workspaceId: WS })
})

describe('GET /api/account/environments/default', () => {
  it('my project default (my Mac), and without a projectId my workspace default', async () => {
    const project = await get(`?workspaceId=${WS}&projectId=${PROJECT}`)
    expect(project.status).toBe(200)
    expect(project.headers.get('cache-control')).toBe('no-store')
    expect(await project.json()).toEqual({ environmentId: MAC_ENV })
    expect(await (await get(`?workspaceId=${WS}`)).json()).toEqual({ environmentId: SHARED })
    // The workspace defaults to the current one.
    expect(await (await get(`?projectId=${PROJECT}`)).json()).toEqual({ environmentId: MAC_ENV })
  })

  it('only ever my own rows: a teammate reads theirs, which can’t name my Mac', async () => {
    hoisted.requireWorkspace.mockResolvedValue({ supabase: {}, user: { id: TEAMMATE }, workspaceId: WS })
    db.tables.member.push({ workspace_id: WS, user_id: TEAMMATE, role: 'member' })
    expect(await (await get(`?workspaceId=${WS}&projectId=${PROJECT}`)).json()).toEqual({ environmentId: null })
  })

  it('none set, or one that can’t be used any more: null', async () => {
    db.tables.environment[0].archived_at = new Date().toISOString()
    expect(await (await get(`?workspaceId=${WS}&projectId=${PROJECT}`)).json()).toEqual({ environmentId: null })
    db.tables.environment_default = []
    expect(await (await get(`?workspaceId=${WS}`)).json()).toEqual({ environmentId: null })
  })

  it('another workspace only when I belong to it; ids must be ids', async () => {
    const other = await get(`?workspaceId=${OTHER_WS}&projectId=${PROJECT}`)
    expect(other.status).toBe(403)
    expect(await other.json()).toMatchObject({ code: 'FORBIDDEN' })
    db.tables.member.push({ workspace_id: OTHER_WS, user_id: ME, role: 'member' })
    expect(await (await get(`?workspaceId=${OTHER_WS}`)).json()).toEqual({ environmentId: null })
    expect((await get('?workspaceId=nope')).status).toBe(400)
    expect((await get(`?workspaceId=${WS}&projectId=ENG-42`)).status).toBe(400)
  })

  it('PUT honours a workspaceId as GET does: mine to set there, another workspace only when I belong to it', async () => {
    const put = (body: unknown) =>
      route.PUT(new Request('http://localhost/api/account/environments/default', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const set = await put({ workspaceId: WS, projectId: PROJECT, environmentId: MAC_ENV })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ environmentId: MAC_ENV, projectId: PROJECT })
    const other = await put({ workspaceId: OTHER_WS, environmentId: MAC_ENV })
    expect(other.status).toBe(403)
    expect((await put({ workspaceId: 'nope', environmentId: MAC_ENV })).status).toBe(400)
    expect(db.tables.environment_default.filter((d) => d.workspace_id === OTHER_WS)).toHaveLength(0)
  })

  it('refuses a capture-device token, and passes an auth failure through', async () => {
    const res = await get(`?workspaceId=${WS}`, { authorization: 'Bearer d8d_abc' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'DEVICE_TOKEN_REFUSED' })
    hoisted.requireWorkspace.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    expect((await get(`?workspaceId=${WS}`)).status).toBe(401)
  })
})
