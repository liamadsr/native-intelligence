/**
 * Tests for the three Linear destination-picker proxy routes:
 *   GET /api/account/linear/teams
 *   GET /api/account/linear/projects?teamId=<id>
 *   GET /api/account/linear/states?teamId=<id>
 *
 * Invariants locked in:
 *  - membership is required (requireWorkspaceMember short-circuits).
 *  - required query params are validated before any Linear call.
 *  - the teams route returns the ORGANIZATION too, because the save funnel
 *    persists `organization_id` and this is the only call that knows it.
 *  - the states route returns the DERIVED bucket map alongside the raw states,
 *    computed by the SAME lifecycle function the settings PATCH persists with —
 *    so what settings displays and what a push does cannot drift.
 *  - no connected Linear → 400 not_connected; unmintable token → 400
 *    reconnect_required; a 401 FROM Linear → 400 reconnect_required (never a
 *    bare 401, which would read as the caller's own session expiring).
 *
 * Note what has NO equivalent here: Jira's `cloudId` param and its
 * format-validation. Linear has one endpoint and a token belongs to exactly one
 * organization, so there is nothing to address a call to — and every id travels
 * as a GraphQL variable rather than into a URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => auth.result,
}))

const hoistedConfig = vi.hoisted(() => ({ loadLinearSyncState: vi.fn() }))
vi.mock('@/lib/tasks/linear-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadLinearSyncState: hoistedConfig.loadLinearSyncState }
})

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedApi = vi.hoisted(() => ({
  listTeams: vi.fn(),
  listTeamProjects: vi.fn(),
  listTeamStates: vi.fn(),
  getViewerAndOrg: vi.fn(),
}))
class FakeUnauthorized extends Error {
  readonly code = 'LINEAR_UNAUTHORIZED'
  readonly status = 401
  constructor() {
    super('401')
    this.name = 'LinearUnauthorizedError'
  }
}
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listTeams: hoistedApi.listTeams,
    listTeamProjects: hoistedApi.listTeamProjects,
    listTeamStates: hoistedApi.listTeamStates,
    getViewerAndOrg: hoistedApi.getViewerAndOrg,
    LinearUnauthorizedError: FakeUnauthorized,
  }
})

const { GET: getTeams } = await import('../teams/route')
const { GET: getProjects } = await import('../projects/route')
const { GET: getStates } = await import('../states/route')

function req(url: string): Request {
  return new Request(url)
}

const STATES = [
  { id: 's-triage', name: 'Triage', type: 'triage', position: 0 },
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 's-doing', name: 'In Progress', type: 'started', position: 2 },
  { id: 's-done', name: 'Done', type: 'completed', position: 3 },
  { id: 's-cancelled', name: 'Canceled', type: 'canceled', position: 4 },
]

beforeEach(() => {
  vi.clearAllMocks()
  auth.result = { workspaceId: 'ws-1', member: { id: 'm-1', role: 'member' } }
  hoistedConfig.loadLinearSyncState.mockResolvedValue({
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
  hoistedApi.listTeams.mockResolvedValue([{ id: 't-1', key: 'ENG', name: 'Engineering' }])
  hoistedApi.getViewerAndOrg.mockResolvedValue({
    viewer: { id: 'u-9', email: 'ada@example.com' },
    organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
  })
  hoistedApi.listTeamProjects.mockResolvedValue([{ id: 'p-1', name: 'Q3 Launch' }])
  hoistedApi.listTeamStates.mockResolvedValue(STATES)
})

// ---- teams -----------------------------------------------------------------

describe('GET /api/account/linear/teams', () => {
  it('returns the teams and the organization together', async () => {
    const res = await getTeams()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      teams: [{ id: 't-1', key: 'ENG', name: 'Engineering' }],
      organization: { id: 'org-1', name: 'Acme' },
    })
  })

  /**
   * The org travels with the teams because the destination save persists
   * `organization_id` for the webhook read-back's sanity check, and this is the
   * only call that knows it — a second round trip just to learn who we are
   * connected as would be pure latency.
   */
  it('resolves the organization in the SAME request as the teams', async () => {
    await getTeams()
    expect(hoistedApi.getViewerAndOrg).toHaveBeenCalledWith('tok')
    expect(hoistedApi.listTeams).toHaveBeenCalledWith('tok')
  })

  it('falls back to the key, then the id, for a team with no name', async () => {
    hoistedApi.listTeams.mockResolvedValue([
      { id: 't-1', key: 'ENG' },
      { id: 't-2' },
    ])
    const body = await (await getTeams()).json()
    expect(body.teams).toEqual([
      { id: 't-1', key: 'ENG', name: 'ENG' },
      { id: 't-2', key: null, name: 't-2' },
    ])
  })

  it('reports a null organization rather than failing when Linear omits it', async () => {
    hoistedApi.getViewerAndOrg.mockResolvedValue({ viewer: null, organization: null })
    const body = await (await getTeams()).json()
    expect(body.organization).toBeNull()
    expect(body.teams).toHaveLength(1)
  })

  it('short-circuits when the caller is not a workspace member', async () => {
    auth.result = new Response('nope', { status: 403 })
    expect((await getTeams()).status).toBe(403)
    expect(hoistedApi.listTeams).not.toHaveBeenCalled()
  })

  it('returns 400 not_connected when Linear is not connected', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue(null)
    const res = await getTeams()
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
    expect(hoistedApi.listTeams).not.toHaveBeenCalled()
  })

  it('returns 400 reconnect_required when no token can be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await getTeams()
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  /**
   * A 401 from LINEAR is not a 401 from us. Passing it through as a bare 401
   * would read to the client as the caller's own session expiring, and the fix
   * (reconnect the integration) would never be offered.
   */
  it('maps a 401 FROM Linear to 400 reconnect_required, never a bare 401', async () => {
    hoistedApi.listTeams.mockRejectedValue(new FakeUnauthorized())
    const res = await getTeams()
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('surfaces any other failure as a 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hoistedApi.listTeams.mockRejectedValue(new Error('boom'))
    expect((await getTeams()).status).toBe(500)
  })
})

