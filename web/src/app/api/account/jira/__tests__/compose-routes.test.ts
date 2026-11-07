/**
 * Tests for the two NEW Jira compose-option routes:
 *   GET /api/account/jira/compose-meta?cloudId=&projectId=&issueTypeId=
 *   GET /api/account/jira/assignable-users?cloudId=&projectKey=&query=
 *
 * Kept apart from pickers.test.ts, which covers the four DESTINATION pickers —
 * these two answer "what does THIS push need", not "where do all pushes go", and
 * compose-meta is the only route in the integration that classifies rather than
 * proxies.
 *
 * They share the picker vocabulary deliberately: `not_connected` /
 * `reconnect_required`, so the compose panel reuses the settings banners rather
 * than inventing a second set.
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
  listCreateMetaFields: vi.fn(),
  searchAssignableUsers: vi.fn(),
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
    listCreateMetaFields: hoistedApi.listCreateMetaFields,
    searchAssignableUsers: hoistedApi.searchAssignableUsers,
    JiraUnauthorizedError: FakeUnauthorized,
  }
})

const { GET: getComposeMeta } = await import('../compose-meta/route')
const { GET: getAssignableUsers } = await import('../assignable-users/route')
const { clearCreateMetaCache } = await import('@/lib/tasks/jira-compose-meta')

function req(url: string): Request {
  return new Request(url)
}

const META_URL =
  'http://x/api/account/jira/compose-meta?cloudId=cafe0001&projectId=10000&issueTypeId=10001'
const USERS_URL =
  'http://x/api/account/jira/assignable-users?cloudId=cafe0001&projectKey=ENG'

beforeEach(() => {
  vi.clearAllMocks()
  clearCreateMetaCache()
  auth.result = { workspaceId: 'ws-1', member: { id: 'm-1', role: 'member' } }
  hoistedConfig.loadJiraSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: { cloud_id: 'cafe0001', site_url: 'https://acme.atlassian.net' },
  })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.listCreateMetaFields.mockResolvedValue([
    { fieldId: 'summary', required: true },
    { fieldId: 'duedate', required: false },
    { fieldId: 'priority', allowedValues: [{ id: '3', name: 'Medium' }] },
  ])
  hoistedApi.searchAssignableUsers.mockResolvedValue([
    { accountId: 'a1', displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' },
  ])
})

// ---- compose-meta ----------------------------------------------------------

describe('GET /api/account/jira/compose-meta', () => {
  it('returns the CLASSIFIED meta, not the raw field list', async () => {
    const res = await getComposeMeta(req(META_URL))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta).toMatchObject({
      has_due_date: true,
      due_date_required: false,
      has_priority: true,
      priorities: [{ id: '3', name: 'Medium' }],
      blocking_fields: [],
    })
    // The raw envelope must not leak: the required-field wall is a server
    // contract, not a client-side opinion.
    expect(body.fields).toBeUndefined()
  })

  it('carries the native create-screen link for the wall', async () => {
    const body = await (await getComposeMeta(req(META_URL))).json()
    expect(body.native_create_url).toBe(
      'https://acme.atlassian.net/secure/CreateIssue.jspa?pid=10000&issuetype=10001',
    )
  })

  it('reports a blocking required custom field', async () => {
    hoistedApi.listCreateMetaFields.mockResolvedValue([
      { fieldId: 'customfield_10050', name: 'Epic Link', required: true, schema: { type: 'any' } },
    ])
    const body = await (await getComposeMeta(req(META_URL))).json()
    expect(body.meta.blocking_fields).toEqual([
      { field_id: 'customfield_10050', name: 'Epic Link', schema_type: 'any' },
    ])
  })

  it.each([
    ['cloudId', 'http://x/y?projectId=10000&issueTypeId=10001'],
    ['projectId', 'http://x/y?cloudId=cafe0001&issueTypeId=10001'],
    ['issueTypeId', 'http://x/y?cloudId=cafe0001&projectId=10000'],
  ])('400s a missing `%s` BEFORE any Jira call', async (_param, url) => {
    expect((await getComposeMeta(req(url))).status).toBe(400)
    expect(hoistedApi.listCreateMetaFields).not.toHaveBeenCalled()
  })

  // ---- caching -------------------------------------------------------------

  /**
   * A create screen changes when an admin edits it, i.e. roughly never, while
   * the panel re-reads it on every open — so the second read is free.
   */
  it('serves the SECOND identical read from cache', async () => {
    const first = await (await getComposeMeta(req(META_URL))).json()
    const second = await (await getComposeMeta(req(META_URL))).json()
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(hoistedApi.listCreateMetaFields).toHaveBeenCalledTimes(1)
    expect(second.meta).toEqual(first.meta)
  })

  it('does NOT share a cache entry across issue types', async () => {
    await getComposeMeta(req(META_URL))
    await getComposeMeta(req(META_URL.replace('issueTypeId=10001', 'issueTypeId=20001')))
    expect(hoistedApi.listCreateMetaFields).toHaveBeenCalledTimes(2)
  })

  it('does NOT share a cache entry across projects', async () => {
    await getComposeMeta(req(META_URL))
    await getComposeMeta(req(META_URL.replace('projectId=10000', 'projectId=20000')))
    expect(hoistedApi.listCreateMetaFields).toHaveBeenCalledTimes(2)
  })

  /**
   * createmeta is PERMISSION-FILTERED, so two workspaces reaching the same site
   * with different tokens see different screens — sharing an entry would leak
   * one workspace's fields into the other's panel.
   */
  it('does NOT share a cache entry across WORKSPACES', async () => {
    await getComposeMeta(req(META_URL))
    auth.result = { workspaceId: 'ws-2', member: { id: 'm-2', role: 'member' } }
    await getComposeMeta(req(META_URL))
    expect(hoistedApi.listCreateMetaFields).toHaveBeenCalledTimes(2)
  })

  // ---- vocabulary ----------------------------------------------------------

  it('400s `not_connected` when no Jira is connected', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue(null)
    const res = await getComposeMeta(req(META_URL))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
  })

  it('400s `reconnect_required` when the token cannot be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await getComposeMeta(req(META_URL))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  /** Never a bare 401 — that would read as the CALLER's own session expiring. */
  it('turns a 401 FROM Jira into 400 reconnect_required', async () => {
    hoistedApi.listCreateMetaFields.mockRejectedValue(new FakeUnauthorized())
    const res = await getComposeMeta(req(META_URL))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('requires workspace membership', async () => {
    auth.result = new Response('nope', { status: 403 })
    expect((await getComposeMeta(req(META_URL))).status).toBe(403)
    expect(hoistedApi.listCreateMetaFields).not.toHaveBeenCalled()
  })
})

// ---- assignable-users ------------------------------------------------------

describe('GET /api/account/jira/assignable-users', () => {
  it('returns accountId-keyed users with displayName rendering', async () => {
    const res = await getAssignableUsers(req(USERS_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      users: [
        {
          account_id: 'a1',
          display_name: 'Ada Lovelace',
          email: 'ada@example.com',
          active: true,
        },
      ],
    })
  })

  /**
   * Jira blanks emailAddress per the target user's privacy setting while
   * accountId stays populated — so a null email must survive as a null rather
   * than costing the user their row.
   */
  it('tolerates a blanked email', async () => {
    hoistedApi.searchAssignableUsers.mockResolvedValue([
      { accountId: 'a1', displayName: 'Ada' },
    ])
    const body = await (await getAssignableUsers(req(USERS_URL))).json()
    expect(body.users[0]).toMatchObject({ account_id: 'a1', email: null })
  })

  it('falls back to the accountId when there is no display name', async () => {
    hoistedApi.searchAssignableUsers.mockResolvedValue([{ accountId: 'a1' }])
    const body = await (await getAssignableUsers(req(USERS_URL))).json()
    expect(body.users[0].display_name).toBe('a1')
  })

  it('passes a query through, and omits it when absent', async () => {
    await getAssignableUsers(req(`${USERS_URL}&query=ada`))
    expect(hoistedApi.searchAssignableUsers).toHaveBeenCalledWith('tok', 'cafe0001', 'ENG', {
      query: 'ada',
    })

    hoistedApi.searchAssignableUsers.mockClear()
    await getAssignableUsers(req(USERS_URL))
    expect(hoistedApi.searchAssignableUsers).toHaveBeenCalledWith('tok', 'cafe0001', 'ENG', {})
  })

  it.each([
    ['cloudId', 'http://x/y?projectKey=ENG'],
    ['projectKey', 'http://x/y?cloudId=cafe0001'],
  ])('400s a missing `%s` BEFORE any Jira call', async (_param, url) => {
    expect((await getAssignableUsers(req(url))).status).toBe(400)
    expect(hoistedApi.searchAssignableUsers).not.toHaveBeenCalled()
  })

  it('400s `not_connected` when no Jira is connected', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue(null)
    expect((await (await getAssignableUsers(req(USERS_URL))).json()).code).toBe('not_connected')
  })

  it('turns a 401 FROM Jira into 400 reconnect_required', async () => {
    hoistedApi.searchAssignableUsers.mockRejectedValue(new FakeUnauthorized())
    const res = await getAssignableUsers(req(USERS_URL))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })
})
