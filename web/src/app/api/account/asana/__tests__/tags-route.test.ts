/**
 * Tests for GET /api/account/asana/tags?workspace=<gid>
 *
 * The property lens's tag picker. Mirrors the invariants pickers.test.ts locks in
 * for the other Asana option routes, because this route is deliberately one of
 * them:
 *  - membership is required (requireWorkspaceMember short-circuits).
 *  - the required query param is validated before any Asana call.
 *  - no connected Asana → 400 not_connected; unmintable token → 400
 *    reconnect_required; a 401 FROM Asana → 400 reconnect_required (never a bare
 *    401, which would read as the caller's own session expiring).
 *
 * The one thing that is NOT like its siblings: the scope is the WORKSPACE, not a
 * project. An Asana tag belongs to a workspace and is applicable to any task in it,
 * where a section belongs to exactly one project.
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

const hoistedLens = vi.hoisted(() => ({ listWorkspaceTags: vi.fn() }))
vi.mock('@/lib/tasks/asana-lens', () => ({
  listWorkspaceTags: hoistedLens.listWorkspaceTags,
}))

class FakeUnauthorized extends Error {
  readonly code = 'ASANA_UNAUTHORIZED'
  constructor() {
    super('401')
    this.name = 'AsanaUnauthorizedError'
  }
}
vi.mock('@/lib/integrations/asana-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, AsanaUnauthorizedError: FakeUnauthorized }
})

const { GET } = await import('../tags/route')

function req(query = 'workspace=aw-1'): Request {
  return new Request(`http://x/api/account/asana/tags?${query}`)
}

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
  hoistedLens.listWorkspaceTags.mockResolvedValue([{ gid: 't-1', name: 'urgent' }])
})

describe('GET /api/account/asana/tags', () => {
  it('returns the workspace`s tags', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tags: [{ gid: 't-1', name: 'urgent' }] })
    expect(hoistedLens.listWorkspaceTags).toHaveBeenCalledWith('tok', 'aw-1')
  })

  it('short-circuits when requireWorkspaceMember returns a Response', async () => {
    auth.result = new Response('nope', { status: 403 })
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(hoistedLens.listWorkspaceTags).not.toHaveBeenCalled()
  })

  it('requires the workspace query param', async () => {
    const res = await GET(req(''))
    expect(res.status).toBe(400)
    expect(hoistedLens.listWorkspaceTags).not.toHaveBeenCalled()
  })

  it('treats a whitespace-only workspace as absent', async () => {
    const res = await GET(req('workspace=%20%20'))
    expect(res.status).toBe(400)
    expect(hoistedLens.listWorkspaceTags).not.toHaveBeenCalled()
  })

  it('returns 400 not_connected when the workspace has no Asana row', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
    expect(hoistedLens.listWorkspaceTags).not.toHaveBeenCalled()
  })

  it('returns 400 reconnect_required when the token cannot be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('maps a 401 FROM Asana to 400 reconnect_required, not a bare 401', async () => {
    hoistedLens.listWorkspaceTags.mockRejectedValue(new FakeUnauthorized())
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('surfaces any other Asana failure as a 500', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoistedLens.listWorkspaceTags.mockRejectedValue(new Error('boom'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    errSpy.mockRestore()
  })

  /** A tag with no gid cannot be attached to anything — dropped, not rendered. */
  it('drops a tag with no gid', async () => {
    hoistedLens.listWorkspaceTags.mockResolvedValue([
      { gid: 't-1', name: 'ok' },
      { name: 'ghost' },
      { gid: '', name: 'blank' },
    ])
    const res = await GET(req())
    expect(await res.json()).toEqual({ tags: [{ gid: 't-1', name: 'ok' }] })
  })

  it('falls back to the gid when a tag has no name', async () => {
    hoistedLens.listWorkspaceTags.mockResolvedValue([{ gid: 't-9' }])
    const res = await GET(req())
    expect(await res.json()).toEqual({ tags: [{ gid: 't-9', name: 't-9' }] })
  })

  it('returns an empty list rather than erroring for a workspace with no tags', async () => {
    hoistedLens.listWorkspaceTags.mockResolvedValue([])
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tags: [] })
  })
})
