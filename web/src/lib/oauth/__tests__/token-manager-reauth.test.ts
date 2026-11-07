import { randomBytes } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The "needs reconnect" flag (connected_account.reauth_required_at, migration
 * 348), driven through the public getValidTokenForAccount():
 *  - SET only on a definitive refresh failure: 400 / 401 from the token
 *    endpoint, or a revoked-grant error in the body (Atlassian's 403
 *    invalid_grant). Never on 5xx, a network error or a timeout.
 *  - CLEARED on a successful refresh.
 *  - A missing column (42703 / PGRST204) never breaks the refresh result or
 *    the token write.
 */

const NOW = new Date('2026-10-15T12:00:00.000Z')

type AccountWrite = {
  payload: Record<string, unknown>
  filters: Array<[string, string, unknown]>
}

const hoisted = vi.hoisted(() => ({
  fetch: vi.fn(),
  tokenRow: null as Record<string, unknown> | null,
  // What the token row's refresh_token holds when the flag path re-reads it.
  currentRefreshToken: null as string | null,
  tokenWrites: [] as Array<Record<string, unknown>>,
  accountWrites: [] as Array<{
    payload: Record<string, unknown>
    filters: Array<[string, string, unknown]>
  }>,
  // How a connected_account write resolves: an error, or a throw.
  accountWriteError: null as { code?: string; message: string } | null,
  accountWriteThrows: false,
}))

function makeSupabase() {
  return {
    from(table: string) {
      if (table === 'connected_account') {
        // getValidTokenForAccount's owner lookup: the token row's own user owns the account.
        const owner: Record<string, unknown> = {}
        owner.eq = () => owner
        owner.maybeSingle = () =>
          Promise.resolve({ data: hoisted.tokenRow ? { user_id: hoisted.tokenRow.user_id } : null, error: null })
        return {
          select: () => owner,
          update(payload: Record<string, unknown>) {
            if (hoisted.accountWriteThrows) throw new Error('boom')
            const write: AccountWrite = { payload, filters: [] }
            hoisted.accountWrites.push(write)
            const chain: Record<string, unknown> = {}
            chain.eq = (c: string, v: unknown) => (write.filters.push(['eq', c, v]), chain)
            chain.is = (c: string, v: unknown) => (write.filters.push(['is', c, v]), chain)
            chain.not = (c: string, op: string, v: unknown) => (
              write.filters.push(['not', c, `${op}:${String(v)}`]), chain
            )
            chain.then = (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: hoisted.accountWriteError }).then(resolve)
            return chain
          },
        }
      }
      // user_oauth_tokens
      const filters: Record<string, unknown> = {}
      const read: Record<string, unknown> = {}
      read.select = () => read
      read.eq = (c: string, v: unknown) => ((filters[c] = v), read)
      read.order = () =>
        Promise.resolve({ data: hoisted.tokenRow ? [hoisted.tokenRow] : [], error: null })
      read.maybeSingle = () =>
        Promise.resolve({
          data:
            hoisted.tokenRow && filters.refresh_token === hoisted.currentRefreshToken
              ? { id: hoisted.tokenRow.id }
              : null,
          error: null,
        })
      read.update = (payload: Record<string, unknown>) => {
        hoisted.tokenWrites.push(payload)
        const w: Record<string, unknown> = {}
        w.eq = () => w
        w.select = () => Promise.resolve({ data: [{ id: 'tok-1' }], error: null })
        return w
      }
      return read
    },
  }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => makeSupabase(),
}))

// Refreshed tokens are written encrypted (token-crypto.ts).
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64')

const { getValidTokenForAccount, isDefinitiveRefreshFailure, isMissingColumnError } =
  await import('../token-manager')
const { decryptOAuthToken } = await import('../token-crypto')

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tok-1',
    user_id: 'u-1',
    provider: 'google',
    capability: 'calendar',
    access_token: 'old-access',
    refresh_token: 'refresh-abc',
    token_type: 'Bearer',
    // Inside the 5-minute refresh buffer, so every call refreshes.
    expires_at: new Date(NOW.getTime() + 60 * 1000).toISOString(),
    scopes: [],
    email: 'user@example.com',
    account_id: 'acct-1',
    ...overrides,
  }
}

