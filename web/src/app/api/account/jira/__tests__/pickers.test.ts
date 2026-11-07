/**
 * Tests for the four Jira destination-picker proxy routes:
 *   GET /api/account/jira/sites
 *   GET /api/account/jira/projects?cloudId=<id>&query=<optional>
 *   GET /api/account/jira/issue-types?cloudId=<id>&projectId=<id>
 *   GET /api/account/jira/statuses?cloudId=<id>&projectId=<id>
 *
 * Invariants locked in:
 *  - membership is required (requireWorkspaceMember short-circuits).
 *  - required query params are validated before any Jira call. Every route below
 *    `sites` needs a cloudId, because a 3LO app addresses the GATEWAY per site —
 *    there is no site-less Jira URL to fall back on.
 *  - subtask issue types are FILTERED OUT: a subtask create requires a `parent`
 *    and could never be a push target, so offering one builds a destination
 *    whose every push fails.
 *  - statuses are flattened and de-duplicated across issue types, carrying the
 *    statusCategory the echo falls back to.
 *  - no connected Jira → 400 not_connected; unmintable token → 400
 *    reconnect_required; a 401 FROM Jira → 400 reconnect_required (never a bare
 *    401, which would read as the caller's own session expiring).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => auth.result,
}))

const hoistedConfig = vi.hoisted(() => ({ loadJiraSyncState: vi.fn() }))
vi.mock('@/lib/tasks/jira-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadJiraSyncState: hoistedConfig.loadJiraSyncState }
})

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedApi = vi.hoisted(() => ({
  listAccessibleResources: vi.fn(),
  searchProjects: vi.fn(),
  listCreateMetaIssueTypes: vi.fn(),
  listProjectStatuses: vi.fn(),
}))
class FakeUnauthorized extends Error {
  readonly code = 'JIRA_UNAUTHORIZED'
  constructor() {
    super('401')
    this.name = 'JiraUnauthorizedError'
  }
}
vi.mock('@/lib/integrations/jira-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listAccessibleResources: hoistedApi.listAccessibleResources,
    searchProjects: hoistedApi.searchProjects,
    listCreateMetaIssueTypes: hoistedApi.listCreateMetaIssueTypes,
    listProjectStatuses: hoistedApi.listProjectStatuses,
    JiraUnauthorizedError: FakeUnauthorized,
  }
})

const { GET: getSites } = await import('../sites/route')
const { GET: getProjects } = await import('../projects/route')
const { GET: getIssueTypes } = await import('../issue-types/route')
const { GET: getStatuses } = await import('../statuses/route')

function req(url: string): Request {
  return new Request(url)
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.result = { workspaceId: 'ws-1', member: { id: 'm-1', role: 'member' } }
  hoistedConfig.loadJiraSyncState.mockResolvedValue({
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
  hoistedApi.listAccessibleResources.mockResolvedValue([
    { id: 'cafe0001', name: 'Acme', url: 'https://acme.atlassian.net', scopes: ['read:jira-work'] },
  ])
  hoistedApi.searchProjects.mockResolvedValue({
    projects: [{ id: '10000', key: 'ENG', name: 'Engineering' }],
    isLast: true,
    nextStartAt: null,
  })
  hoistedApi.listCreateMetaIssueTypes.mockResolvedValue([
    { id: '10001', name: 'Task', subtask: false },
  ])
  hoistedApi.listProjectStatuses.mockResolvedValue([
    {
      id: '10001',
      name: 'Task',
      statuses: [{ id: 's1', name: 'To Do', statusCategory: { key: 'new' } }],
    },
  ])
})

// ---- Sites -----------------------------------------------------------------

describe('GET /api/account/jira/sites', () => {
  it('returns every authorized Atlassian site (no cloudId needed — it MAKES one)', async () => {
    const res = await getSites()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sites: [{ id: 'cafe0001', name: 'Acme', url: 'https://acme.atlassian.net' }],
    })
    expect(hoistedApi.listAccessibleResources).toHaveBeenCalledWith('tok')
  })

  it('does not leak the token or the granted scopes to the browser', async () => {
    const body = await (await getSites()).json()
    expect(JSON.stringify(body)).not.toContain('tok')
    expect(JSON.stringify(body)).not.toContain('scopes')
  })

  it('short-circuits when requireWorkspaceMember returns a Response', async () => {
    auth.result = new Response('nope', { status: 403 })
    const res = await getSites()
    expect(res.status).toBe(403)
    expect(hoistedApi.listAccessibleResources).not.toHaveBeenCalled()
  })

  it('returns 400 not_connected when the workspace has no Jira row', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue(null)
    const res = await getSites()
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
    expect(hoistedApi.listAccessibleResources).not.toHaveBeenCalled()
  })

  it('returns 400 reconnect_required when the token cannot be minted', async () => {
    // For Jira this covers one more case than it does for Asana: Atlassian
    // rotates the refresh token on every use, so a lost rotation lands here.
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await getSites()
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('maps a 401 FROM Jira to 400 reconnect_required, not a bare 401', async () => {
    hoistedApi.listAccessibleResources.mockRejectedValue(new FakeUnauthorized())
    const res = await getSites()
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('surfaces any other Jira failure as a 500', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoistedApi.listAccessibleResources.mockRejectedValue(new Error('boom'))
    const res = await getSites()
    expect(res.status).toBe(500)
    errSpy.mockRestore()
  })
})

// ---- Projects --------------------------------------------------------------

describe('GET /api/account/jira/projects', () => {
  it('requires the cloudId query param — there is no site-less Jira URL', async () => {
    const res = await getProjects(req('http://x/api/account/jira/projects'))
    expect(res.status).toBe(400)
    expect(hoistedApi.searchProjects).not.toHaveBeenCalled()
  })

  it('lists the first page when no query is supplied', async () => {
    const res = await getProjects(req('http://x/api/account/jira/projects?cloudId=cafe0001'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      projects: [{ id: '10000', key: 'ENG', name: 'Engineering' }],
    })
    expect(hoistedApi.searchProjects).toHaveBeenCalledWith('tok', 'cafe0001', {
      query: undefined,
    })
  })

  it('passes the query through — ONE endpoint covers browse and search', async () => {
    // `project/search` matches name OR key, so unlike Asana there is no separate
    // typeahead call to switch to.
    await getProjects(req('http://x/api/account/jira/projects?cloudId=cafe0001&query=gro'))
    expect(hoistedApi.searchProjects).toHaveBeenCalledWith('tok', 'cafe0001', { query: 'gro' })
  })

  it('treats a whitespace-only query as no query', async () => {
    await getProjects(req('http://x/api/account/jira/projects?cloudId=cafe0001&query=%20%20'))
    expect(hoistedApi.searchProjects).toHaveBeenCalledWith('tok', 'cafe0001', {
      query: undefined,
    })
  })

  it('falls back to the key when a project has no name', async () => {
    hoistedApi.searchProjects.mockResolvedValue({
      projects: [{ id: '10000', key: 'ENG' }],
      isLast: true,
      nextStartAt: null,
    })
    const body = await (
      await getProjects(req('http://x/api/account/jira/projects?cloudId=cafe0001'))
    ).json()
    expect(body.projects[0].name).toBe('ENG')
  })

  it('maps a 401 FROM Jira to 400 reconnect_required', async () => {
    hoistedApi.searchProjects.mockRejectedValue(new FakeUnauthorized())
    const res = await getProjects(req('http://x/api/account/jira/projects?cloudId=cafe0001'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })
})

// ---- Issue types -----------------------------------------------------------

describe('GET /api/account/jira/issue-types', () => {
  it('requires BOTH the cloudId and the projectId', async () => {
    expect((await getIssueTypes(req('http://x/api/account/jira/issue-types'))).status).toBe(400)
    expect(
      (await getIssueTypes(req('http://x/api/account/jira/issue-types?cloudId=cafe0001'))).status,
    ).toBe(400)
    expect(hoistedApi.listCreateMetaIssueTypes).not.toHaveBeenCalled()
  })

  it('returns the project’s creatable issue types', async () => {
    const res = await getIssueTypes(
      req('http://x/api/account/jira/issue-types?cloudId=cafe0001&projectId=10000'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ issueTypes: [{ id: '10001', name: 'Task' }] })
    expect(hoistedApi.listCreateMetaIssueTypes).toHaveBeenCalledWith('tok', 'cafe0001', '10000')
  })

  it('FILTERS OUT subtasks — they need a parent and can never be a push target', async () => {
    hoistedApi.listCreateMetaIssueTypes.mockResolvedValue([
      { id: '10001', name: 'Task', subtask: false },
      { id: '10004', name: 'Sub-task', subtask: true },
      { id: '10005', name: 'Bug' },
    ])
    const body = await (
      await getIssueTypes(
        req('http://x/api/account/jira/issue-types?cloudId=cafe0001&projectId=10000'),
      )
    ).json()
    expect(body.issueTypes).toEqual([
      { id: '10001', name: 'Task' },
      { id: '10005', name: 'Bug' },
    ])
  })

  it('maps a 401 FROM Jira to 400 reconnect_required', async () => {
    hoistedApi.listCreateMetaIssueTypes.mockRejectedValue(new FakeUnauthorized())
    const res = await getIssueTypes(
      req('http://x/api/account/jira/issue-types?cloudId=cafe0001&projectId=10000'),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })
})

// ---- Statuses --------------------------------------------------------------

describe('GET /api/account/jira/statuses', () => {
  it('requires BOTH the cloudId and the projectId', async () => {
    expect((await getStatuses(req('http://x/api/account/jira/statuses'))).status).toBe(400)
    expect(
      (await getStatuses(req('http://x/api/account/jira/statuses?cloudId=cafe0001'))).status,
    ).toBe(400)
    expect(hoistedApi.listProjectStatuses).not.toHaveBeenCalled()
  })

  it('FLATTENS the per-issue-type groups and de-duplicates by status id', async () => {
    // A company-managed project gives each issue type its own workflow, so the
    // same status appears repeatedly; the mapping UI wants one list.
    hoistedApi.listProjectStatuses.mockResolvedValue([
      {
        id: '10001',
        name: 'Task',
        statuses: [
          { id: 's1', name: 'To Do', statusCategory: { key: 'new' } },
          { id: 's2', name: 'Done', statusCategory: { key: 'done' } },
        ],
      },
      {
        id: '10005',
        name: 'Bug',
        statuses: [
          { id: 's2', name: 'Done', statusCategory: { key: 'done' } },
          { id: 's3', name: 'Triage', statusCategory: { key: 'new' } },
        ],
      },
    ])

    const body = await (
      await getStatuses(req('http://x/api/account/jira/statuses?cloudId=cafe0001&projectId=10000'))
    ).json()

    expect(body.statuses).toEqual([
      { id: 's1', name: 'To Do', category: 'new' },
      { id: 's2', name: 'Done', category: 'done' },
      { id: 's3', name: 'Triage', category: 'new' },
    ])
  })

  it('carries the statusCategory the echo falls back to when a bucket is unmapped', async () => {
    const body = await (
      await getStatuses(req('http://x/api/account/jira/statuses?cloudId=cafe0001&projectId=10000'))
    ).json()
    expect(body.statuses[0]).toHaveProperty('category', 'new')
  })

  it('maps a 401 FROM Jira to 400 reconnect_required', async () => {
    hoistedApi.listProjectStatuses.mockRejectedValue(new FakeUnauthorized())
    const res = await getStatuses(
      req('http://x/api/account/jira/statuses?cloudId=cafe0001&projectId=10000'),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })
})

// ---- A malformed identifier is the CALLER's mistake -------------------------

/**
 * REGRESSION (review finding: "cloudId from a query param is interpolated
 * unencoded into the Atlassian gateway URL"). These routes take `cloudId`
 * straight from the query string behind nothing but workspace membership, and
 * the URL builder now refuses anything that isn't Atlassian-shaped. That refusal
 * has to reach the caller as a 400 — the catch-all would otherwise report the
 * caller's own bad input as a server error.
 */
describe('a rejected identifier surfaces as 400, not 500', () => {
  it('400s a cloudId the URL builder refuses', async () => {
    const { JiraInvalidIdentifierError } = await import('@/lib/integrations/jira-api')
    hoistedApi.searchProjects.mockRejectedValue(
      new JiraInvalidIdentifierError('cloudId', 'cafe0001/rest/api/3/filter/search?x='),
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await getProjects(
      req('http://x/api/account/jira/projects?cloudId=cafe0001%2Frest%2Fapi%2F3'),
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Invalid Jira cloudId')
    errSpy.mockRestore()
  })
})
