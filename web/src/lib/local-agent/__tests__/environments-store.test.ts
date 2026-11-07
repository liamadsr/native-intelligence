// @vitest-environment jsdom
/**
 * Environments on the client (the second half of src/lib/local-agent/
 * environment-client.ts, docs/plans/environments.md §6).
 *
 * Pinned:
 *   - the routes' items parsed (a Mac without supportsBaseBranch can't take a
 *     base branch; a cloud item's secrets only for an editor; archived ones dropped);
 *   - a chat with no id yet reads the route without one (where a new chat starts);
 *   - the list is read once at a time, a fresh read skipped;
 *   - a pick is PUT and shown at once, and put back when refused; it becomes
 *     where a new chat starts; a chat with no id yet PUTs without one;
 *   - an edit reaches the list and every chat showing it; a forgotten one
 *     makes its chats read again;
 *   - both caches are the window's workspace's: after a switch nothing of the
 *     last one shows, and the next read is the new one's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn() }) }))
vi.mock('../relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))

import {
  CHAT_ENVIRONMENT_URL,
  ENVIRONMENTS_URL,
  applyEnvironment,
  applyFolderSetting,
  configureEnvironment,
  forgetEnvironment,
  getChatEnvironmentSnapshot,
  getEnvironmentsSnapshot,
  parseChatEnvironment,
  parseEnvironmentItem,
  parseEnvironmentList,
  pickChatEnvironment,
  refreshChatEnvironment,
  refreshEnvironments,
  resetEnvironmentStore,
  type EnvironmentItem,
} from '../environment-client'

const MAC = {
  kind: 'mac',
  id: 'env-mac',
  name: "Liam's MacBook Pro",
  deviceId: 'dev-1',
  deviceName: "Liam's MacBook Pro",
  appVersion: '0.3.0',
  lastSeenAt: '2026-10-22T10:00:00Z',
  online: true,
  supportsBaseBranch: true,
  folders: [{ id: 'f-1', label: 'dial8-website', mode: 'edit', isGit: true, baseBranch: 'main', repoFullName: 'liamadsr/dial8-website' }],
  createdAt: 't',
  updatedAt: 't',
}
const CLOUD = {
  kind: 'cloud',
  id: 'env-cloud',
  name: 'Default cloud',
  workspaceId: 'ws-1',
  shared: true,
  networkAccess: 'trusted',
  createdBy: null,
  canEdit: false,
  envVars: 'LEAK=1',
  setupScript: null,
  secretsHidden: true,
  hasEnvVars: true,
  hasSetupScript: false,
  isWorkspaceDefault: true,
  projectCount: 2,
  archivedAt: null,
  createdAt: 't',
  updatedAt: 't',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let now = 1_000_000
let workspace = 'ws-1'
let fetchMock: ReturnType<typeof vi.fn>
function routes(over: { list?: unknown; chat?: unknown; put?: (url: string, body: unknown) => Response } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return over.put ? over.put(url, JSON.parse(String(init.body))) : json({ environmentId: 'x' })
    if (url === ENVIRONMENTS_URL) return json(over.list ?? { environments: [MAC, CLOUD], defaultEnvironmentId: null })
    if (url.startsWith(CHAT_ENVIRONMENT_URL)) return json(over.chat ?? { environmentId: MAC.id, source: 'mac', environment: MAC })
    return json({ error: 'nope' }, 404)
  })
  configureEnvironment({ fetch: fetchMock as never, now: () => now, workspaceId: () => workspace })
}

beforeEach(() => {
  resetEnvironmentStore()
  workspace = 'ws-1'
  toastError.mockClear()
  routes()
})
afterEach(() => {
  configureEnvironment(null)
})

describe('parsing', () => {
  it('a Mac: its folders and settings; supportsBaseBranch missing reads as false', () => {
    const mac = parseEnvironmentItem(MAC)!
    expect(mac.kind).toBe('mac')
    expect(mac.kind === 'mac' && mac.folders[0]).toEqual(MAC.folders[0])
    expect(mac.kind === 'mac' && mac.supportsBaseBranch).toBe(true)
    const older = parseEnvironmentItem({ ...MAC, supportsBaseBranch: undefined })!
    expect(older.kind === 'mac' && older.supportsBaseBranch).toBe(false)
  })

  it('a cloud item: its env vars and script only for an editor', () => {
    const viewer = parseEnvironmentItem(CLOUD)!
    expect(viewer.kind === 'cloud' && [viewer.envVars, viewer.secretsHidden, viewer.hasEnvVars]).toEqual([null, true, true])
    const editor = parseEnvironmentItem({ ...CLOUD, canEdit: true, secretsHidden: false })!
    expect(editor.kind === 'cloud' && editor.envVars).toBe('LEAK=1')
  })

  it('the list drops malformed and archived rows; the chat answer keeps its source', () => {
    const list = parseEnvironmentList({ environments: [MAC, { kind: 'ssh', id: 'x', name: 'y' }, { ...CLOUD, id: 'old', archivedAt: 't' }, CLOUD], defaultEnvironmentId: 'env-cloud' })!
    expect(list.environments.map((e) => e.id)).toEqual(['env-mac', 'env-cloud'])
    expect(list.defaultEnvironmentId).toBe('env-cloud')
    expect(parseEnvironmentList({ nope: true })).toBeNull()
    expect(parseChatEnvironment({ environmentId: MAC.id, source: 'default', environment: MAC })!.source).toBe('default')
    expect(parseChatEnvironment({ environmentId: null, source: 'none', environment: null })).toEqual({ environmentId: null, source: 'none', environment: null })
  })
})

describe('a chat with no id yet', () => {
  it('reads the route without an id: where a new chat here starts', async () => {
    await refreshChatEnvironment(null)
    expect(fetchMock.mock.calls[0][0]).toBe(CHAT_ENVIRONMENT_URL)
    expect(getChatEnvironmentSnapshot(null)).toMatchObject({ loaded: true, environmentId: 'env-mac' })
  })
})

describe('reads', () => {
  it('the list: one at a time, a fresh one skipped', async () => {
    await Promise.all([refreshEnvironments(), refreshEnvironments()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await refreshEnvironments({ maxAgeMs: 5_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now += 6_000
    await refreshEnvironments({ maxAgeMs: 5_000 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getEnvironmentsSnapshot().environments.map((e) => e.id)).toEqual(['env-mac', 'env-cloud'])
  })

  it("a chat's: by conversation id, a fresh one skipped", async () => {
    await refreshChatEnvironment('c-1', { maxAgeMs: 30_000 })
    await refreshChatEnvironment('c-1', { maxAgeMs: 30_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${CHAT_ENVIRONMENT_URL}?conversationId=c-1`)
    expect(getChatEnvironmentSnapshot('c-1')).toMatchObject({ loaded: true, environmentId: 'env-mac', source: 'mac' })
  })
})

describe('a pick', () => {
  it('is PUT and shown at once', async () => {
    await refreshChatEnvironment('c-1')
    const cloud = parseEnvironmentItem(CLOUD)!
    const done = pickChatEnvironment('c-1', cloud)
    expect(getChatEnvironmentSnapshot('c-1')).toMatchObject({ environmentId: 'env-cloud', source: 'chat' })
    expect(await done).toBe(true)
    const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')!
    expect(put[0]).toBe(CHAT_ENVIRONMENT_URL)
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ conversationId: 'c-1', environmentId: 'env-cloud' })
  })

  it('refused: put back, and the toast says the server’s sentence', async () => {
    routes({ put: () => json({ error: 'You can’t use this environment here', code: 'BAD_REQUEST' }, 400) })
    await refreshChatEnvironment('c-1')
    expect(await pickChatEnvironment('c-1', parseEnvironmentItem(CLOUD)!)).toBe(false)
    expect(getChatEnvironmentSnapshot('c-1').environmentId).toBe('env-mac')
    expect(toastError).toHaveBeenCalledWith("Couldn't switch the environment", { description: 'You can’t use this environment here' })
  })

  it('becomes where a new chat starts (the server records it as your default here)', async () => {
    await refreshEnvironments()
    await refreshChatEnvironment('c-1')
    await pickChatEnvironment('c-1', parseEnvironmentItem(CLOUD)!)
    expect(getChatEnvironmentSnapshot(null)).toMatchObject({ environmentId: 'env-cloud', source: 'default' })
    expect(getEnvironmentsSnapshot().defaultEnvironmentId).toBe('env-cloud')
  })

  it('in a chat with no id yet: PUT without one', async () => {
    await refreshChatEnvironment(null)
    expect(await pickChatEnvironment(null, parseEnvironmentItem(CLOUD)!)).toBe(true)
    const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')!
    expect(put[0]).toBe(CHAT_ENVIRONMENT_URL)
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ environmentId: 'env-cloud' })
    expect(getChatEnvironmentSnapshot(null)).toMatchObject({ environmentId: 'env-cloud', source: 'default' })
  })
})

describe('edits', () => {
  it('a saved environment reaches the list and the chats showing it; the app support stands', async () => {
    await refreshEnvironments()
    await refreshChatEnvironment('c-1')
    applyEnvironment({ ...parseEnvironmentItem(MAC)!, name: 'Studio', supportsBaseBranch: false } as EnvironmentItem)
    expect(getEnvironmentsSnapshot().environments[0]).toMatchObject({ name: 'Studio', supportsBaseBranch: true })
    expect(getChatEnvironmentSnapshot('c-1').environment).toMatchObject({ name: 'Studio' })
  })

  it('a folder setting reaches every Mac showing that folder', async () => {
    await refreshEnvironments()
    await refreshChatEnvironment('c-1')
    applyFolderSetting('f-1', { baseBranch: 'develop', repoFullName: null })
    const mac = getEnvironmentsSnapshot().environments[0]
    expect(mac.kind === 'mac' && mac.folders[0]).toMatchObject({ baseBranch: 'develop', repoFullName: null })
    const chatMac = getChatEnvironmentSnapshot('c-1').environment
    expect(chatMac?.kind === 'mac' && chatMac.folders[0].baseBranch).toBe('develop')
  })

  it('a removed one leaves the list, and its chats read where they run now', async () => {
    await refreshEnvironments()
    await refreshChatEnvironment('c-1')
    fetchMock.mockClear()
    forgetEnvironment('env-mac')
    expect(getEnvironmentsSnapshot().environments.map((e) => e.id)).toEqual(['env-cloud'])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${CHAT_ENVIRONMENT_URL}?conversationId=c-1`, expect.anything()))
  })
})

describe('a workspace switch', () => {
  it('the list: nothing of the last workspace shows, and a fresh read is not skipped', async () => {
    await refreshEnvironments({ maxAgeMs: 5_000 })
    expect(getEnvironmentsSnapshot().environments).toHaveLength(2)
    workspace = 'ws-2'
    expect(getEnvironmentsSnapshot()).toMatchObject({ loaded: false, environments: [] })
    routes({ list: { environments: [CLOUD], defaultEnvironmentId: null } })
    await refreshEnvironments({ maxAgeMs: 5_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getEnvironmentsSnapshot().environments.map((e) => e.id)).toEqual(['env-cloud'])
    // Back: the last workspace's list is gone, read again.
    workspace = 'ws-1'
    expect(getEnvironmentsSnapshot().loaded).toBe(false)
  })

  it('a read that lands after the switch is dropped', async () => {
    const landing = refreshEnvironments()
    workspace = 'ws-2'
    await landing
    expect(getEnvironmentsSnapshot().loaded).toBe(false)
  })

  it('a new chat’s default is per workspace: a pick in one never shows in another', async () => {
    await refreshChatEnvironment(null, { maxAgeMs: 30_000 })
    await pickChatEnvironment('c-1', parseEnvironmentItem(CLOUD)!)
    expect(getChatEnvironmentSnapshot(null).environmentId).toBe('env-cloud')
    workspace = 'ws-2'
    expect(getChatEnvironmentSnapshot(null).loaded).toBe(false)
    fetchMock.mockClear()
    await refreshChatEnvironment(null, { maxAgeMs: 30_000 })
    expect(fetchMock).toHaveBeenCalledWith(CHAT_ENVIRONMENT_URL, expect.anything())
    expect(getChatEnvironmentSnapshot(null).environmentId).toBe('env-mac')
  })
})