function failWith(status: number, body?: unknown) {
  hoisted.fetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => {
      if (body === undefined) throw new Error('not json')
      return body
    },
  })
}

function succeed(access = 'new-access') {
  hoisted.fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ access_token: access, expires_in: 3600 }),
  })
}

const SET_FILTERS = [
  ['eq', 'id', 'acct-1'],
  ['is', 'reauth_required_at', null],
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  hoisted.fetch.mockReset()
  hoisted.tokenRow = null
  hoisted.currentRefreshToken = 'refresh-abc'
  hoisted.tokenWrites = []
  hoisted.accountWrites = []
  hoisted.accountWriteError = null
  hoisted.accountWriteThrows = false
  vi.stubGlobal('fetch', hoisted.fetch)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const p of ['GOOGLE', 'MICROSOFT', 'HUBSPOT', 'ASANA', 'JIRA', 'LINEAR']) {
    process.env[`${p}_CLIENT_ID`] = 'id'
    process.env[`${p}_CLIENT_SECRET`] = 'secret'
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('reauth_required_at: set on a definitive refresh failure', () => {
  it.each([
    ['google', 400, { error: 'invalid_grant' }],
    ['microsoft', 400, undefined],
    ['hubspot', 400, { status: 'BAD_REFRESH_TOKEN' }],
    ['asana', 401, { error: 'invalid_client' }],
    ['linear', 400, { error: 'invalid_grant' }],
    ['jira', 403, { error: 'invalid_grant' }],
    ['google', 403, { error: 'unauthorized_client' }],
  ])('%s %i %j → flagged with now()', async (provider, status, body) => {
    hoisted.tokenRow = tokenRow({ provider })
    failWith(status, body)

    const result = await getValidTokenForAccount('acct-1')

    expect(result).toBeNull()
    expect(hoisted.tokenWrites).toHaveLength(0)
    expect(hoisted.accountWrites).toEqual([
      { payload: { reauth_required_at: NOW.toISOString() }, filters: SET_FILTERS },
    ])
  })

  it('skips the flag when the row no longer holds the refused refresh token (reconnect raced it)', async () => {
    hoisted.tokenRow = tokenRow()
    hoisted.currentRefreshToken = 'refresh-from-reconnect'
    failWith(400, { error: 'invalid_grant' })

    expect(await getValidTokenForAccount('acct-1')).toBeNull()
    expect(hoisted.accountWrites).toHaveLength(0)
  })

  it('skips the flag for a legacy token with no connected account', async () => {
    hoisted.tokenRow = tokenRow({ account_id: null })
    failWith(400, { error: 'invalid_grant' })

    expect(await getValidTokenForAccount('acct-1')).toBeNull()
    expect(hoisted.accountWrites).toHaveLength(0)
  })
})

describe('reauth_required_at: NOT set on a transient failure', () => {
  it.each([
    ['google', 500, { error: 'invalid_grant' }],
    ['microsoft', 502, undefined],
    ['jira', 503, { error: 'invalid_grant' }],
    ['hubspot', 403, { status: 'FORBIDDEN' }],
    ['linear', 429, { error: 'rate_limited' }],
  ])('%s %i %j → no flag', async (provider, status, body) => {
    hoisted.tokenRow = tokenRow({ provider })
    failWith(status, body)

    expect(await getValidTokenForAccount('acct-1')).toBeNull()
    expect(hoisted.accountWrites).toHaveLength(0)
  })

  it('a thrown network error → no flag', async () => {
    hoisted.tokenRow = tokenRow()
    hoisted.fetch.mockRejectedValueOnce(new TypeError('fetch failed'))

    expect(await getValidTokenForAccount('acct-1')).toBeNull()
    expect(hoisted.accountWrites).toHaveLength(0)
  })

  it('a timeout (AbortError) → no flag', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'jira' })
    hoisted.fetch.mockRejectedValueOnce(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    )

    expect(await getValidTokenForAccount('acct-1')).toBeNull()
    expect(hoisted.accountWrites).toHaveLength(0)
  })
})

