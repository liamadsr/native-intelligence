import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * REGRESSION: disconnecting an Asana account must unregister its webhooks.
 *
 * Deleting the `connected_account` cascades `task_sync_state` away, taking the
 * webhook gid and the signing secret with it — but the registration on Asana's
 * side survives, and Asana keeps POSTing deliveries to a receiver that can no
 * longer identify them. They 401 until Asana gives up 24 hours later.
 *
 * So the gids are read and deleted BEFORE the account row (and its token) go
 * away. It is strictly best-effort: nothing here may block, slow or fail a
 * disconnect, which is the second half of what these tests pin down.
 *
 * The whole chain runs for real — the route, the teardown helper and the config
 * reader — with only the Asana HTTP client, the token manager and the two
 * Supabase clients faked, so a break anywhere in it fails here.
 */

const hoisted = vi.hoisted(() => ({
  deleteWebhook: vi.fn(),
  getValidTokenForAccount: vi.fn(),
  authenticateUser: vi.fn(),
  syncStateRows: [] as Array<{ webhook_gid: string | null }>,
  accountDeletes: [] as Array<Record<string, unknown>>,
  /** Provider on the stored account row; the disconnect helper keeps it in step with the URL. */
  accountProvider: 'asana',
}))

vi.mock('@/lib/ai/auth', () => ({ authenticateUser: hoisted.authenticateUser }))
vi.mock('@/lib/integrations/asana-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, deleteWebhook: hoisted.deleteWebhook }
})
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoisted.getValidTokenForAccount,
}))

/** The service client behind listAsanaWebhookGidsForAccount. */
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
  hoisted.syncStateRows = [{ webhook_gid: 'wh-1' }]
  hoisted.accountDeletes = []
  hoisted.authenticateUser.mockResolvedValue({ user: { id: 'u-1' } })
  hoisted.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoisted.deleteWebhook.mockResolvedValue(undefined)
})

describe('POST /api/oauth/asana/disconnect — webhook teardown', () => {
  it('deletes the registered webhook before dropping the account', async () => {
    const res = await disconnect('asana')

    expect(res.status).toBe(200)
    expect(hoisted.deleteWebhook).toHaveBeenCalledWith('tok', 'wh-1')
    // The account really was disconnected too.
    expect(hoisted.accountDeletes).toEqual([{ id: 'acct-1', user_id: 'u-1' }])
  })

  it('uses the account token — which the cascade is about to revoke', async () => {
    await disconnect('asana')
    expect(hoisted.getValidTokenForAccount).toHaveBeenCalledWith('acct-1')
  })

  it('still disconnects when the webhook delete FAILS', async () => {
    // Asana down, scope revoked, whatever: the user asked to disconnect and a
    // tidy-up they can't see must never stand in the way. Asana drops the
    // orphan after 24h of 401'd deliveries regardless.
    hoisted.deleteWebhook.mockRejectedValue(new Error('asana 500'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await disconnect('asana')

    expect(res.status).toBe(200)
    // No loop needed it (the shared disconnect switches off any that did).
    expect(await res.json()).toEqual({ success: true, loops_switched_off: [] })
    expect(hoisted.accountDeletes).toEqual([{ id: 'acct-1', user_id: 'u-1' }])
    warn.mockRestore()
  })

  it('still disconnects when the sync-state read fails', async () => {
    hoisted.getValidTokenForAccount.mockRejectedValue(new Error('token store down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await disconnect('asana')

    expect(res.status).toBe(200)
    expect(hoisted.accountDeletes).toHaveLength(1)
    warn.mockRestore()
  })

  it('does nothing Asana-side for a non-asana provider', async () => {
    await disconnect('google')
    expect(hoisted.deleteWebhook).not.toHaveBeenCalled()
    expect(hoisted.getValidTokenForAccount).not.toHaveBeenCalled()
  })

  it('skips the Asana call when the account never registered a webhook', async () => {
    hoisted.syncStateRows = []
    await disconnect('asana')
    expect(hoisted.deleteWebhook).not.toHaveBeenCalled()
  })
})
