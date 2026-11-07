/**
 * Tests for the three Asana destination-picker proxy routes:
 *   GET /api/account/asana/workspaces
 *   GET /api/account/asana/projects?workspace=<gid>&query=<optional>
 *   GET /api/account/asana/sections?project=<gid>
 *
 * Invariants locked in:
 *  - membership is required (requireWorkspaceMember short-circuits).
 *  - required query params are validated before any Asana call.
 *  - `query` picks the recency-ordered TYPEAHEAD; its absence picks the first
 *    page of the plain list.
 *  - no connected Asana → 400 not_connected; unmintable token → 400
 *    reconnect_required; a 401 FROM Asana → 400 reconnect_required (never a
 *    bare 401, which would read as the caller's own session expiring).
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
  listWorkspaces: vi.fn(),
  listProjects: vi.fn(),
  typeaheadProjects: vi.fn(),
  listSections: vi.fn(),
}))
class FakeUnauthorized extends Error {
  readonly code = 'ASANA_UNAUTHORIZED'
  constructor() {
    super('401')
    this.name = 'AsanaUnauthorizedError'
  }
}
vi.mock('@/lib/integrations/asana-api', () => ({
  listWorkspaces: hoistedApi.listWorkspaces,
  listProjects: hoistedApi.listProjects,
  typeaheadProjects: hoistedApi.typeaheadProjects,
  listSections: hoistedApi.listSections,
  AsanaUnauthorizedError: FakeUnauthorized,
}))

const { GET: getWorkspaces } = await import('../workspaces/route')
const { GET: getProjects } = await import('../projects/route')
const { GET: getSections } = await import('../sections/route')

function req(url: string): Request {
  return new Request(url)
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
  hoistedApi.listWorkspaces.mockResolvedValue([{ gid: 'aw-1', name: 'Acme' }])
  hoistedApi.listProjects.mockResolvedValue({
    projects: [{ gid: 'p1', name: 'Engineering' }],
    nextOffset: null,
  })
  hoistedApi.typeaheadProjects.mockResolvedValue([{ gid: 'p9', name: 'Growth' }])
  hoistedApi.listSections.mockResolvedValue([{ gid: 's1', name: 'To do' }])
})

describe('GET /api/account/asana/workspaces', () => {
  it('returns the connected account\'s Asana workspaces', async () => {
    const res = await getWorkspaces()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspaces: [{ gid: 'aw-1', name: 'Acme' }] })
    expect(hoistedApi.listWorkspaces).toHaveBeenCalledWith('tok')
  })

  it('short-circuits when requireWorkspaceMember returns a Response', async () => {
    auth.result = new Response('nope', { status: 403 })
    const res = await getWorkspaces()
    expect(res.status).toBe(403)
    expect(hoistedApi.listWorkspaces).not.toHaveBeenCalled()
  })

  it('returns 400 not_connected when the workspace has no Asana row', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue(null)
    const res = await getWorkspaces()
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
    expect(hoistedApi.listWorkspaces).not.toHaveBeenCalled()
  })

  it('returns 400 reconnect_required when the token cannot be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await getWorkspaces()
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('maps a 401 FROM Asana to 400 reconnect_required, not a bare 401', async () => {
    hoistedApi.listWorkspaces.mockRejectedValue(new FakeUnauthorized())
    const res = await getWorkspaces()
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('surfaces any other Asana failure as a 500', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoistedApi.listWorkspaces.mockRejectedValue(new Error('boom'))
    const res = await getWorkspaces()
    expect(res.status).toBe(500)
    errSpy.mockRestore()
  })
})

describe('GET /api/account/asana/projects', () => {
  it('requires the workspace query param', async () => {
    const res = await getProjects(req('http://x/api/account/asana/projects'))
    expect(res.status).toBe(400)
    expect(hoistedApi.listProjects).not.toHaveBeenCalled()
    expect(hoistedApi.typeaheadProjects).not.toHaveBeenCalled()
  })

  it('lists the first page when no query is supplied', async () => {
    const res = await getProjects(req('http://x/api/account/asana/projects?workspace=aw-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projects: [{ gid: 'p1', name: 'Engineering' }] })
    expect(hoistedApi.listProjects).toHaveBeenCalledWith('tok', 'aw-1')
    expect(hoistedApi.typeaheadProjects).not.toHaveBeenCalled()
  })

  it('uses the recency-ordered typeahead when a query IS supplied', async () => {
    const res = await getProjects(
      req('http://x/api/account/asana/projects?workspace=aw-1&query=gro'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projects: [{ gid: 'p9', name: 'Growth' }] })
    expect(hoistedApi.typeaheadProjects).toHaveBeenCalledWith('tok', 'aw-1', 'gro')
    expect(hoistedApi.listProjects).not.toHaveBeenCalled()
  })

  it('treats a whitespace-only query as no query', async () => {
    await getProjects(req('http://x/api/account/asana/projects?workspace=aw-1&query=%20%20'))
    expect(hoistedApi.listProjects).toHaveBeenCalled()
    expect(hoistedApi.typeaheadProjects).not.toHaveBeenCalled()
  })

  it('maps a 401 FROM Asana to 400 reconnect_required', async () => {
    hoistedApi.listProjects.mockRejectedValue(new FakeUnauthorized())
    const res = await getProjects(req('http://x/api/account/asana/projects?workspace=aw-1'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })
})

describe('GET /api/account/asana/sections', () => {
  it('requires the project query param', async () => {
    const res = await getSections(req('http://x/api/account/asana/sections'))
    expect(res.status).toBe(400)
    expect(hoistedApi.listSections).not.toHaveBeenCalled()
  })

  it('returns the project sections', async () => {
    const res = await getSections(req('http://x/api/account/asana/sections?project=p1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sections: [{ gid: 's1', name: 'To do' }] })
    expect(hoistedApi.listSections).toHaveBeenCalledWith('tok', 'p1')
  })

  it('maps a 401 FROM Asana to 400 reconnect_required', async () => {
    hoistedApi.listSections.mockRejectedValue(new FakeUnauthorized())
    const res = await getSections(req('http://x/api/account/asana/sections?project=p1'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })
})
