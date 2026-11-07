/**
 * /api/account/environments/chat (contract C-A, docs/plans/environments.md
 * §7 Q1): the HTTP shape over src/lib/environments/chat.ts (tested there).
 * GET answers { environmentId, source, environment } with the item
 * GET /api/account/environments lists; PUT sets the chat's (its owner only)
 * and records the person's default; a capture-device token is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDb, type FakeDb } from '@/lib/local-agent/__tests__/fake-db'

const ME = '11111111-1111-4111-8111-111111111111'
const TEAMMATE = '22222222-2222-4222-8222-222222222222'
const WS = '55555555-5555-4555-8555-555555555555'
const MAC = '77777777-7777-4777-8777-777777777777'
const MAC_ENV = '99999999-9999-4999-8999-999999999901'
const SHARED = '99999999-9999-4999-8999-999999999903'
const CONV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const THEIR_CONV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), db: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.db }))

const route = await import('../chat/route')

let db: FakeDb

const get = (query = `?conversationId=${CONV}`, headers: Record<string, string> = {}) =>
  route.GET(new Request(`http://localhost/api/account/environments/chat${query}`, { headers }))
const put = (body: unknown, headers: Record<string, string> = {}) =>
  route.PUT(
    new Request('http://localhost/api/account/environments/chat', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

beforeEach(() => {
  db = fakeDb({
    member: [{ workspace_id: WS, user_id: ME, role: 'member' }],
    workspace: [{ id: WS, default_cloud_environment_id: SHARED }],
    user_device: [{ user_id: ME, id: MAC, name: 'Liam’s Mac', app_version: '0.2.94', last_seen_at: new Date().toISOString(), capabilities: ['baseBranch'] }],
    device_folder: [{ id: '88888888-8888-4888-8888-888888888881', user_id: ME, device_id: MAC, grant_id: 'g1', label: 'site', path: '/Users/l/site', mode: 'edit', is_git: true, revoked_at: null }],
    environment: [
      { id: MAC_ENV, kind: 'mac', name: 'Liam’s Mac', owner_user_id: ME, device_id: MAC, workspace_id: null, archived_at: null, created_at: '2026-10-01', updated_at: '2026-10-01' },
      { id: SHARED, kind: 'cloud', name: 'Default cloud', workspace_id: WS, created_by: TEAMMATE, shared: true, network_access: 'trusted', env_vars: 'K=v', setup_script: null, archived_at: null, created_at: '2026-10-02', updated_at: '2026-10-02' },
    ],
    projects: [],
    environment_default: [],
    chat_conversations: [
      { id: CONV, user_id: ME, workspace_id: WS, environment_id: null },
      { id: THEIR_CONV, user_id: TEAMMATE, workspace_id: WS, environment_id: null },
    ],
  })
  hoisted.db = db
  hoisted.requireWorkspace.mockReset().mockResolvedValue({ supabase: {}, user: { id: ME }, workspaceId: WS })
})

describe('GET /api/account/environments/chat', () => {
  it('answers the chat’s environment, where it came from, and the list’s item (no paths, no secrets)', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body).toMatchObject({ environmentId: MAC_ENV, source: 'mac', environment: { kind: 'mac', id: MAC_ENV, supportsBaseBranch: true, folders: [{ label: 'site' }] } })
    expect(JSON.stringify(body)).not.toContain('/Users/')
  })

  it('a chat I set to the shared cloud one: source chat, its env vars masked for a member', async () => {
    db.tables.chat_conversations[0].environment_id = SHARED
    const body = await (await get()).json()
    expect(body).toMatchObject({ environmentId: SHARED, source: 'chat', environment: { kind: 'cloud', envVars: null, secretsHidden: true } })
  })

  it('without a conversation: from the default on, in the current workspace; someone else’s chat is a 404', async () => {
    expect(await (await get('')).json()).toMatchObject({ environmentId: MAC_ENV, source: 'mac' })
    expect((await get(`?conversationId=${THEIR_CONV}`)).status).toBe(404)
  })

  it('refuses a capture-device token, and passes an auth failure through', async () => {
    const res = await get(undefined, { authorization: 'Bearer d8d_abc' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'DEVICE_TOKEN_REFUSED' })
    expect(hoisted.requireWorkspace).not.toHaveBeenCalled()
    hoisted.requireWorkspace.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    expect((await get()).status).toBe(401)
  })
})

describe('PUT /api/account/environments/chat', () => {
  it('sets the chat’s environment and my default for its workspace; 200 { environmentId }', async () => {
    const res = await put({ conversationId: CONV, environmentId: SHARED })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ environmentId: SHARED })
    expect(db.tables.chat_conversations[0].environment_id).toBe(SHARED)
    expect(db.tables.environment_default).toEqual([expect.objectContaining({ user_id: ME, workspace_id: WS, project_id: null, environment_id: SHARED })])
    expect(await (await get()).json()).toMatchObject({ environmentId: SHARED, source: 'chat' })
  })

  it('null clears the chat’s; environmentId is required; bad JSON is a 400', async () => {
    await put({ conversationId: CONV, environmentId: SHARED })
    expect(await (await put({ conversationId: CONV, environmentId: null })).json()).toEqual({ environmentId: null })
    expect(db.tables.chat_conversations[0].environment_id).toBeNull()
    const missing = await put({ conversationId: CONV })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ code: 'BAD_REQUEST' })
    expect((await put('nope')).status).toBe(400)
  })

  it('someone else’s chat, or an environment that isn’t mine to see, is a 404; a device token a 403', async () => {
    expect((await put({ conversationId: THEIR_CONV, environmentId: SHARED })).status).toBe(404)
    expect((await put({ conversationId: CONV, environmentId: '99999999-9999-4999-8999-999999999999' })).status).toBe(404)
    expect((await put({ conversationId: CONV, environmentId: SHARED }, { authorization: 'Bearer d8d_abc' })).status).toBe(403)
    expect(db.tables.chat_conversations.map((c) => c.environment_id)).toEqual([null, null])
  })
})
