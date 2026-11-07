import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for syncContactsFromProvider — the email-derived contact pull.
 *
 * Invariant locked in (the cross-workspace contact-leak fix): the pull is
 * scoped to the email accounts actually linked to the target workspace. It
 * returns zeros without touching any provider API when the workspace has no
 * linked accounts, and it only calls the API for providers among the linked
 * accounts (a Microsoft-only workspace never hits Gmail, and vice versa).
 */

const hoisted = vi.hoisted(() => ({
  getWorkspaceEmailAccountIds: vi.fn(),
  getValidTokenForAccount: vi.fn(),
  shouldAutoCreateContact: vi.fn(() => ({ create: true })),
}))

vi.mock('@/lib/email/account-scope', () => ({
  getWorkspaceEmailAccountIds: hoisted.getWorkspaceEmailAccountIds,
}))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoisted.getValidTokenForAccount,
}))
vi.mock('@/lib/crm/contact-noise-filter', () => ({
  shouldAutoCreateContact: hoisted.shouldAutoCreateContact,
}))

// getServiceClient returns a per-test fake resolving the provider lookup +
// member/company/contact reads.
let dbFake: unknown = null
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => dbFake,
}))

const { syncContactsFromProvider } = await import('@/lib/crm/contacts')

/**
 * Fake honoring the query shapes syncContactsFromProvider issues:
 *   connected_account: .select('id, provider').in('id', ids) → thenable
 *   member:            .select('id').eq(..).eq(..).single()
 * company/contact reads only fire on the (unused here) ingestion path.
 */
function makeDb(linkedAccounts: Array<{ id: string; provider: string }>) {
  function caBuilder() {
    const api: Record<string, unknown> = {
      select: () => api,
      in: () => api,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: linkedAccounts, error: null }).then(resolve),
    }
    return api
  }
  function memberBuilder() {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      single: async () => ({ data: { id: 'member-1' }, error: null }),
    }
    return api
  }
  function generic() {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      in: () => api,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    }
    return api
  }
  return {
    from: (table: string) => {
      if (table === 'connected_account') return caBuilder()
      if (table === 'member') return memberBuilder()
      return generic()
    },
  }
}

// Provider API stub: Gmail's message-list and Graph's message-list both return
// an empty set, so the fetchers return [] quickly. We only assert WHICH host was
// contacted, proving provider gating.
function stubFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('gmail.googleapis.com')) {
      return { ok: true, json: async () => ({ messages: [] }) } as unknown as Response
    }
    if (typeof url === 'string' && url.includes('graph.microsoft.com')) {
      return { ok: true, json: async () => ({ value: [] }) } as unknown as Response
    }
    return { ok: false, json: async () => ({}) } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  dbFake = null
  hoisted.getWorkspaceEmailAccountIds.mockReset()
  hoisted.getValidTokenForAccount.mockReset()
  hoisted.getValidTokenForAccount.mockImplementation(async (id: string) => ({
    token: `tok-${id}`,
    email: null,
    accountId: id,
  }))
  hoisted.shouldAutoCreateContact.mockReset()
  hoisted.shouldAutoCreateContact.mockReturnValue({ create: true })
})

describe('syncContactsFromProvider — workspace scoping', () => {
  it('returns zeros and touches no provider API when no accounts are linked', async () => {
    hoisted.getWorkspaceEmailAccountIds.mockResolvedValue([])
    dbFake = makeDb([])
    const fetchMock = stubFetch()

    const result = await syncContactsFromProvider('user-1', 'ws-empty')

    expect(result).toEqual({ synced: 0, companies_created: 0 })
    expect(hoisted.getValidTokenForAccount).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns zeros when the linked-account lookup comes back empty', async () => {
    // getWorkspaceEmailAccountIds returned ids, but the connected_account read
    // resolves to nothing (e.g. rows vanished) — still no provider calls.
    hoisted.getWorkspaceEmailAccountIds.mockResolvedValue(['a1'])
    dbFake = makeDb([])
    const fetchMock = stubFetch()

    const result = await syncContactsFromProvider('user-1', 'ws-1')

    expect(result).toEqual({ synced: 0, companies_created: 0 })
    expect(hoisted.getValidTokenForAccount).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('only hits Gmail when the workspace is linked to a Google account', async () => {
    hoisted.getWorkspaceEmailAccountIds.mockResolvedValue(['g1'])
    dbFake = makeDb([{ id: 'g1', provider: 'google' }])
    const fetchMock = stubFetch()

    await syncContactsFromProvider('user-1', 'ws-1')

    expect(hoisted.getValidTokenForAccount).toHaveBeenCalledWith('g1')
    const hosts = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(hosts.some((u) => u.includes('gmail.googleapis.com'))).toBe(true)
    expect(hosts.some((u) => u.includes('graph.microsoft.com'))).toBe(false)
  })

  it('only hits Microsoft Graph when the workspace is linked to a Microsoft account', async () => {
    hoisted.getWorkspaceEmailAccountIds.mockResolvedValue(['m1'])
    dbFake = makeDb([{ id: 'm1', provider: 'microsoft' }])
    const fetchMock = stubFetch()

    await syncContactsFromProvider('user-1', 'ws-1')

    expect(hoisted.getValidTokenForAccount).toHaveBeenCalledWith('m1')
    const hosts = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(hosts.some((u) => u.includes('graph.microsoft.com'))).toBe(true)
    expect(hosts.some((u) => u.includes('gmail.googleapis.com'))).toBe(false)
  })
})
