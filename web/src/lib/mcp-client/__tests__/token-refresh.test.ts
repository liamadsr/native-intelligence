/**
 * GEN-1171: an OAuth MCP server's token is refreshed from the STORED row,
 * under a lease, once per server at a time; saved compare-and-swap; a refusal
 * for good marks it needs-reconnect (once, telling the person once); a refusal
 * for now leaves the status alone; and a marked server fails at once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TokenRefreshError } from '@/lib/oauth/token-manager'
import type { ConnectedMcpServerRow } from '../types'

vi.mock('@/lib/crypto/credentials', () => ({
  decryptCredential: (v: string) => `plain:${v}`,
  decryptCredentialOrNull: (v: string | null | undefined) => (v ? `plain:${v}` : null),
  encryptCredential: (v: string) => `enc:${v}`,
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => {
    throw new Error('tests pass their own client')
  },
}))
vi.mock('../url-guard-dns', () => ({ ensurePublicMcpUrl: async (raw: string) => new URL(raw) }))

const { ensureFreshAccessToken, McpTokenExpiredError, McpTokenRefreshUnavailableError, _resetTokenRefreshForTests } = await import('../token-refresh')

type Row = Record<string, unknown>
const ID = '11111111-1111-4111-8111-111111111111'
const NOW = Date.parse('2026-10-27T12:00:00Z')

/**
 * One table, its filters applied: eq, is, not-is-null, lt, the lease's or(),
 * and update(...).select() returning the rows it changed. `columns: false`
 * answers any touch of a 450 column as Postgres does before the migration.
 */
