/**
 * Tests for the NEW Asana compose-option route:
 *   GET /api/account/asana/users?workspace=<gid>&query=<optional>
 *
 * The two-mode shape mirrors the projects picker next door — typeahead when the
 * user is typing, the authoritative listing when they are not — but the
 * consequence differs: Asana documents typeahead as trading accuracy for speed,
 * so which mode ran is a correctness fact and not just a performance one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => auth.result,
}))

const hoistedConfig = vi.hoisted(() => ({ loadAsanaSyncState: vi.fn() }))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadAsanaSyncState: hoistedConfig.loadAsanaSyncState }
})

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedApi = vi.hoisted(() => ({
  listWorkspaceUsers: vi.fn(),
  typeaheadUsers: vi.fn(),
}))
class FakeUnauthorized extends Error {
  constructor() {
    super('401')
    this.name = 'AsanaUnauthorizedError'
  }
}
vi.mock('@/lib/integrations/asana-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listWorkspaceUsers: hoistedApi.listWorkspaceUsers,
    typeaheadUsers: hoistedApi.typeaheadUsers,
    AsanaUnauthorizedError: FakeUnauthorized,
  }
})

const { GET } = await import('../users/route')

function req(url: string): Request {
  return new Request(url)
}

const URL_ = 'http://x/api/account/asana/users?workspace=ws-gid'

beforeEach(() => {
  vi.clearAllMocks()
  auth.result = { workspaceId: 'ws-1', member: { id: 'm-1', role: 'member' } }
  hoistedConfig.loadAsanaSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: {},
  })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.listWorkspaceUsers.mockResolvedValue({
    users: [{ gid: '1', name: 'Ada', email: 'ada@example.com' }],
    nextOffset: null,
  })
  hoistedApi.typeaheadUsers.mockResolvedValue([{ gid: '2', name: 'Adam' }])
})

describe('GET /api/account/asana/users', () => {
  /** No query = the AUTHORITATIVE listing, which is what a cold picker needs. */
  it('lists the workspace’s users when nothing is typed', async () => {
    const res = await GET(req(URL_))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      users: [{ gid: '1', name: 'Ada', email: 'ada@example.com' }],
    })
    expect(hoistedApi.typeaheadUsers).not.toHaveBeenCalled()
  })

  /** A typed query switches to typeahead — fuzzy, recency-ranked, one page. */
  it('uses typeahead when a query is typed', async () => {
    const body = await (await GET(req(`${URL_}&query=ad`))).json()
    expect(hoistedApi.typeaheadUsers).toHaveBeenCalledWith('tok', 'ws-gid', 'ad')
    expect(hoistedApi.listWorkspaceUsers).not.toHaveBeenCalled()
    expect(body.users).toEqual([{ gid: '2', name: 'Adam', email: null }])
  })

  it('treats a whitespace-only query as no query', async () => {
    await GET(req(`${URL_}&query=%20%20`))
    expect(hoistedApi.listWorkspaceUsers).toHaveBeenCalled()
    expect(hoistedApi.typeaheadUsers).not.toHaveBeenCalled()
  })

  /**
   * `email` is opt-in via opt_fields and can still be null for guests or
   * restricted-visibility members — identity is the gid, email is decorative.
   */
  it('tolerates a null email', async () => {
    hoistedApi.listWorkspaceUsers.mockResolvedValue({
      users: [{ gid: '1', name: 'Ada' }],
      nextOffset: null,
    })
    const body = await (await GET(req(URL_))).json()
    expect(body.users[0]).toEqual({ gid: '1', name: 'Ada', email: null })
  })

  it('drops a user with no gid rather than rendering an unselectable row', async () => {
    hoistedApi.listWorkspaceUsers.mockResolvedValue({
      users: [{ name: 'Ghost' }, { gid: '1', name: 'Ada' }],
      nextOffset: null,
    })
    const body = await (await GET(req(URL_))).json()
    expect(body.users.map((u: { gid: string }) => u.gid)).toEqual(['1'])
  })

  it('falls back to the gid when a user has no name', async () => {
    hoistedApi.listWorkspaceUsers.mockResolvedValue({ users: [{ gid: '1' }], nextOffset: null })
    const body = await (await GET(req(URL_))).json()
    expect(body.users[0].name).toBe('1')
  })

  it('400s a missing `workspace` BEFORE any Asana call', async () => {
    expect((await GET(req('http://x/y'))).status).toBe(400)
    expect(hoistedApi.listWorkspaceUsers).not.toHaveBeenCalled()
  })

  it('400s `not_connected` when no Asana is connected', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue(null)
    const res = await GET(req(URL_))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
  })

  it('400s `reconnect_required` when the token cannot be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    expect((await (await GET(req(URL_))).json()).code).toBe('reconnect_required')
  })

  /** Never a bare 401 — that would read as the CALLER's own session expiring. */
  it('turns a 401 FROM Asana into 400 reconnect_required', async () => {
    hoistedApi.listWorkspaceUsers.mockRejectedValue(new FakeUnauthorized())
    const res = await GET(req(URL_))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('requires workspace membership', async () => {
    auth.result = new Response('nope', { status: 403 })
    expect((await GET(req(URL_))).status).toBe(403)
    expect(hoistedApi.listWorkspaceUsers).not.toHaveBeenCalled()
  })
})
