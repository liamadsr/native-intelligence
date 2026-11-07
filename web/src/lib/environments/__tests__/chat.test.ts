/**
 * A chat's environment (docs/plans/environments.md §7 Q1,
 * src/lib/environments/chat.ts) against the in-memory service client: the
 * resolution order (the chat's own, the person's default for its workspace,
 * their most recently online Mac, the workspace default, none), what is
 * skipped (archived, unshared, someone else's), and setting it (the owner
 * only; recorded as the person's default; null clears the chat's).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeDb, type FakeDb, type Row } from '@/lib/local-agent/__tests__/fake-db'
import { pickChatEnvironment, resolveChatEnvironment, setChatEnvironment } from '../chat'
import { EnvironmentError } from '../types'

const ME = '11111111-1111-4111-8111-111111111111'
const TEAMMATE = '22222222-2222-4222-8222-222222222222'
const WS = '55555555-5555-4555-8555-555555555555'
const OTHER_WS = '66666666-6666-4666-8666-666666666666'
const MAC = '77777777-7777-4777-8777-777777777777'
const OLD_MAC = '77777777-7777-4777-8777-777777777778'
const TEAMMATE_MAC = '77777777-7777-4777-8777-777777777779'
const MAC_ENV = '99999999-9999-4999-8999-999999999901'
const OLD_MAC_ENV = '99999999-9999-4999-8999-999999999902'
const TEAMMATE_MAC_ENV = '99999999-9999-4999-8999-999999999903'
const SHARED = '99999999-9999-4999-8999-999999999904'
const MINE_ONLY = '99999999-9999-4999-8999-999999999905'
const THEIRS_ONLY = '99999999-9999-4999-8999-999999999906'
const ARCHIVED = '99999999-9999-4999-8999-999999999907'
const ELSEWHERE = '99999999-9999-4999-8999-999999999908'
const CONV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const THEIR_CONV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc'

const recent = () => new Date(Date.now() - 30_000).toISOString()
const older = () => new Date(Date.now() - 3600_000).toISOString()

function cloud(id: string, over: Row = {}): Row {
  return {
    id, kind: 'cloud', name: `env ${id.slice(-2)}`, workspace_id: WS, created_by: TEAMMATE, shared: true, network_access: 'restricted',
    env_vars: null, setup_script: null, archived_at: null, owner_user_id: null, device_id: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
    ...over,
  }
}
function mac(id: string, userId: string, deviceId: string, name: string): Row {
  return { id, kind: 'mac', name, owner_user_id: userId, device_id: deviceId, workspace_id: null, shared: null, network_access: null, archived_at: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }
}

let db: FakeDb

beforeEach(() => {
  db = fakeDb({
    member: [
      { workspace_id: WS, user_id: ME, role: 'member' },
      { workspace_id: WS, user_id: TEAMMATE, role: 'member' },
    ],
    workspace: [{ id: WS, default_cloud_environment_id: SHARED }, { id: OTHER_WS, default_cloud_environment_id: null }],
    user_device: [
      { user_id: ME, id: MAC, name: 'Liam’s MacBook Pro', app_version: '0.2.94', last_seen_at: recent(), capabilities: ['baseBranch'] },
      { user_id: ME, id: OLD_MAC, name: 'Studio', app_version: '0.2.90', last_seen_at: older() },
      { user_id: TEAMMATE, id: TEAMMATE_MAC, name: 'Their Mac', app_version: '0.2.94', last_seen_at: recent() },
    ],
    device_folder: [],
    environment: [
      mac(MAC_ENV, ME, MAC, 'Liam’s MacBook Pro'),
      mac(OLD_MAC_ENV, ME, OLD_MAC, 'Studio'),
      mac(TEAMMATE_MAC_ENV, TEAMMATE, TEAMMATE_MAC, 'Their Mac'),
      cloud(SHARED, { name: 'Default cloud', network_access: 'trusted' }),
      cloud(MINE_ONLY, { created_by: ME, shared: false }),
      cloud(THEIRS_ONLY, { shared: false }),
      cloud(ARCHIVED, { archived_at: '2026-10-05T00:00:00Z' }),
      cloud(ELSEWHERE, { workspace_id: OTHER_WS }),
    ],
    environment_default: [],
    projects: [],
    chat_conversations: [
      { id: CONV, user_id: ME, workspace_id: WS, environment_id: null },
      { id: THEIR_CONV, user_id: TEAMMATE, workspace_id: WS, environment_id: TEAMMATE_MAC_ENV },
    ],
  })
})

const resolve = (conversationId: string | null = CONV, userId = ME) => resolveChatEnvironment(db as never, { userId, workspaceId: WS, conversationId })

describe('pickChatEnvironment (§7 Q1, pure)', () => {
  const all = { usable: () => true, shared: () => true }
  it('the chat’s own, then the default, then the most recently online Mac, then the workspace default, then none', () => {
    expect(pickChatEnvironment({ ...all, chatEnvironmentId: 'c', defaultEnvironmentId: 'd', macEnvironmentIds: ['m1', 'm2'], workspaceDefaultId: 'w' })).toEqual({ environmentId: 'c', source: 'chat' })
    expect(pickChatEnvironment({ ...all, chatEnvironmentId: null, defaultEnvironmentId: 'd', macEnvironmentIds: ['m1'], workspaceDefaultId: 'w' })).toEqual({ environmentId: 'd', source: 'default' })
    expect(pickChatEnvironment({ ...all, chatEnvironmentId: null, defaultEnvironmentId: null, macEnvironmentIds: ['m1', 'm2'], workspaceDefaultId: 'w' })).toEqual({ environmentId: 'm1', source: 'mac' })
    expect(pickChatEnvironment({ ...all, chatEnvironmentId: null, defaultEnvironmentId: null, macEnvironmentIds: [], workspaceDefaultId: 'w' })).toEqual({ environmentId: 'w', source: 'workspace' })
    expect(pickChatEnvironment({ ...all, chatEnvironmentId: null, defaultEnvironmentId: null, macEnvironmentIds: [], workspaceDefaultId: null })).toEqual({ environmentId: null, source: 'none' })
  })

  it('skips what can’t be used, and a workspace default that isn’t shared', () => {
    const usable = (id: string) => id !== 'c' && id !== 'd' && id !== 'm1'
    expect(pickChatEnvironment({ usable, shared: () => true, chatEnvironmentId: 'c', defaultEnvironmentId: 'd', macEnvironmentIds: ['m1', 'm2'], workspaceDefaultId: 'w' })).toEqual({ environmentId: 'm2', source: 'mac' })
    expect(pickChatEnvironment({ usable: () => true, shared: () => false, chatEnvironmentId: null, defaultEnvironmentId: null, macEnvironmentIds: [], workspaceDefaultId: 'w' })).toEqual({ environmentId: null, source: 'none' })
  })
})

describe('resolveChatEnvironment', () => {
  it('no chat environment and no default: my most recently online Mac, as the environments list shows it', async () => {
    const view = await resolve()
    expect(view).toMatchObject({ environmentId: MAC_ENV, source: 'mac', environment: { kind: 'mac', id: MAC_ENV, online: true, supportsBaseBranch: true } })
  })

  it('the chat’s own wins; then my default for the workspace', async () => {
    db.tables.chat_conversations[0].environment_id = MINE_ONLY
    expect(await resolve()).toMatchObject({ environmentId: MINE_ONLY, source: 'chat', environment: { kind: 'cloud', shared: false } })
    db.tables.chat_conversations[0].environment_id = null
    db.tables.environment_default.push({ id: 'd1', user_id: ME, workspace_id: WS, project_id: null, environment_id: OLD_MAC_ENV })
    expect(await resolve()).toMatchObject({ environmentId: OLD_MAC_ENV, source: 'default' })
  })

  it('a chat environment that was archived, unshared, someone else’s, another workspace’s or a removed Mac’s is skipped', async () => {
    for (const bad of [ARCHIVED, THEIRS_ONLY, TEAMMATE_MAC_ENV, ELSEWHERE]) {
      db.tables.chat_conversations[0].environment_id = bad
      expect(await resolve(), bad).toMatchObject({ environmentId: MAC_ENV, source: 'mac' })
    }
    db.tables.chat_conversations[0].environment_id = OLD_MAC_ENV
    db.tables.user_device[1].removed_at = recent()
    expect(await resolve()).toMatchObject({ environmentId: MAC_ENV, source: 'mac' })
  })

  it('no Mac: the workspace default cloud; none of that either: none', async () => {
    db.tables.user_device = db.tables.user_device.filter((d) => d.user_id !== ME)
    expect(await resolve()).toMatchObject({ environmentId: SHARED, source: 'workspace', environment: { kind: 'cloud', name: 'Default cloud' } })
    db.tables.workspace[0].default_cloud_environment_id = null
    expect(await resolve()).toEqual({ environmentId: null, source: 'none', environment: null })
  })

  it('without a conversation (a chat not made yet): the same order from the default on', async () => {
    db.tables.environment_default.push({ id: 'd1', user_id: ME, workspace_id: WS, project_id: null, environment_id: SHARED })
    expect(await resolve(null)).toMatchObject({ environmentId: SHARED, source: 'default' })
  })

  it('two Macs online: the first added, whichever beat last (it never flips turn to turn)', async () => {
    db.tables.user_device[1].last_seen_at = new Date().toISOString()
    db.tables.environment[0].created_at = '2026-10-03T00:00:00Z'
    db.tables.environment[1].created_at = '2026-10-02T00:00:00Z'
    expect(await resolve()).toMatchObject({ environmentId: OLD_MAC_ENV, source: 'mac' })
    db.tables.user_device[0].last_seen_at = new Date(Date.now() + 5000).toISOString()
    expect(await resolve()).toMatchObject({ environmentId: OLD_MAC_ENV, source: 'mac' })
  })

  it('a start pins what it resolved on the chat; a plain read (the composer) doesn’t', async () => {
    await resolve()
    expect(db.tables.chat_conversations[0].environment_id).toBeNull()
    const pinned = await resolveChatEnvironment(db as never, { userId: ME, workspaceId: WS, conversationId: CONV, pin: true })
    expect(pinned).toMatchObject({ environmentId: MAC_ENV, source: 'mac' })
    expect(db.tables.chat_conversations[0].environment_id).toBe(MAC_ENV)
    expect(await resolve()).toMatchObject({ environmentId: MAC_ENV, source: 'chat' })
  })

  it('someone else’s chat reads as missing', async () => {
    await expect(resolve(THEIR_CONV)).rejects.toMatchObject({ code: 'not_found' })
    await expect(resolve('not-a-uuid')).rejects.toBeInstanceOf(EnvironmentError)
  })
})

describe('setChatEnvironment', () => {
  const set = (environmentId: unknown, conversationId: unknown = CONV, userId = ME) =>
    setChatEnvironment(db as never, { userId, workspaceId: WS, conversationId, environmentId })

  it('sets the chat’s and records it as my default for the chat’s workspace (“the one you picked last here”)', async () => {
    expect(await set(SHARED)).toEqual({ environmentId: SHARED })
    expect(db.tables.chat_conversations[0].environment_id).toBe(SHARED)
    expect(db.tables.environment_default).toEqual([expect.objectContaining({ user_id: ME, workspace_id: WS, project_id: null, environment_id: SHARED })])
    expect(await set(OLD_MAC_ENV)).toEqual({ environmentId: OLD_MAC_ENV })
    expect(db.tables.environment_default).toEqual([expect.objectContaining({ environment_id: OLD_MAC_ENV })])
    expect(await resolve()).toMatchObject({ environmentId: OLD_MAC_ENV, source: 'chat' })
  })

  it('a pick in one chat sets my default, and moves no other chat already pinned', async () => {
    const OTHER_CONV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd'
    db.tables.chat_conversations.push({ id: OTHER_CONV, user_id: ME, workspace_id: WS, environment_id: null })
    // The other chat had a turn: pinned to my Mac.
    await resolveChatEnvironment(db as never, { userId: ME, workspaceId: WS, conversationId: OTHER_CONV, pin: true })
    await set(SHARED)
    expect(await resolve(OTHER_CONV)).toMatchObject({ environmentId: MAC_ENV, source: 'chat' })
    expect(await resolve()).toMatchObject({ environmentId: SHARED, source: 'chat' })
    // A brand-new chat follows the pick.
    expect(await resolve(null)).toMatchObject({ environmentId: SHARED, source: 'default' })
  })

  it('null clears the chat’s and leaves the default', async () => {
    await set(MINE_ONLY)
    expect(await set(null)).toEqual({ environmentId: null })
    expect(db.tables.chat_conversations[0].environment_id).toBeNull()
    expect(await resolve()).toMatchObject({ environmentId: MINE_ONLY, source: 'default' })
  })

  it('without a conversation, only the default', async () => {
    expect(await set(SHARED, null)).toEqual({ environmentId: SHARED })
    expect(db.tables.chat_conversations[0].environment_id).toBeNull()
    expect(db.tables.environment_default).toHaveLength(1)
    await expect(set(null, null)).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('refuses someone else’s Mac or chat, another workspace’s cloud, one I can’t see (404) and one I can see but not use (400)', async () => {
    await expect(set(TEAMMATE_MAC_ENV)).rejects.toMatchObject({ code: 'not_found' })
    await expect(set(ELSEWHERE)).rejects.toMatchObject({ code: 'not_found' })
    await expect(set(THEIRS_ONLY)).rejects.toMatchObject({ code: 'not_found' })
    await expect(set(SHARED, THEIR_CONV)).rejects.toMatchObject({ code: 'not_found' })
    await expect(set(ARCHIVED)).rejects.toMatchObject({ code: 'bad_request' })
    // An admin sees a teammate's "only me" environment, and still can't use it.
    db.tables.member[0].role = 'admin'
    await expect(set(THEIRS_ONLY)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(set(42)).rejects.toMatchObject({ code: 'bad_request' })
    expect(db.tables.chat_conversations[0].environment_id).toBeNull()
    expect(db.tables.environment_default).toHaveLength(0)
  })
})