// ---- projects --------------------------------------------------------------

describe('GET /api/account/linear/projects', () => {
  it('returns the team’s projects', async () => {
    const res = await getProjects(req('http://x/api/account/linear/projects?teamId=t-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projects: [{ id: 'p-1', name: 'Q3 Launch' }] })
    expect(hoistedApi.listTeamProjects).toHaveBeenCalledWith('tok', 't-1')
  })

  it('requires teamId BEFORE calling Linear', async () => {
    const res = await getProjects(req('http://x/api/account/linear/projects'))
    expect(res.status).toBe(400)
    expect(hoistedApi.listTeamProjects).not.toHaveBeenCalled()
  })

  it('rejects a whitespace-only teamId', async () => {
    const res = await getProjects(req('http://x/api/account/linear/projects?teamId=%20%20'))
    expect(res.status).toBe(400)
    expect(hoistedApi.listTeamProjects).not.toHaveBeenCalled()
  })

  it('returns an EMPTY list for a team with no projects — a valid destination', async () => {
    // Not an error state: a Linear issue may live directly under its team, so
    // "no projects" simply means the optional refinement isn't available.
    hoistedApi.listTeamProjects.mockResolvedValue([])
    const res = await getProjects(req('http://x/api/account/linear/projects?teamId=t-1'))
    expect(res.status).toBe(200)
    expect((await res.json()).projects).toEqual([])
  })

  it('maps a 401 FROM Linear to 400 reconnect_required', async () => {
    hoistedApi.listTeamProjects.mockRejectedValue(new FakeUnauthorized())
    const res = await getProjects(req('http://x/api/account/linear/projects?teamId=t-1'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })
})

// ---- states ----------------------------------------------------------------

describe('GET /api/account/linear/states', () => {
  it('returns the raw states with their type and position', async () => {
    const res = await getStates(req('http://x/api/account/linear/states?teamId=t-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.states).toEqual([
      { id: 's-triage', name: 'Triage', type: 'triage', position: 0 },
      { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
      { id: 's-doing', name: 'In Progress', type: 'started', position: 2 },
      { id: 's-done', name: 'Done', type: 'completed', position: 3 },
      { id: 's-cancelled', name: 'Canceled', type: 'canceled', position: 4 },
    ])
  })

  /**
   * The derived map is what makes a bucket→status picker unnecessary. Returning
   * it from the SAME function the settings PATCH persists with is what
   * guarantees the read-only mapping shown in settings is what a push actually
   * does.
   */
  it('returns the DERIVED bucket map alongside the states', async () => {
    const body = await (
      await getStates(req('http://x/api/account/linear/states?teamId=t-1'))
    ).json()

    expect(body.stateMap).toEqual({
      not_started: { id: 's-todo', name: 'Todo' },
      in_progress: { id: 's-doing', name: 'In Progress' },
      done: { id: 's-done', name: 'Done' },
      canceled: { id: 's-cancelled', name: 'Canceled' },
    })
  })

  /**
   * The empty bucket is the whole reason the UI needs this: it is where the
   * honest warning lives ("this team has no canceled state, so canceled actions
   * won't be echoed").
   */
  it('OMITS a bucket the team cannot express — the no-canceled-state team', async () => {
    hoistedApi.listTeamStates.mockResolvedValue(STATES.filter((s) => s.type !== 'canceled'))
    const body = await (
      await getStates(req('http://x/api/account/linear/states?teamId=t-1'))
    ).json()

    expect(body.stateMap).not.toHaveProperty('canceled')
    expect(body.stateMap.done).toEqual({ id: 's-done', name: 'Done' })
  })

  it('never derives a duplicate-type state as a write target', async () => {
    hoistedApi.listTeamStates.mockResolvedValue([
      ...STATES.filter((s) => s.type !== 'canceled'),
      { id: 's-dupe', name: 'Duplicate', type: 'duplicate', position: 5 },
    ])
    const body = await (
      await getStates(req('http://x/api/account/linear/states?teamId=t-1'))
    ).json()

    expect(body.stateMap).not.toHaveProperty('canceled')
    // …but the state is still LISTED, since it is a legitimate read signal.
    expect(body.states.some((s: { id: string }) => s.id === 's-dupe')).toBe(true)
  })

  it('reports a null type/position rather than dropping the field', async () => {
    hoistedApi.listTeamStates.mockResolvedValue([{ id: 's-x', name: 'Odd' }])
    const body = await (
      await getStates(req('http://x/api/account/linear/states?teamId=t-1'))
    ).json()
    expect(body.states).toEqual([{ id: 's-x', name: 'Odd', type: null, position: null }])
    expect(body.stateMap).toEqual({})
  })

  it('requires teamId BEFORE calling Linear', async () => {
    const res = await getStates(req('http://x/api/account/linear/states'))
    expect(res.status).toBe(400)
    expect(hoistedApi.listTeamStates).not.toHaveBeenCalled()
  })

  it('maps a 401 FROM Linear to 400 reconnect_required', async () => {
    hoistedApi.listTeamStates.mockRejectedValue(new FakeUnauthorized())
    const res = await getStates(req('http://x/api/account/linear/states?teamId=t-1'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('returns 400 not_connected when Linear is not connected', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue(null)
    const res = await getStates(req('http://x/api/account/linear/states?teamId=t-1'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
  })
})
