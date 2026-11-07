import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Disconnecting a Linear account must REVOKE its token.
 *
 * The asana and jira branches of this route tear down a webhook REGISTRATION —
 * a per-account object living on the provider's side that outlives the cascade.
 * Linear has no such object: its webhooks are app-level (one URL and one signing
 * secret in the OAuth app console, auto-provisioned per authorizing
 * organization), so they end with the AUTHORIZATION rather than with anything we
 * own.
 *
 * That makes the revoke the whole teardown, and it does two things: it tells
 * Linear to stop delivering for this organization, and it kills an access token
 * that is otherwise valid for a full 24 hours after the user asked us to forget
 * them. A disconnect that skipped it would leave live credentials behind — a
 * longer window than either sibling leaves, since their tokens expire in an
 * hour.
 *
 * Strictly best-effort: nothing here may block, slow or fail a disconnect, which
 * is the second half of what these tests pin down.
 *
 * The whole chain runs for real — the route and revokeLinearTokenForAccount —
 * with only the Linear HTTP client, the token manager and the route's Supabase
 * client faked, so a break anywhere in it fails here.
 */

const hoisted = vi.hoisted(() => ({
  revokeToken: vi.fn(),
  getValidTokenForAccount: vi.fn(),
  authenticateUser: vi.fn(),
  accountDeletes: [] as Array<Record<string, unknown>>,
  tearDownAsana: vi.fn(),
  tearDownJira: vi.fn(),
  /** The stored row the account lookup returns — its `provider` is load-bearing. */
  account: {
    id: 'acct-1',
    is_primary: false,
    capability: 'tasks',
    provider: 'linear',
  } as Record<string, unknown> | null,
}))

vi.mock('@/lib/ai/auth', () => ({ authenticateUser: hoisted.authenticateUser }))
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, revokeToken: hoisted.revokeToken }
})
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoisted.getValidTokenForAccount,
}))
// The sibling teardowns are stubbed so the linear branch can be asserted to be
// the ONLY one that fires.
vi.mock('@/lib/tasks/asana-webhook', () => ({
  tearDownAsanaWebhooksForAccount: hoisted.tearDownAsana,
}))
vi.mock('@/lib/tasks/jira-webhook', () => ({
  tearDownJiraWebhooksForAccount: hoisted.tearDownJira,
}))

/** The route's own client: account lookup + the cascading delete. */
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {}
      const api: Record<string, unknown> = {
        select: () => api,
        delete: () => {
          hoisted.accountDeletes.push(filters)
          return api
        },
        update: () => api,
        eq: (col: string, val: unknown) => {
          filters[col] = val
          return api
        },
        order: () => api,
        limit: () => api,
        maybeSingle: async () =>
          table === 'connected_account'
            ? { data: hoisted.account, error: null }
            : { data: null, error: null },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve),
      }
      return api
    },
  }),
}))

const { POST } = await import('@/app/api/oauth/[provider]/disconnect/route')

function disconnect(provider: string, accountId = 'acct-1') {
  return POST(
    new Request(`http://x/api/oauth/${provider}/disconnect?account_id=${accountId}`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ provider }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.accountDeletes = []
  hoisted.account = { id: 'acct-1', is_primary: false, capability: 'tasks', provider: 'linear' }
  hoisted.authenticateUser.mockResolvedValue({ user: { id: 'u-1' } })
  hoisted.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoisted.revokeToken.mockResolvedValue(undefined)
})

describe('POST /api/oauth/linear/disconnect — token revoke', () => {
  it('revokes the token before dropping the account', async () => {
    const res = await disconnect('linear')

    expect(res.status).toBe(200)
    expect(hoisted.revokeToken).toHaveBeenCalledWith('tok')
    // The account really was disconnected too.
    expect(hoisted.accountDeletes).toEqual([{ id: 'acct-1', user_id: 'u-1' }])
  })

  it('uses the account token — which the cascade is about to delete', async () => {
    await disconnect('linear')
    expect(hoisted.getValidTokenForAccount).toHaveBeenCalledWith('acct-1')
  })

  it('still disconnects when the revoke FAILS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoisted.getValidTokenForAccount.mockRejectedValue(new Error('token store down'))

    const res = await disconnect('linear')

    expect(res.status).toBe(200)
    expect(hoisted.accountDeletes).toEqual([{ id: 'acct-1', user_id: 'u-1' }])
    expect(warn).toHaveBeenCalled()
  })

  it('still disconnects when no token can be minted — nothing left to revoke', async () => {
    hoisted.getValidTokenForAccount.mockResolvedValue(null)

    const res = await disconnect('linear')

    expect(res.status).toBe(200)
    expect(hoisted.revokeToken).not.toHaveBeenCalled()
    expect(hoisted.accountDeletes).toHaveLength(1)
  })

  /**
   * The teardown branches are per-provider on purpose — the CALL is genuinely
   * different for each (a gid delete, a site-addressed delete, a token revoke).
   * Firing the wrong one would be a silent no-op today and a real bug the moment
   * the branches diverge further.
   */
  it('does NOT run a webhook teardown — linear has no registration to delete', async () => {
    await disconnect('linear')
    expect(hoisted.tearDownAsana).not.toHaveBeenCalled()
    expect(hoisted.tearDownJira).not.toHaveBeenCalled()
  })

  it('does NOT revoke when disconnecting a DIFFERENT provider', async () => {
    hoisted.account = { id: 'acct-1', is_primary: false, capability: 'tasks', provider: 'jira' }
    await disconnect('jira')
    expect(hoisted.revokeToken).not.toHaveBeenCalled()
    expect(hoisted.tearDownJira).toHaveBeenCalledWith('acct-1')
  })

  it("NEVER sends another provider's token to Linear when the URL says linear", async () => {
    // The teardown branch must be chosen by the STORED row, not by the URL. The
    // account id is user-supplied, and the two are only correlated by the
    // caller's good behaviour: /api/oauth/linear/disconnect?account_id=<a Google
    // account> would otherwise mint — actively REFRESH — that account's live
    // token and POST it to api.linear.app, disclosing a third-party credential
    // to a service with no business seeing it, while never revoking it at its
    // real provider.
    //
    // The asana/jira branches are immune by accident (their teardowns load
    // provider-scoped webhook rows first and return early when there are none);
    // the linear branch transmits unconditionally, so it needs the real gate.
    hoisted.account = { id: 'acct-1', is_primary: false, capability: 'email', provider: 'google' }

    const res = await disconnect('linear')

    expect(hoisted.revokeToken).not.toHaveBeenCalled()
    expect(hoisted.getValidTokenForAccount).not.toHaveBeenCalled()
    // The disconnect itself still succeeds — this is a gate, not a rejection.
    expect(res.status).toBe(200)
    expect(hoisted.accountDeletes).toEqual([{ id: 'acct-1', user_id: 'u-1' }])
  })
})
