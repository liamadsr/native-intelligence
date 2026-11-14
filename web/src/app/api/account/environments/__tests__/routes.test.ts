/**
 * /api/account/environments/** (migration 420): the routes are thin over
 * src/lib/environments (tested there); these pin the HTTP contract: the auth
 * gate (a capture-device token is refused), the body each takes, and that a
 * library refusal comes back in the api-errors shape with its code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDb, type FakeDb } from '@/lib/local-agent/__tests__/fake-db'

const ME = '11111111-1111-4111-8111-111111111111'
const TEAMMATE = '22222222-2222-4222-8222-222222222222'
const WS = '55555555-5555-4555-8555-555555555555'
const MAC = '77777777-7777-4777-8777-777777777777'
const FOLDER = '88888888-8888-4888-8888-888888888881'
const MAC_ENV = '99999999-9999-4999-8999-999999999901'
const SHARED = '99999999-9999-4999-8999-999999999903'
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), db: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.db }))

const list = await import('../route')
const one = await import('../[id]/route')
const folders = await import('../folders/[deviceFolderId]/route')
const macs = await import('../macs/[deviceId]/route')
const defaults = await import('../default/route')

let db: FakeDb

function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/account/environments', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
}
const p = <K extends string>(key: K, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<K, string>) })

beforeEach(() => {
  db = fakeDb({
    member: [{ workspace_id: WS, user_id: ME, role: 'member' }],
    workspace: [{ id: WS, default_cloud_environment_id: SHARED }],
    user_device: [{ user_id: ME, id: MAC, name: 'Liam’s Mac', app_version: '0.2.93', last_seen_at: new Date().toISOString() }],
    device_folder: [{ id: FOLDER, user_id: ME, device_id: MAC, grant_id: 'g1', label: 'site', path: '/Users/l/site', mode: 'read', is_git: true, revoked_at: null }],
    environment: [
      {
        id: MAC_ENV, kind: 'mac', name: 'Liam’s Mac', owner_user_id: ME, device_id: MAC, workspace_id: null, archived_at: null, created_at: '2026-10-01', updated_at: '2026-10-01',
        offered_workers: [{ id: 'claude-code', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }],
      },
      { id: SHARED, kind: 'cloud', name: 'Default cloud', workspace_id: WS, created_by: TEAMMATE, shared: true, network_access: 'trusted', env_vars: 'K=v', setup_script: null, archived_at: null, created_at: '2026-10-02', updated_at: '2026-10-02' },
    ],
    projects: [{ id: PROJECT, workspace_id: WS, environment_id: null }],
    environment_default: [],
    local_agent_session: [],
  })
  hoisted.db = db
  hoisted.requireWorkspace.mockReset().mockResolvedValue({ supabase: {}, user: { id: ME }, workspaceId: WS })
})

describe('GET / POST /api/account/environments', () => {
  it('lists my Macs then the cloud environments, with my workspace default, and no folder paths', async () => {
    await defaults.PUT(request('PUT', { environmentId: MAC_ENV }))
    const res = await list.GET(request('GET'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.defaultEnvironmentId).toBe(MAC_ENV)
    expect(body.environments.map((e: { kind: string; id: string }) => [e.kind, e.id])).toEqual([['mac', MAC_ENV], ['cloud', SHARED]])
    expect(body.environments[1]).toMatchObject({ envVars: null, secretsHidden: true, isWorkspaceDefault: true })
    expect(JSON.stringify(body)).not.toContain('/Users/')
  })

  it('refuses a capture-device token', async () => {
    const res = await list.GET(request('GET', undefined, { authorization: 'Bearer nid_abc' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'DEVICE_TOKEN_REFUSED' })
    expect(hoisted.requireWorkspace).not.toHaveBeenCalled()
  })

  it('passes an auth failure through', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    expect((await list.GET(request('GET'))).status).toBe(401)
  })

  it('creates a cloud environment (restricted by default); a bad body is a 400', async () => {
    const res = await list.POST(request('POST', { name: 'Staging', shared: false }))
    expect(res.status).toBe(200)
    expect((await res.json()).environment).toMatchObject({ kind: 'cloud', name: 'Staging', networkAccess: 'restricted', shared: false, canEdit: true })
    expect((await list.POST(request('POST', { name: 'x', networkAccess: 'open' }))).status).toBe(400)
    expect((await list.POST(request('POST', 'not json'))).status).toBe(400)
    expect((await list.POST(request('POST', [1]))).status).toBe(400)
  })
})

describe('PATCH / DELETE /api/account/environments/[id]', () => {
  it('renames my Mac; refuses anything else on it', async () => {
    const res = await one.PATCH(request('PATCH', { name: 'Work Mac' }), p('id', MAC_ENV))
    expect(res.status).toBe(200)
    expect((await res.json()).environment).toMatchObject({ kind: 'mac', name: 'Work Mac' })
    const bad = await one.PATCH(request('PATCH', { envVars: 'A=1' }), p('id', MAC_ENV))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('a worker the Mac didn’t say it offers: a 409 with the sentence', async () => {
    const res = await one.PATCH(request('PATCH', { worker: 'gemini-cli' }), p('id', MAC_ENV))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'WORKER_NOT_OFFERED', error: expect.stringContaining('doesn’t offer Gemini Cli right now') })
  })

  it('lists what my Mac last said it offers', async () => {
    const body = await (await list.GET(request('GET'))).json()
    expect(body.environments.find((e: { id: string }) => e.id === MAC_ENV)).toMatchObject({ offeredWorkers: [{ id: 'claude-code', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }] })
  })

  it('who does my Mac’s work (migration 658): a coding agent’s id or null; a bad id is a 400; a cloud one has none', async () => {
    const res = await one.PATCH(request('PATCH', { worker: 'claude-code' }), p('id', MAC_ENV))
    expect(res.status).toBe(200)
    expect((await res.json()).environment).toMatchObject({ kind: 'mac', name: 'Liam’s Mac', worker: 'claude-code' })
    expect(db.tables.environment.find((e) => e.id === MAC_ENV)).toMatchObject({ worker: 'claude-code' })
    const back = await one.PATCH(request('PATCH', { worker: null }), p('id', MAC_ENV))
    expect((await back.json()).environment).toMatchObject({ worker: null })
    const bad = await one.PATCH(request('PATCH', { worker: 'Claude Code; rm -rf' }), p('id', MAC_ENV))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ code: 'BAD_REQUEST' })
    db.tables.member[0].role = 'admin'
    expect((await one.PATCH(request('PATCH', { worker: 'codex' }), p('id', SHARED))).status).toBe(400)
    expect(db.tables.environment.find((e) => e.id === SHARED)).not.toHaveProperty('worker')
  })

  it('a teammate (same workspace, not the Mac’s owner) can neither set nor read its worker', async () => {
    db.tables.environment.find((e) => e.id === MAC_ENV)!.worker = 'claude-code'
    db.tables.member.push({ workspace_id: WS, user_id: TEAMMATE, role: 'admin' })
    hoisted.requireWorkspace.mockResolvedValue({ supabase: {}, user: { id: TEAMMATE }, workspaceId: WS })
    const set = await one.PATCH(request('PATCH', { worker: 'codex' }), p('id', MAC_ENV))
    expect(set.status).toBe(404)
    expect(db.tables.environment.find((e) => e.id === MAC_ENV)!.worker).toBe('claude-code')
    const listed = await (await list.GET(request('GET'))).json()
    expect(listed.environments.map((e: { id: string }) => e.id)).not.toContain(MAC_ENV)
    expect(JSON.stringify(listed)).not.toContain('claude-code')
  })

  it('before migration 658 (no column): a worker change is a clear 409, not a bare 500', async () => {
    const from = db.from
    db.from = (table: string) => {
      const q = from(table) as Record<string, unknown>
      if (table !== 'environment') return q
      const select = q.select as (p?: string) => unknown
      q.select = (p?: string) => {
        if (p !== 'offered_workers') return select(p)
        const chain: Record<string, unknown> = {}
        chain.eq = () => chain
        chain.maybeSingle = async () => ({ data: null, error: { code: '42703', message: 'column "offered_workers" does not exist' } })
        return chain
      }
      return q
    }
    const res = await one.PATCH(request('PATCH', { worker: 'codex' }), p('id', MAC_ENV))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'WORKER_NOT_AVAILABLE' })
  })

  it('a cloud one I didn’t make: 403 to change or archive', async () => {
    expect((await one.PATCH(request('PATCH', { name: 'x' }), p('id', SHARED))).status).toBe(403)
    expect((await one.DELETE(request('DELETE'), p('id', SHARED))).status).toBe(403)
  })

  it('an id that is nothing of mine: 404', async () => {
    expect((await one.PATCH(request('PATCH', { name: 'x' }), p('id', 'nope'))).status).toBe(404)
  })

  it('a Mac is removed, not archived (400 here)', async () => {
    expect((await one.DELETE(request('DELETE'), p('id', MAC_ENV))).status).toBe(400)
  })

  it('archiving one a project or the default uses is a 409 with what uses it', async () => {
    db.tables.member[0].role = 'admin'
    const res = await one.DELETE(request('DELETE'), p('id', SHARED))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'ENVIRONMENT_IN_USE', details: { projects: 0, workspaceDefault: true } })
  })

  it('archives one of mine', async () => {
    const made = await (await list.POST(request('POST', { name: 'Mine' }))).json()
    const res = await one.DELETE(request('DELETE'), p('id', made.environment.id))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ archived: true })
  })

  it('unsharing one in use is a 409 with its code', async () => {
    db.tables.member[0].role = 'admin'
    const res = await one.PATCH(request('PATCH', { shared: false }), p('id', SHARED))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'ENVIRONMENT_IN_USE' })
  })
})

describe('PATCH /api/account/environments/folders/[deviceFolderId]', () => {
  it('sets a base branch and a linked repo; a bad branch is a 400', async () => {
    const res = await folders.PATCH(request('PATCH', { baseBranch: 'main', repoFullName: 'dial8/site' }), p('deviceFolderId', FOLDER))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ folder: { deviceFolderId: FOLDER, baseBranch: 'main', repoFullName: 'dial8/site' } })
    expect((await folders.PATCH(request('PATCH', { baseBranch: '@{-1}' }), p('deviceFolderId', FOLDER))).status).toBe(400)
    expect((await folders.PATCH(request('PATCH', { baseBranch: 'main' }), p('deviceFolderId', 'nope'))).status).toBe(404)
  })
})

describe('DELETE /api/account/environments/macs/[deviceId]', () => {
  it('refuses while a job is open on it (409 MAC_BUSY), then removes it', async () => {
    db.tables.local_agent_session.push({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', user_id: ME, workspace_id: WS, device_id: MAC, folder_id: FOLDER, status: 'running',
      started_by: 'person', mode: 'read', request: 'look', current_turn: 1,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(),
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    })
    const busy = await macs.DELETE(request('DELETE'), p('deviceId', MAC))
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ code: 'MAC_BUSY' })
    db.tables.local_agent_session[0].status = 'cancelled'
    const res = await macs.DELETE(request('DELETE'), p('deviceId', MAC))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: true })
    // A soft remove: the device row (and the session under it) stay, marked.
    expect(db.tables.user_device).toEqual([expect.objectContaining({ id: MAC, removed_at: expect.any(String) })])
    expect(db.tables.local_agent_session).toHaveLength(1)
  })
})

describe('PUT /api/account/environments/default', () => {
  it('sets my workspace default and a project default (my Mac only), clears with null', async () => {
    expect(await (await defaults.PUT(request('PUT', { environmentId: SHARED }))).json()).toEqual({ environmentId: SHARED, projectId: null })
    expect(await (await defaults.PUT(request('PUT', { environmentId: MAC_ENV, projectId: PROJECT }))).json()).toEqual({ environmentId: MAC_ENV, projectId: PROJECT })
    expect((await defaults.PUT(request('PUT', { environmentId: SHARED, projectId: PROJECT }))).status).toBe(400)
    expect(await (await defaults.PUT(request('PUT', { environmentId: null }))).json()).toEqual({ environmentId: null, projectId: null })
    expect(db.tables.environment_default.map((r) => r.project_id)).toEqual([PROJECT])
  })

  it('environmentId is required (null clears)', async () => {
    const res = await defaults.PUT(request('PUT', {}))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' })
  })
})