function fakeDb(table: object[], opts: { columns?: boolean } = {}) {
  const rows = table as Row[]
  const writes: Array<{ payload: Row; matched: number }> = []
  const missing = (payload: Row | null) =>
    opts.columns === false && payload && ('reauth_required_at' in payload || 'refresh_lease_until' in payload)
  const from = () => {
    const filters: Array<(r: Row) => boolean> = []
    let payload: Row | null = null
    let orFilter: string | null = null
    const run = async () => {
      if (missing(payload) || (opts.columns === false && orFilter)) {
        return { data: null, error: { code: '42703', message: 'column connected_mcp_server.reauth_required_at does not exist' } }
      }
      let hit = rows.filter((r) => filters.every((f) => f(r)))
      if (orFilter) {
        const m = /refresh_lease_until\.is\.null,refresh_lease_until\.lt\.(.+)$/.exec(orFilter)
        const cutoff = m ? Date.parse(m[1]) : NaN
        hit = hit.filter((r) => r.refresh_lease_until == null || Date.parse(String(r.refresh_lease_until)) < cutoff)
      }
      if (payload) {
        for (const r of hit) Object.assign(r, payload)
        writes.push({ payload, matched: hit.length })
      }
      return { data: hit.map((r) => ({ ...r })), error: null }
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (p: Row) => ((payload = p), chain),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
      not: (k: string, _op: string, v: unknown) => (filters.push((r) => (r[k] ?? null) !== v), chain),
      lt: (k: string, v: string) => (filters.push((r) => typeof r[k] === 'string' && Date.parse(String(r[k])) < Date.parse(v)), chain),
      or: (expr: string) => ((orFilter = expr), chain),
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }
  return { client: { from } as never, writes }
}

function serverRow(over: Partial<ConnectedMcpServerRow> = {}): ConnectedMcpServerRow {
  return {
    id: ID,
    user_id: 'u1',
    workspace_id: 'w1',
    display_name: 'Supabase',
    server_url: 'https://mcp.supabase.com/mcp',
    transport: 'streamable_http',
    auth_type: 'oauth2',
    access_token_encrypted: 'a0',
    refresh_token_encrypted: 'r0',
    token_expires_at: new Date(NOW - 60_000).toISOString(),
    oauth_metadata: { token_endpoint: 'https://api.supabase.com/v1/oauth/token', client_id: 'c1' },
    is_enabled: true,
    disabled_tools: [],
    require_approval_tools: [],
    tools_cache: null,
    tools_cache_refreshed_at: null,
    last_health_check_at: null,
    last_error: null,
    reauth_required_at: null,
    refresh_lease_until: null,
    created_at: '2026-10-27T04:00:00Z',
    updated_at: '2026-10-27T04:00:00Z',
    ...over,
  }
}

function deps(client: never, extra: Record<string, unknown> = {}) {
  const refresh = vi.fn(async (input: { refresh_token: string; client_secret?: string }) => ({
    access_token: `a-from-${input.refresh_token}`,
    refresh_token: 'r1',
    expires_in: 3600,
  }))
  const onMarked = vi.fn(async () => {})
  return { supabase: client, refresh, onMarked, now: () => NOW, sleep: async () => {}, ...extra }
}

beforeEach(() => {
  _resetTokenRefreshForTests()
})

describe('ensureFreshAccessToken', () => {
  it('passes through a server with no OAuth, and a probe row (no stored id), without touching the table', async () => {
    const { client, writes } = fakeDb([])
    const d = deps(client)
    const bearer = serverRow({ auth_type: 'bearer' })
    expect(await ensureFreshAccessToken(bearer, {}, d)).toBe(bearer)
    const probe = serverRow({ id: 'probe' })
    expect(await ensureFreshAccessToken(probe, {}, d)).toBe(probe)
    expect(d.refresh).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it('returns a token that is not near expiry as it is', async () => {
    const { client, writes } = fakeDb([])
    const d = deps(client)
    const fresh = serverRow({ token_expires_at: new Date(NOW + 30 * 60_000).toISOString() })
    expect(await ensureFreshAccessToken(fresh, {}, d)).toBe(fresh)
    expect(writes).toHaveLength(0)
  })

  it('refreshes from the STORED refresh token, not the caller’s stale copy, and saves on the token it spent', async () => {
    const stored = serverRow({ refresh_token_encrypted: 'r-rotated' })
    const { client, writes } = fakeDb([stored])
    const d = deps(client)
    // The caller's row still holds the refresh token an earlier call already spent.
    const out = await ensureFreshAccessToken(serverRow({ refresh_token_encrypted: 'r0' }), {}, d)
    expect(d.refresh).toHaveBeenCalledTimes(1)
    expect(d.refresh.mock.calls[0][0]).toMatchObject({ refresh_token: 'plain:r-rotated', client_id: 'c1' })
    expect(out.access_token_encrypted).toBe('enc:a-from-plain:r-rotated')
    expect(stored).toMatchObject({
      access_token_encrypted: 'enc:a-from-plain:r-rotated',
      refresh_token_encrypted: 'enc:r1',
      token_expires_at: new Date(NOW + 3600_000).toISOString(),
      reauth_required_at: null,
      refresh_lease_until: null,
    })
    expect(writes.at(-1)?.matched).toBe(1)
  })

  it('uses the stored tokens when another call already refreshed them (no second refresh)', async () => {
    const stored = serverRow({ access_token_encrypted: 'a-new', token_expires_at: new Date(NOW + 3600_000).toISOString() })
    const { client } = fakeDb([stored])
    const d = deps(client)
    const out = await ensureFreshAccessToken(serverRow(), {}, d)
    expect(d.refresh).not.toHaveBeenCalled()
    expect(out.access_token_encrypted).toBe('a-new')
    expect(stored.refresh_lease_until).toBeNull()
  })

  it('runs one refresh for concurrent calls on the same server', async () => {
    const stored = serverRow()
    const { client } = fakeDb([stored])
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const d = deps(client)
    d.refresh.mockImplementation(async (input) => {
      await gate
      return { access_token: `a-from-${input.refresh_token}`, refresh_token: 'r1', expires_in: 3600 }
    })
    const calls = [ensureFreshAccessToken(serverRow(), {}, d), ensureFreshAccessToken(serverRow(), {}, d), ensureFreshAccessToken(serverRow(), {}, d)]
    release()
    const out = await Promise.all(calls)
    expect(d.refresh).toHaveBeenCalledTimes(1)
    expect(new Set(out.map((r) => r.access_token_encrypted)).size).toBe(1)
  })

  it('a refusal for good marks it needs-reconnect once, tells the person once, and the next call fails at once', async () => {
    const stored = serverRow()
    const { client } = fakeDb([stored])
    const d = deps(client)
    d.refresh.mockRejectedValue(new TokenRefreshError('MCP token', 400, 'invalid_grant'))
    const err = await ensureFreshAccessToken(serverRow(), {}, d).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(McpTokenExpiredError)
    expect(stored.reauth_required_at).toBe(new Date(NOW).toISOString())
    expect(String(stored.last_error)).toMatch(/needs to be reconnected/)
    expect(stored.refresh_lease_until).toBeNull()
    expect(d.onMarked).toHaveBeenCalledTimes(1)
    expect(d.onMarked.mock.calls[0]).toEqual([expect.objectContaining({ id: ID, user_id: 'u1', workspace_id: 'w1', reauth_required_at: new Date(NOW).toISOString() })])

    // The turn's own (unmarked) copy, then a marked one: neither asks the provider again, nor tells twice.
    await expect(ensureFreshAccessToken(serverRow(), {}, d)).rejects.toBeInstanceOf(McpTokenExpiredError)
    await expect(ensureFreshAccessToken(serverRow({ reauth_required_at: stored.reauth_required_at as string }), {}, d)).rejects.toBeInstanceOf(McpTokenExpiredError)
    expect(d.refresh).toHaveBeenCalledTimes(1)
    expect(d.onMarked).toHaveBeenCalledTimes(1)
  })

  it('a refusal for now (a 5xx, the network) fails this call and leaves the status alone', async () => {
    const stored = serverRow()
    const { client } = fakeDb([stored])
    const d = deps(client)
    d.refresh.mockRejectedValueOnce(new TokenRefreshError('MCP token', 503, null))
    await expect(ensureFreshAccessToken(serverRow(), {}, d)).rejects.toBeInstanceOf(McpTokenRefreshUnavailableError)
    d.refresh.mockRejectedValueOnce(new Error('fetch failed'))
    await expect(ensureFreshAccessToken(serverRow(), {}, d)).rejects.toBeInstanceOf(McpTokenRefreshUnavailableError)
    expect(stored.reauth_required_at).toBeNull()
    expect(stored.refresh_lease_until).toBeNull()
    expect(d.onMarked).not.toHaveBeenCalled()
  })

  it('a refusal for good is not a mark when the stored refresh token changed meanwhile (a reconnect): that one is used', async () => {
    const stored = serverRow()
    const { client } = fakeDb([stored])
    const d = deps(client)
    d.refresh.mockImplementation(async () => {
      Object.assign(stored, { refresh_token_encrypted: 'r-reconnected', access_token_encrypted: 'a-reconnected', token_expires_at: new Date(NOW + 3600_000).toISOString() })
      throw new TokenRefreshError('MCP token', 400, 'invalid_grant')
    })
    const out = await ensureFreshAccessToken(serverRow(), {}, d)
    expect(out.access_token_encrypted).toBe('a-reconnected')
    expect(stored.reauth_required_at).toBeNull()
    expect(d.onMarked).not.toHaveBeenCalled()
  })

  it('never overwrites a reconnect that landed while its refresh was in flight', async () => {
    const stored = serverRow()
    const { client } = fakeDb([stored])
    const d = deps(client)
    d.refresh.mockImplementation(async () => {
      Object.assign(stored, { refresh_token_encrypted: 'r-reconnected', access_token_encrypted: 'a-reconnected' })
      return { access_token: 'a-late', refresh_token: 'r-late', expires_in: 3600 }
    })
    await ensureFreshAccessToken(serverRow(), {}, d)
    expect(stored).toMatchObject({ refresh_token_encrypted: 'r-reconnected', access_token_encrypted: 'a-reconnected' })
  })

  it('with no refresh token on file, an expired token is a mark', async () => {
    const stored = serverRow({ refresh_token_encrypted: null })
    const { client } = fakeDb([stored])
    const d = deps(client)
    await expect(ensureFreshAccessToken(serverRow({ refresh_token_encrypted: null }), {}, d)).rejects.toBeInstanceOf(McpTokenExpiredError)
    expect(d.refresh).not.toHaveBeenCalled()
    expect(stored.reauth_required_at).toBe(new Date(NOW).toISOString())
    expect(d.onMarked).toHaveBeenCalledTimes(1)
  })

  it('sends the client secret the server issued at registration (saved encrypted)', async () => {
    const meta = { token_endpoint: 'https://auth.example.com/token', client_id: 'c1', client_secret_encrypted: 's1' }
    const { client } = fakeDb([serverRow({ oauth_metadata: meta })])
    const d = deps(client)
    await ensureFreshAccessToken(serverRow({ oauth_metadata: meta }), {}, d)
    expect(d.refresh.mock.calls[0][0]).toMatchObject({ client_secret: 'plain:s1' })
  })

  it('waits for another refresh’s lease and uses the tokens it saved', async () => {
    const stored = serverRow({ refresh_lease_until: new Date(NOW + 10_000).toISOString() })
    const { client } = fakeDb([stored])
    let polls = 0
    const d = deps(client, {
      sleep: async () => {
        // The holder saves on the second poll.
        if (++polls === 2) Object.assign(stored, { access_token_encrypted: 'a-holder', token_expires_at: new Date(NOW + 3600_000).toISOString(), refresh_lease_until: null })
      },
    })
    const out = await ensureFreshAccessToken(serverRow(), {}, d)
    expect(out.access_token_encrypted).toBe('a-holder')
    expect(d.refresh).not.toHaveBeenCalled()
  })

  it('a forced refresh (the server refused the token) refreshes even before the expiry', async () => {
    const stored = serverRow({ token_expires_at: new Date(NOW + 3600_000).toISOString() })
    const { client } = fakeDb([stored])
    const d = deps(client)
    const out = await ensureFreshAccessToken(serverRow({ token_expires_at: stored.token_expires_at as string }), { force: true }, d)
    expect(d.refresh).toHaveBeenCalledTimes(1)
    expect(out.access_token_encrypted).not.toBe('a0')
  })

  it('a server marked when its row was read but reconnected since is used as stored', async () => {
    const stored = serverRow({ access_token_encrypted: 'a-reconnected', token_expires_at: new Date(NOW + 3600_000).toISOString() })
    const { client } = fakeDb([stored])
    const d = deps(client)
    const out = await ensureFreshAccessToken(serverRow({ reauth_required_at: '2026-10-27T11:00:00Z' }), {}, d)
    expect(out.access_token_encrypted).toBe('a-reconnected')
    expect(d.refresh).not.toHaveBeenCalled()
  })

  it('before migration 451: refreshes without the lease and saves the tokens alone', async () => {
    const stored = serverRow()
    delete stored.reauth_required_at
    delete stored.refresh_lease_until
    const { client } = fakeDb([stored], { columns: false })
    const d = deps(client)
    const out = await ensureFreshAccessToken(serverRow(), {}, d)
    expect(out.access_token_encrypted).toBe('enc:a-from-plain:r0')
    expect(stored).toMatchObject({ access_token_encrypted: 'enc:a-from-plain:r0', refresh_token_encrypted: 'enc:r1' })
    expect('reauth_required_at' in stored).toBe(false)
  })

  it('before migration 451: a refusal for good writes the expired message as the last error, and tells no one', async () => {
    const stored = serverRow()
    delete stored.reauth_required_at
    delete stored.refresh_lease_until
    const { client } = fakeDb([stored], { columns: false })
    const d = deps(client)
    d.refresh.mockRejectedValue(new TokenRefreshError('MCP token', 401, null))
    await expect(ensureFreshAccessToken(serverRow(), {}, d)).rejects.toBeInstanceOf(McpTokenExpiredError)
    expect(String(stored.last_error)).toMatch(/needs to be reconnected/)
    expect(d.onMarked).not.toHaveBeenCalled()
  })

  it('a caller’s deadline stops its wait; the refresh is held open past the response, lands and is saved', async () => {
    const stored = serverRow()
    const { client } = fakeDb([stored])
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const defer = vi.fn()
    const d = deps(client, { defer })
    d.refresh.mockImplementation(async () => {
      await gate
      return { access_token: 'a-late', refresh_token: 'r-late', expires_in: 3600 }
    })
    const controller = new AbortController()
    const pending = ensureFreshAccessToken(serverRow(), { signal: controller.signal }, d)
    await vi.waitFor(() => expect(d.refresh).toHaveBeenCalled())
    controller.abort()
    const err = await pending.catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(McpTokenExpiredError)
    expect(defer).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(stored.refresh_token_encrypted).toBe('enc:r-late'))
  })

  it('a successful refresh clears an old expired message left as the last error, and leaves another one alone', async () => {
    const expired = serverRow({ last_error: 'MCP server "Supabase" needs to be reconnected — the OAuth token expired and could not be refreshed.' })
    const { client } = fakeDb([expired])
    await ensureFreshAccessToken(serverRow(), {}, deps(client))
    expect(expired.last_error).toBeNull()
    _resetTokenRefreshForTests()
    const other = serverRow({ last_error: 'tools/list timed out' })
    const second = fakeDb([other])
    await ensureFreshAccessToken(serverRow(), {}, deps(second.client))
    expect(other.last_error).toBe('tools/list timed out')
  })

  it('lets go only of its own lease, never a later holder’s', async () => {
    const stored = serverRow()
    const { client } = fakeDb([stored])
    const d = deps(client)
    const later = new Date(NOW + 60_000).toISOString()
    d.refresh.mockImplementation(async () => {
      // Our lease lapsed (a slow request) and another refresh took it.
      stored.refresh_lease_until = later
      return { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }
    })
    await ensureFreshAccessToken(serverRow(), {}, d)
    expect(stored.refresh_lease_until).toBe(later)
  })
})
