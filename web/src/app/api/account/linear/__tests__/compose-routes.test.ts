/**
 * Tests for the two NEW Linear compose-option routes:
 *   GET /api/account/linear/members?teamId=<optional>&query=<optional>
 *   GET /api/account/linear/labels?teamId=<id>
 *
 * The asymmetry between them is deliberate and is what these tests pin:
 * `teamId` is OPTIONAL for members (the panel opens before a team is
 * necessarily chosen, and a workspace-wide list beats an empty one) and
 * REQUIRED for labels (label scope is a fact about a team, and offering a label
 * that cannot be applied is worse than offering none).
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
  listAssignableUsers: vi.fn(),
  listTeamLabels: vi.fn(),
}))
class FakeUnauthorized extends Error {
  constructor() {
    super('401')
    this.name = 'LinearUnauthorizedError'
  }
}
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listAssignableUsers: hoistedApi.listAssignableUsers,
    listTeamLabels: hoistedApi.listTeamLabels,
    LinearUnauthorizedError: FakeUnauthorized,
  }
})

const { GET: getMembers } = await import('../members/route')
const { GET: getLabels } = await import('../labels/route')

function req(url: string): Request {
  return new Request(url)
}

const MEMBERS_URL = 'http://x/api/account/linear/members?teamId=team-1'
const LABELS_URL = 'http://x/api/account/linear/labels?teamId=team-1'

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
  hoistedApi.listAssignableUsers.mockResolvedValue([
    {
      id: 'u1',
      name: 'Ada Lovelace',
      displayName: 'ada',
      email: 'ada@example.com',
      avatarUrl: 'https://cdn/x.png',
    },
  ])
  hoistedApi.listTeamLabels.mockResolvedValue([
    { id: 'l1', name: 'bug', color: '#f00', team: { id: 'team-1' } },
    { id: 'l2', name: 'urgent', color: null, team: null },
  ])
})

// ---- members ---------------------------------------------------------------

describe('GET /api/account/linear/members', () => {
  it('returns id-keyed members rendered by displayName', async () => {
    const res = await getMembers(req(MEMBERS_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      members: [
        {
          id: 'u1',
          name: 'ada',
          full_name: 'Ada Lovelace',
          email: 'ada@example.com',
          avatar_url: 'https://cdn/x.png',
        },
      ],
    })
  })

  /** `displayName` is the nickname; `name` is the better fallback without one. */
  it('falls back to `name` then the id when there is no displayName', async () => {
    hoistedApi.listAssignableUsers.mockResolvedValue([
      { id: 'u1', name: 'Ada Lovelace' },
      { id: 'u2' },
    ])
    const body = await (await getMembers(req(MEMBERS_URL))).json()
    expect(body.members.map((m: { name: string }) => m.name)).toEqual(['Ada Lovelace', 'u2'])
  })

  it('threads teamId and query into the transport', async () => {
    await getMembers(req(`${MEMBERS_URL}&query=ada`))
    expect(hoistedApi.listAssignableUsers).toHaveBeenCalledWith('tok', {
      teamId: 'team-1',
      query: 'ada',
    })
  })

  /**
   * OPTIONAL by design: the panel opens before a team is necessarily chosen,
   * and a workspace-wide list at that moment beats an empty one.
   */
  it('works with NO teamId at all', async () => {
    const res = await getMembers(req('http://x/api/account/linear/members'))
    expect(res.status).toBe(200)
    expect(hoistedApi.listAssignableUsers).toHaveBeenCalledWith('tok', {})
  })

  it('400s `not_connected` when no Linear is connected', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue(null)
    const res = await getMembers(req(MEMBERS_URL))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
  })

  it('400s `reconnect_required` when the token cannot be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    expect((await (await getMembers(req(MEMBERS_URL))).json()).code).toBe('reconnect_required')
  })

  it('turns a rejected token FROM Linear into 400 reconnect_required', async () => {
    hoistedApi.listAssignableUsers.mockRejectedValue(new FakeUnauthorized())
    const res = await getMembers(req(MEMBERS_URL))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('requires workspace membership', async () => {
    auth.result = new Response('nope', { status: 403 })
    expect((await getMembers(req(MEMBERS_URL))).status).toBe(403)
    expect(hoistedApi.listAssignableUsers).not.toHaveBeenCalled()
  })
})

// ---- labels ----------------------------------------------------------------

describe('GET /api/account/linear/labels', () => {
  /**
   * Team-scoped and workspace-scoped labels come back together (Linear models
   * the difference as a nullable `team`), and `scope` is what lets the panel
   * show which are shared without a second call.
   */
  it('returns team AND workspace labels, tagged by scope', async () => {
    const res = await getLabels(req(LABELS_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      labels: [
        { id: 'l1', name: 'bug', color: '#f00', scope: 'team' },
        { id: 'l2', name: 'urgent', color: null, scope: 'workspace' },
      ],
    })
  })

  /**
   * The isGroup exclusion lives in the transport, so this route asserts only
   * that it does not RE-introduce groups — nothing here filters, by design.
   */
  it('delegates the isGroup exclusion to the transport', async () => {
    await getLabels(req(LABELS_URL))
    expect(hoistedApi.listTeamLabels).toHaveBeenCalledWith('tok', 'team-1')
  })

  it('falls back to the id when a label has no name', async () => {
    hoistedApi.listTeamLabels.mockResolvedValue([{ id: 'l1' }])
    const body = await (await getLabels(req(LABELS_URL))).json()
    expect(body.labels[0]).toEqual({ id: 'l1', name: 'l1', color: null, scope: 'workspace' })
  })

  /**
   * REQUIRED here, unlike members: label scope is a fact about a team, and a
   * workspace-wide list would offer labels the composed issue cannot carry.
   */
  it('400s a missing `teamId` BEFORE any Linear call', async () => {
    expect((await getLabels(req('http://x/api/account/linear/labels'))).status).toBe(400)
    expect(hoistedApi.listTeamLabels).not.toHaveBeenCalled()
  })

  it('400s `not_connected` when no Linear is connected', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue(null)
    expect((await (await getLabels(req(LABELS_URL))).json()).code).toBe('not_connected')
  })

  it('turns a rejected token FROM Linear into 400 reconnect_required', async () => {
    hoistedApi.listTeamLabels.mockRejectedValue(new FakeUnauthorized())
    const res = await getLabels(req(LABELS_URL))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('requires workspace membership', async () => {
    auth.result = new Response('nope', { status: 403 })
    expect((await getLabels(req(LABELS_URL))).status).toBe(403)
    expect(hoistedApi.listTeamLabels).not.toHaveBeenCalled()
  })
})
