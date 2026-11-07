import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Provider OAuth tokens encrypted at rest, end to end over one stateful fake
 * database: a connect stores them encrypted (complete-connect.ts), a read hands
 * the caller the plaintext (token-manager.ts), and a refresh spends the
 * decrypted refresh token and stores the rotated pair encrypted, compare-and-
 * swapped on the STORED value. A legacy plaintext row reads as is and leaves its
 * first refresh encrypted.
 */

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  fetch: vi.fn(),
}))

/**
 * Applies the filters and writes the code under test chains: select / insert /
 * update / upsert, eq / is / not('…', 'is', null), order, limit, single /
 * maybeSingle, a `{ count, head }` select, and `.select()` after a write
 * (which returns the rows it touched, so a lost compare-and-swap is visible).
 */
function fakeSupabase() {
  let seq = 0
  return {
    from(table: string) {
      const rows = () => (hoisted.tables[table] ??= [])
      const filters: Array<(r: Row) => boolean> = []
      let write: { kind: 'insert' | 'upsert'; values: Row[] } | { kind: 'update'; patch: Row } | null = null
      let max = Infinity
      let sort: { key: string; ascending: boolean } | null = null
      const matched = () => rows().filter((r) => filters.every((f) => f(r)))
      const run = async () => {
        if (write?.kind === 'insert' || write?.kind === 'upsert') {
          const added = write.values.map((v) => ({ id: `${table}-${++seq}`, ...v }))
          rows().push(...added)
          return { data: added, error: null, count: null }
        }
        if (write?.kind === 'update') {
          const hit = matched()
          for (const r of hit) Object.assign(r, write.patch)
          return { data: hit.map((r) => ({ id: r.id })), error: null, count: null }
        }
        let out = matched()
        if (sort) {
          const { key, ascending } = sort
          out = [...out].sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1))
        }
        return { data: out.slice(0, max), error: null, count: out.length }
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: (v: Row | Row[]) => ((write = { kind: 'insert', values: Array.isArray(v) ? v : [v] }), chain),
        upsert: (v: Row | Row[]) => ((write = { kind: 'upsert', values: Array.isArray(v) ? v : [v] }), chain),
        update: (patch: Row) => ((write = { kind: 'update', patch }), chain),
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
        is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
        not: (k: string, _op: 'is', v: unknown) => (filters.push((r) => (r[k] ?? null) !== v), chain),
        order: (key: string, opts?: { ascending?: boolean }) => ((sort = { key, ascending: opts?.ascending !== false }), chain),
        limit: (n: number) => ((max = n), chain),
        single: async () => {
          const { data } = await run()
          const row = (data as Row[])[0] ?? null
          return { data: row, error: row ? null : { message: 'no rows' } }
        },
        maybeSingle: async () => {
          const { data, error } = await run()
          return { data: (data as Row[])[0] ?? null, error }
        },
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
      }
      return chain
    },
  }
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeSupabase() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/email/gmail-watch', () => ({ setupGmailWatch: vi.fn() }))
vi.mock('@/lib/email/outlook-webhook', () => ({ setupOutlookSubscription: vi.fn() }))
vi.mock('@/lib/email/account-scope', () => ({ reconcileThreadCopies: vi.fn() }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

const { completeOAuthConnect } = await import('../complete-connect')
const { getValidTokenForAccount } = await import('../token-manager')
const { decryptOAuthToken, encryptOAuthToken, isEncryptedOAuthToken } = await import('../token-crypto')

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const tokenRow = () => hoisted.tables.user_oauth_tokens[0]
const sentRefreshToken = (call: number) =>
  new URLSearchParams(String((hoisted.fetch.mock.calls[call][1] as RequestInit).body)).get('refresh_token')

beforeEach(() => {
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
  vi.stubEnv('LINEAR_CLIENT_ID', 'l-id')
  vi.stubEnv('LINEAR_CLIENT_SECRET', 'l-secret')
  vi.stubEnv('GOOGLE_CLIENT_ID', 'g-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'g-secret')
  hoisted.tables = { member: [{ id: 'm-1', user_id: 'u-1', workspace_id: 'ws-1' }] }
  hoisted.fetch.mockReset()
  vi.stubGlobal('fetch', hoisted.fetch)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('connect → read → refresh, encrypted at rest', () => {
  it('stores the connect tokens encrypted and hands every reader the plaintext', async () => {
    hoisted.fetch
      // The code exchange.
      .mockResolvedValueOnce(json({ access_token: 'lin_oauth_access_1', refresh_token: 'lin_refresh_1', expires_in: 86400, scope: 'read write' }))
      // The identity lookup.
      .mockResolvedValueOnce(json({ data: { viewer: { email: 'me@example.com' } } }))

    const result = await completeOAuthConnect({ provider: 'linear', code: 'c', userId: 'u-1', capability: 'tasks', stateWorkspaceId: 'ws-1' })
    expect(result).toMatchObject({ ok: true })

    // At rest: ciphertext only.
    const stored = tokenRow()
    expect(isEncryptedOAuthToken(stored.access_token as string)).toBe(true)
    expect(isEncryptedOAuthToken(stored.refresh_token as string)).toBe(true)
    expect(JSON.stringify(hoisted.tables)).not.toContain('lin_oauth_access_1')
    expect(JSON.stringify(hoisted.tables)).not.toContain('lin_refresh_1')
    // The provider still saw the real token (the identity lookup).
    expect((hoisted.fetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer lin_oauth_access_1' })

    // Read back: the plaintext, no refresh (not near expiry).
    const read = await getValidTokenForAccount(stored.account_id as string)
    expect(read).toEqual({ token: 'lin_oauth_access_1', email: 'me@example.com', accountId: stored.account_id })
    expect(hoisted.fetch).toHaveBeenCalledTimes(2)
  })

  it('refreshes with the decrypted refresh token, stores the rotated pair encrypted, and CASes on the stored value', async () => {
    hoisted.fetch
      .mockResolvedValueOnce(json({ access_token: 'lin_oauth_access_1', refresh_token: 'lin_refresh_1', expires_in: 86400 }))
      .mockResolvedValueOnce(json({ data: { viewer: { email: 'me@example.com' } } }))
    await completeOAuthConnect({ provider: 'linear', code: 'c', userId: 'u-1', capability: 'tasks', stateWorkspaceId: 'ws-1' })
    const row = tokenRow()
    const storedBefore = row.refresh_token as string
    row.expires_at = new Date(Date.now() + 60 * 1000).toISOString() // inside the refresh buffer

    // Linear rotates: a new refresh token with every refresh.
    hoisted.fetch.mockResolvedValueOnce(json({ access_token: 'lin_oauth_access_2', refresh_token: 'lin_refresh_2', expires_in: 86400 }))
    const refreshed = await getValidTokenForAccount(row.account_id as string)

    expect(refreshed?.token).toBe('lin_oauth_access_2')
    expect(hoisted.fetch.mock.calls[2][0]).toBe('https://api.linear.app/oauth/token')
    expect(sentRefreshToken(2)).toBe('lin_refresh_1')
    // The CAS matched the stored ciphertext, so the write landed, encrypted.
    expect(row.refresh_token).not.toBe(storedBefore)
    expect(isEncryptedOAuthToken(row.access_token as string)).toBe(true)
    expect(isEncryptedOAuthToken(row.refresh_token as string)).toBe(true)
    expect(decryptOAuthToken(row.access_token as string)).toBe('lin_oauth_access_2')
    expect(decryptOAuthToken(row.refresh_token as string)).toBe('lin_refresh_2')

    // And the next read serves the new token without another refresh.
    expect((await getValidTokenForAccount(row.account_id as string))?.token).toBe('lin_oauth_access_2')
    expect(hoisted.fetch).toHaveBeenCalledTimes(3)
  })

  it('a reconnect over a legacy plaintext row rewrites it encrypted', async () => {
    hoisted.tables.connected_account = [{ id: 'acct-1', user_id: 'u-1', provider: 'linear', capability: 'tasks', account_email: 'me@example.com' }]
    hoisted.tables.user_oauth_tokens = [{
      id: 'tok-1', user_id: 'u-1', provider: 'linear', capability: 'tasks', account_id: 'acct-1',
      access_token: 'lin_oauth_legacy', refresh_token: 'lin_refresh_legacy', updated_at: '2026-10-01T00:00:00Z',
    }]
    hoisted.fetch
      .mockResolvedValueOnce(json({ access_token: 'lin_oauth_new', refresh_token: 'lin_refresh_new', expires_in: 86400 }))
      .mockResolvedValueOnce(json({ data: { viewer: { email: 'me@example.com' } } }))

    expect(await completeOAuthConnect({ provider: 'linear', code: 'c', userId: 'u-1', capability: 'tasks', stateWorkspaceId: 'ws-1' })).toMatchObject({ ok: true })

    expect(hoisted.tables.user_oauth_tokens).toHaveLength(1)
    expect(decryptOAuthToken(tokenRow().access_token as string)).toBe('lin_oauth_new')
    expect(decryptOAuthToken(tokenRow().refresh_token as string)).toBe('lin_refresh_new')
    expect(JSON.stringify(hoisted.tables)).not.toContain('lin_oauth_new')
  })

  it('fails the connect before writing anything when the key is missing', async () => {
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', '')
    vi.resetModules()
    const { completeOAuthConnect: connect } = await import('../complete-connect')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.fetch.mockResolvedValueOnce(json({ access_token: 'lin_oauth_access_1', refresh_token: 'lin_refresh_1', expires_in: 86400 }))

    expect(await connect({ provider: 'linear', code: 'c', userId: 'u-1', capability: 'tasks', stateWorkspaceId: 'ws-1' })).toEqual({ ok: false, error: 'server_error' })
    expect(hoisted.tables.connected_account ?? []).toHaveLength(0)
    expect(hoisted.tables.user_oauth_tokens ?? []).toHaveLength(0)
  })
})

describe('legacy plaintext rows', () => {
  function legacyGoogleRow(expiresAt: string) {
    hoisted.tables.connected_account = [{ id: 'acct-1', user_id: 'u-1', provider: 'google', capability: 'calendar', account_email: 'me@example.com' }]
    hoisted.tables.user_oauth_tokens = [{
      id: 'tok-1', user_id: 'u-1', provider: 'google', capability: 'calendar', account_id: 'acct-1',
      access_token: 'ya29.legacy-access', refresh_token: '1//legacy-refresh', token_type: 'Bearer',
      expires_at: expiresAt, scopes: [], email: 'me@example.com', updated_at: '2026-10-01T00:00:00Z',
    }]
  }

  it('reads a legacy access token as is', async () => {
    legacyGoogleRow(new Date(Date.now() + 60 * 60 * 1000).toISOString())
    expect((await getValidTokenForAccount('acct-1'))?.token).toBe('ya29.legacy-access')
    expect(hoisted.fetch).not.toHaveBeenCalled()
  })

  it('leaves its first refresh fully encrypted, even when the provider keeps the refresh token', async () => {
    legacyGoogleRow(new Date(Date.now() + 60 * 1000).toISOString())
    // Google does not rotate: no refresh_token in the response.
    hoisted.fetch.mockResolvedValueOnce(json({ access_token: 'ya29.fresh', expires_in: 3600 }))

    expect((await getValidTokenForAccount('acct-1'))?.token).toBe('ya29.fresh')
    expect(sentRefreshToken(0)).toBe('1//legacy-refresh')
    const row = tokenRow()
    expect(decryptOAuthToken(row.access_token as string)).toBe('ya29.fresh')
    expect(isEncryptedOAuthToken(row.refresh_token as string)).toBe(true)
    expect(decryptOAuthToken(row.refresh_token as string)).toBe('1//legacy-refresh')
  })

  it('keeps an already-encrypted refresh token as stored when the provider does not rotate', async () => {
    legacyGoogleRow(new Date(Date.now() + 60 * 1000).toISOString())
    const stored = encryptOAuthToken('1//kept-refresh')
    tokenRow().refresh_token = stored
    hoisted.fetch.mockResolvedValueOnce(json({ access_token: 'ya29.fresh', expires_in: 3600 }))

    await getValidTokenForAccount('acct-1')
    expect(sentRefreshToken(0)).toBe('1//kept-refresh')
    expect(tokenRow().refresh_token).toBe(stored)
  })
})

describe("getValidTokenForAccount: only the account owner's token row", () => {
  const FUTURE = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
  function ownerAccount() {
    hoisted.tables.connected_account = [
      { id: 'acct-owner', user_id: 'u-owner', provider: 'google', capability: 'email', account_email: 'owner@example.test' },
    ]
  }
  function row(overrides: Row): Row {
    return {
      provider: 'google', capability: 'email', token_type: 'Bearer', expires_at: FUTURE(), scopes: [],
      email: 'owner@example.test', updated_at: '2026-10-01T00:00:00Z', ...overrides,
    }
  }

  it("never uses a teammate's row that names the owner's account, even a newer one", async () => {
    ownerAccount()
    hoisted.tables.user_oauth_tokens = [
      row({ id: 'tok-owner', user_id: 'u-owner', account_id: 'acct-owner', access_token: encryptOAuthToken('ya29.owner') }),
      row({
        id: 'tok-planted', user_id: 'u-teammate', account_id: 'acct-owner', access_token: 'ya29.attacker',
        email: 'teammate@example.test', updated_at: '2099-01-01T00:00:00Z',
      }),
    ]
    expect(await getValidTokenForAccount('acct-owner')).toEqual({ token: 'ya29.owner', email: 'owner@example.test', accountId: 'acct-owner' })
  })

  it("returns nothing when the only row for the account is a teammate's", async () => {
    ownerAccount()
    hoisted.tables.user_oauth_tokens = [
      row({ id: 'tok-planted', user_id: 'u-teammate', account_id: 'acct-owner', access_token: 'ya29.attacker' }),
    ]
    expect(await getValidTokenForAccount('acct-owner')).toBeNull()
  })

  it('returns nothing for an account that does not exist', async () => {
    hoisted.tables.connected_account = []
    hoisted.tables.user_oauth_tokens = [
      row({ id: 'tok-orphan', user_id: 'u-owner', account_id: 'acct-gone', access_token: 'ya29.orphan' }),
    ]
    expect(await getValidTokenForAccount('acct-gone')).toBeNull()
  })
})