describe('reauth_required_at: cleared on a successful refresh', () => {
  it('clears only a flagged row, after the token write', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'linear' })
    succeed('fresh-linear')

    const result = await getValidTokenForAccount('acct-1')

    expect(result).toEqual({ token: 'fresh-linear', email: 'user@example.com', accountId: 'acct-1' })
    expect(hoisted.tokenWrites).toHaveLength(1)
    expect(hoisted.tokenWrites[0]).not.toHaveProperty('reauth_required_at')
    expect(hoisted.accountWrites).toEqual([
      {
        payload: { reauth_required_at: null },
        filters: [
          ['eq', 'id', 'acct-1'],
          ['not', 'reauth_required_at', 'is:null'],
        ],
      },
    ])
  })
})

describe('reauth_required_at: the column may be absent (migration 348 not applied)', () => {
  it.each([
    [{ code: 'PGRST204', message: "Could not find the 'reauth_required_at' column of 'connected_account' in the schema cache" }],
    [{ code: '42703', message: 'column connected_account.reauth_required_at does not exist' }],
  ])('success still returns the token and saves it (%j)', async (err) => {
    hoisted.tokenRow = tokenRow()
    hoisted.accountWriteError = err
    succeed('still-works')

    const result = await getValidTokenForAccount('acct-1')

    expect(result).toEqual({ token: 'still-works', email: 'user@example.com', accountId: 'acct-1' })
    expect(hoisted.tokenWrites).toHaveLength(1)
    expect(decryptOAuthToken(hoisted.tokenWrites[0].access_token as string)).toBe('still-works')
  })

  it('a definitive failure still returns null cleanly', async () => {
    hoisted.tokenRow = tokenRow()
    hoisted.accountWriteError = { code: '42703', message: 'column does not exist' }
    failWith(400, { error: 'invalid_grant' })

    await expect(getValidTokenForAccount('acct-1')).resolves.toBeNull()
  })

  it('a flag write that THROWS is swallowed too', async () => {
    hoisted.tokenRow = tokenRow()
    hoisted.accountWriteThrows = true
    succeed('survives')

    const result = await getValidTokenForAccount('acct-1')

    expect(result?.token).toBe('survives')
    expect(hoisted.tokenWrites).toHaveLength(1)
  })
})

describe('isDefinitiveRefreshFailure', () => {
  it('400 / 401 are definitive regardless of body', () => {
    expect(isDefinitiveRefreshFailure(400, null)).toBe(true)
    expect(isDefinitiveRefreshFailure(401, 'invalid_client')).toBe(true)
  })
  it('a revoked-grant body is definitive on another 4xx', () => {
    expect(isDefinitiveRefreshFailure(403, 'invalid_grant')).toBe(true)
    expect(isDefinitiveRefreshFailure(403, null)).toBe(false)
    expect(isDefinitiveRefreshFailure(429, 'slow_down')).toBe(false)
  })
  it('5xx is never definitive', () => {
    expect(isDefinitiveRefreshFailure(500, 'invalid_grant')).toBe(false)
    expect(isDefinitiveRefreshFailure(503, null)).toBe(false)
  })
})

describe('isMissingColumnError', () => {
  it('matches 42703, PGRST204 and their messages; nothing else', () => {
    expect(isMissingColumnError({ code: '42703', message: '' })).toBe(true)
    expect(isMissingColumnError({ code: 'PGRST204', message: '' })).toBe(true)
    expect(isMissingColumnError({ message: 'column "x" does not exist' })).toBe(true)
    expect(isMissingColumnError({ code: '57014', message: 'statement timeout' })).toBe(false)
    expect(isMissingColumnError(null)).toBe(false)
  })
})
