import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * REGRESSION: disconnecting a Jira account must unregister its webhooks.
 *
 * The disconnect route's teardown hook was a LITERAL `if (provider === 'asana')`
 * — a second provider was silently excluded from it. Deleting the
 * `connected_account` cascades `task_sync_state` away, taking the stored webhook
 * id with it, while the registration on Atlassian's side survives: it keeps
 * POSTing to a receiver that now resolves nothing, and it holds one of the five
 * slots Atlassian allows per app, per user, per site until it expires.
 *
 * It is strictly best-effort: nothing here may block, slow or fail a
 * disconnect, which is the second half of what these tests pin down.
 *
 * The whole chain runs for real — the route, the teardown helper and the config
 * reader — with only the Jira HTTP client, the token manager and the two
 * Supabase clients faked, so a break anywhere in it fails here.
 */

const hoisted = vi.hoisted(() => ({
  deleteWebhooks: vi.fn(),
  getValidTokenForAccount: vi.fn(),
  authenticateUser: vi.fn(),
  syncStateRows: [] as Array<{ webhook_gid: string | null; config: unknown }>,
  accountDeletes: [] as Array<Record<string, unknown>>,
  /** Provider on the stored account row; the disconnect helper keeps it in step with the URL. */
  accountProvider: 'jira',
}))

vi.mock('@/lib/ai/auth', () => ({ authenticateUser: hoisted.authenticateUser }))
vi.mock('@/lib/integrations/jira-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, deleteWebhooks: hoisted.deleteWebhooks }
})
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoisted.getValidTokenForAccount,
}))

/** The service client behind listJiraWebhookRegistrationsForAccount. */
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        not: () => api,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: hoisted.syncStateRows, error: null }).then(resolve),
      }
      return api
    },
  }),
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
            ? {
                // `provider` is what the route dispatches the teardown on — the
                // URL param is user-supplied and not trusted to match the row.
                data: {
                  id: 'acct-1',
                  is_primary: false,
                  capability: 'tasks',
                  provider: hoisted.accountProvider,
                },
                error: null,
              }
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
  // The stored row's provider matches the URL — the ordinary pairing. The
  // route dispatches on the ROW, so these must agree for the teardown to fire.
  hoisted.accountProvider = provider
  return POST(
    new Request(`http://x/api/oauth/${provider}/disconnect?account_id=${accountId}`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ provider }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.syncStateRows = [
    { webhook_gid: '6000', config: { cloud_id: 'cafe0001', project_id: '10000' } },
  ]
  hoisted.accountDeletes = []
  hoisted.authenticateUser.mockResolvedValue({ user: { id: 'u-1' } })
  hoisted.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoisted.deleteWebhooks.mockResolvedValue(undefined)
})

describe('POST /api/oauth/jira/disconnect — webhook teardown', () => {
  it('deletes the registered webhook before dropping the account', async () => {
    const res = await disconnect('jira')

    expect(res.status).toBe(200)
    // Addressed to the SITE the registration lives on, and numeric — the column
    // stores text because it is shared with Asana's string gids.
    expect(hoisted.deleteWebhooks).toHaveBeenCalledWith('tok', 'cafe0001', [6000])
    // The account really was disconnected too.
    expect(hoisted.accountDeletes).toEqual([{ id: 'acct-1', user_id: 'u-1' }])
  })

  it('uses the account token — which the cascade is about to revoke', async () => {
    await disconnect('jira')
    expect(hoisted.getValidTokenForAccount).toHaveBeenCalledWith('acct-1')
  })

  it('still disconnects when the webhook delete FAILS', async () => {
    hoisted.deleteWebhooks.mockRejectedValue(new Error('jira 500'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await disconnect('jira')

    expect(res.status).toBe(200)
    // No loop needed it (the shared disconnect switches off any that did).
    expect(await res.json()).toEqual({ success: true, loops_switched_off: [] })
    expect(hoisted.accountDeletes).toEqual([{ id: 'acct-1', user_id: 'u-1' }])
    warn.mockRestore()
  })

  it('still disconnects when the token lookup fails', async () => {
    hoisted.getValidTokenForAccount.mockRejectedValue(new Error('token store down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await disconnect('jira')

    expect(res.status).toBe(200)
    expect(hoisted.accountDeletes).toHaveLength(1)
    warn.mockRestore()
  })

  it('skips the Jira call when the account never registered a webhook', async () => {
    hoisted.syncStateRows = []
    await disconnect('jira')
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
    expect(hoisted.getValidTokenForAccount).not.toHaveBeenCalled()
  })

  it('skips a registration whose config lost its site rather than guessing one', async () => {
    // Nothing can be addressed without a cloudId; the registration expires
    // within 30 days on its own.
    hoisted.syncStateRows = [{ webhook_gid: '6000', config: {} }]
    await disconnect('jira')
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
  })

  it('does nothing Jira-side for a provider that isn’t jira', async () => {
    await disconnect('google')
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
    expect(hoisted.getValidTokenForAccount).not.toHaveBeenCalled()
  })
})
