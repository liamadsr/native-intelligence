import { randomBytes } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for the token-manager refresh dispatch.
 *
 * The provider-specific refresh handlers (refreshGoogleToken / refreshMicrosoftToken
 * / refreshHubspotToken) and refreshForProvider are module-private, so we drive
 * them through the public getValidTokenForAccount(): it loads the token row from
 * a mocked Supabase client and, when the token is inside the 5-minute refresh
 * buffer, dispatches to the correct provider endpoint (mocked fetch).
 *
 * The key regression this guards: dispatch used to be a `google ? … : microsoft`
 * ternary, silently routing github/hubspot to the Microsoft endpoint. It is now
 * an explicit switch that throws on an unsupported provider.
 */

const hoisted = vi.hoisted(() => ({
  fetch: vi.fn(),
  // The row returned from `user_oauth_tokens` for the account under test.
  tokenRow: null as Record<string, unknown> | null,
  // Captures every .update() payload so we can assert persistence.
  updates: [] as Array<Record<string, unknown>>,
  // …and the filters each write was made under, so the CAS can be asserted.
  updateFilters: [] as Array<Record<string, unknown>>,
  /**
   * What each successive write RESOLVES to, oldest first. The default is a
   * one-row success; a test that cares about a failed or lost write queues its
   * own. (The old fake hard-coded `{ error: null }`, which is precisely why the
   * dropped-write bug could not be expressed as a test at all.)
   */
  writeResults: [] as Array<{ data?: Array<{ id: string }> | null; error?: { message: string } | null }>,
}))

/**
 * Tokens are encrypted at rest (token-crypto.ts). Every token write goes
 * through here: a token column written in plaintext fails the test, and
 * `updates` records the payload DECRYPTED so the assertions below read as the
 * values the provider returned. The rows they read are legacy plaintext ones
 * (tokenRow below) unless a test stores a ciphertext.
 */
function openWrittenTokens(payload: Record<string, unknown>): Record<string, unknown> {
  const opened = { ...payload }
  for (const column of ['access_token', 'refresh_token']) {
    if (!(column in payload)) continue
    const stored = payload[column] as string
    if (!isEncryptedOAuthToken(stored)) throw new Error(`${column} written in plaintext`)
    opened[column] = decryptOAuthToken(stored)
  }
  return opened
}

// Minimal chainable Supabase client. Only the two chains token-manager uses:
//   read:   from('user_oauth_tokens').select('*').eq(...).order(...)   → { data, error }
//   write:  from(...).update(payload).eq('id', …).eq('refresh_token', …).select('id')
function makeSupabase() {
  const readChain = {
    select: () => readChain,
    eq: () => readChain,
    // `order` is the terminal call in the read path — resolve to the row list.
    order: () =>
      Promise.resolve({
        data: hoisted.tokenRow ? [hoisted.tokenRow] : [],
        error: null,
      }),
    // The reconnect flag's still-the-same-token check after a definitive failure.
    maybeSingle: () =>
      Promise.resolve({ data: hoisted.tokenRow ? { id: hoisted.tokenRow.id } : null, error: null }),
  }
  // connected_account writes (the reauth_required_at flag) are covered by
  // token-manager-reauth.test.ts; here they go to a sink so `updates` stays the
  // token writes only.
  const sink: Record<string, unknown> = {}
  for (const m of ['update', 'eq', 'is', 'not', 'select']) sink[m] = () => sink
  // getValidTokenForAccount's owner lookup: the token row's own user owns the account.
  sink.maybeSingle = () =>
    Promise.resolve({ data: hoisted.tokenRow ? { user_id: hoisted.tokenRow.user_id } : null, error: null })
  sink.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve)
  return {
    from: (table: string) => table === 'connected_account' ? sink : ({
      select: readChain.select,
      eq: readChain.eq,
      order: readChain.order,
      update: (payload: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {}
        hoisted.updates.push(openWrittenTokens(payload))
        hoisted.updateFilters.push(filters)
        const writeChain = {
          eq: (column: string, value: unknown) => {
            filters[column] = value
            return writeChain
          },
          // The terminal call: `.select('id')` is what makes the row count —
          // and therefore a lost CAS — observable at all.
          select: () => {
            const queued = hoisted.writeResults.shift()
            return Promise.resolve({
              data: queued?.data ?? (queued?.error ? null : [{ id: 'tok-1' }]),
              error: queued?.error ?? null,
            })
          },
        }
        return writeChain
      },
    }),
  }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => makeSupabase(),
}))

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64')

const { getValidTokenForAccount } = await import('../token-manager')
const { decryptOAuthToken, encryptOAuthToken, isEncryptedOAuthToken } = await import('../token-crypto')

// A timestamp inside the 5-min refresh buffer → forces a refresh.
const EXPIRING = new Date(Date.now() + 60 * 1000).toISOString()
// A timestamp comfortably beyond the buffer → no refresh.
const FRESH = new Date(Date.now() + 60 * 60 * 1000).toISOString()

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tok-1',
    user_id: 'u-1',
    provider: 'google',
    capability: 'calendar',
    access_token: 'old-access',
    refresh_token: 'refresh-abc',
    token_type: 'Bearer',
    expires_at: EXPIRING,
    scopes: [],
    email: 'user@example.com',
    account_id: 'acct-1',
    ...overrides,
  }
}

beforeEach(() => {
  hoisted.fetch.mockReset()
  hoisted.tokenRow = null
  hoisted.updates = []
  hoisted.updateFilters = []
  hoisted.writeResults = []
  vi.stubGlobal('fetch', hoisted.fetch)
  process.env.GOOGLE_CLIENT_ID = 'g-id'
  process.env.GOOGLE_CLIENT_SECRET = 'g-secret'
  process.env.MICROSOFT_CLIENT_ID = 'm-id'
  process.env.MICROSOFT_CLIENT_SECRET = 'm-secret'
  process.env.HUBSPOT_CLIENT_ID = 'h-id'
  process.env.HUBSPOT_CLIENT_SECRET = 'h-secret'
  process.env.ASANA_CLIENT_ID = 'a-id'
  process.env.ASANA_CLIENT_SECRET = 'a-secret'
  process.env.JIRA_CLIENT_ID = 'j-id'
  process.env.JIRA_CLIENT_SECRET = 'j-secret'
  process.env.LINEAR_CLIENT_ID = 'l-id'
  process.env.LINEAR_CLIENT_SECRET = 'l-secret'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getValidTokenForAccount — hubspot refresh happy path', () => {
  it('refreshes an expiring hubspot token against the date-versioned endpoint', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'hubspot', capability: 'crm' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'new-hs-access', expires_in: 1800 }),
    })

    const result = await getValidTokenForAccount('acct-1')

    expect(result).toEqual({
      token: 'new-hs-access',
      email: 'user@example.com',
      accountId: 'acct-1',
    })

    // Dispatched to the HubSpot token endpoint with the refresh grant.
    expect(hoisted.fetch).toHaveBeenCalledTimes(1)
    const [url, options] = hoisted.fetch.mock.calls[0]
    expect(url).toBe('https://api.hubapi.com/oauth/2026-03/token')
    const body = new URLSearchParams(options.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_id')).toBe('h-id')
    expect(body.get('client_secret')).toBe('h-secret')
    expect(body.get('refresh_token')).toBe('refresh-abc')

    // New access token persisted.
    expect(hoisted.updates).toHaveLength(1)
    expect(hoisted.updates[0].access_token).toBe('new-hs-access')
  })

  it('persists a rotated hubspot refresh_token only when returned', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'hubspot', capability: 'crm' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-hs-access',
        expires_in: 1800,
        refresh_token: 'rotated-refresh',
      }),
    })

    await getValidTokenForAccount('acct-1')
    expect(hoisted.updates[0].refresh_token).toBe('rotated-refresh')
  })

  it('keeps the existing refresh_token when the response omits one', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'hubspot', capability: 'crm', refresh_token: encryptOAuthToken('refresh-abc') })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'new-hs-access', expires_in: 1800 }),
    })

    await getValidTokenForAccount('acct-1')
    // The decrypted token was spent…
    const body = new URLSearchParams(hoisted.fetch.mock.calls[0][1].body as string)
    expect(body.get('refresh_token')).toBe('refresh-abc')
    // …and no refresh_token key written → existing (encrypted) value preserved.
    expect(hoisted.updates[0]).not.toHaveProperty('refresh_token')
  })

  it('re-writes a legacy plaintext refresh_token encrypted when the response omits one', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'hubspot', capability: 'crm' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'new-hs-access', expires_in: 1800 }),
    })

    await getValidTokenForAccount('acct-1')
    // Same token, now encrypted (openWrittenTokens refuses a plaintext write).
    expect(hoisted.updates[0].refresh_token).toBe('refresh-abc')
  })
})

describe('getValidTokenForAccount — asana refresh', () => {
  it('refreshes an expiring asana token against the asana token endpoint', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'asana', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      // Asana access tokens live exactly 3600s.
      json: async () => ({ access_token: 'new-asana-access', expires_in: 3600 }),
    })

    const result = await getValidTokenForAccount('acct-1')

    expect(result).toEqual({
      token: 'new-asana-access',
      email: 'user@example.com',
      accountId: 'acct-1',
    })

    expect(hoisted.fetch).toHaveBeenCalledTimes(1)
    const [url, options] = hoisted.fetch.mock.calls[0]
    expect(url).toBe('https://app.asana.com/-/oauth_token')
    const body = new URLSearchParams(options.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_id')).toBe('a-id')
    expect(body.get('client_secret')).toBe('a-secret')
    expect(body.get('refresh_token')).toBe('refresh-abc')

    expect(hoisted.updates).toHaveLength(1)
    expect(hoisted.updates[0].access_token).toBe('new-asana-access')
  })

  it('keeps the existing refresh_token — asana does not rotate on every refresh', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'asana', capability: 'tasks', refresh_token: encryptOAuthToken('refresh-abc') })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'new-asana-access', expires_in: 3600 }),
    })

    await getValidTokenForAccount('acct-1')
    expect(hoisted.updates[0]).not.toHaveProperty('refresh_token')
  })

  it('persists a rotated asana refresh_token when one IS returned', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'asana', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-asana-access',
        expires_in: 3600,
        refresh_token: 'rotated-asana-refresh',
      }),
    })

    await getValidTokenForAccount('acct-1')
    expect(hoisted.updates[0].refresh_token).toBe('rotated-asana-refresh')
  })

  it('returns null (and persists nothing) when asana rejects the refresh', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.tokenRow = tokenRow({ provider: 'asana', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) })

    const result = await getValidTokenForAccount('acct-1')

    expect(result).toBeNull()
    expect(hoisted.updates).toHaveLength(0)
    const logged = errSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join(' ')
    expect(logged).toContain('Asana refresh failed: 400')
  })
})

describe('getValidTokenForAccount — jira refresh (ROTATING)', () => {
  it('refreshes an expiring jira token against auth.atlassian.com', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'jira', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-jira-access',
        expires_in: 3600,
        refresh_token: 'rotated-1',
      }),
    })

    const result = await getValidTokenForAccount('acct-1')

    expect(result).toEqual({
      token: 'new-jira-access',
      email: 'user@example.com',
      accountId: 'acct-1',
    })

    expect(hoisted.fetch).toHaveBeenCalledTimes(1)
    const [url, options] = hoisted.fetch.mock.calls[0]
    expect(url).toBe('https://auth.atlassian.com/oauth/token')
    const body = new URLSearchParams(options.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_id')).toBe('j-id')
    expect(body.get('client_secret')).toBe('j-secret')
    expect(body.get('refresh_token')).toBe('refresh-abc')
  })

  it('PERSISTS the rotated refresh token — the old one is dead on arrival', async () => {
    // Atlassian mints a NEW refresh token on every refresh and immediately
    // invalidates the one just spent. Failing to persist it doesn't break this
    // call — it breaks the NEXT one, an hour later, permanently.
    hoisted.tokenRow = tokenRow({ provider: 'jira', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-jira-access',
        expires_in: 3600,
        refresh_token: 'rotated-1',
      }),
    })

    await getValidTokenForAccount('acct-1')

    expect(hoisted.updates).toHaveLength(1)
    expect(hoisted.updates[0].refresh_token).toBe('rotated-1')
  })

  it('writes the access token and the rotated refresh token in ONE statement', async () => {
    // Two statements would admit a state where the access token landed and the
    // refresh token didn't — leaving a row holding a token that can never be
    // exchanged again, i.e. an unrecoverable connection.
    hoisted.tokenRow = tokenRow({ provider: 'jira', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-jira-access',
        expires_in: 3600,
        refresh_token: 'rotated-1',
      }),
    })

    await getValidTokenForAccount('acct-1')

    expect(hoisted.updates).toHaveLength(1)
    expect(hoisted.updates[0]).toMatchObject({
      access_token: 'new-jira-access',
      refresh_token: 'rotated-1',
    })
    expect(hoisted.updates[0].expires_at).toBeTruthy()
  })

  it('surfaces invalid_grant in the log — the one failure only a RECONNECT fixes', async () => {
    // 403 + invalid_grant means a lost rotation, a 90-day-idle token, a password
    // change or a revoked app. Every one of them needs the user back through
    // /authorize, and getValidTokenForAccount's null is what every Jira caller
    // renders as reconnect_required.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.tokenRow = tokenRow({ provider: 'jira', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' }),
    })

    const result = await getValidTokenForAccount('acct-1')

    expect(result).toBeNull()
    expect(hoisted.updates).toHaveLength(0)
    const logged = errSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join(' ')
    expect(logged).toContain('Jira refresh failed: 403')
    expect(logged).toContain('invalid_grant')
  })

  it('still reports the status when the error body is not JSON', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.tokenRow = tokenRow({ provider: 'jira', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json')
      },
    })

    expect(await getValidTokenForAccount('acct-1')).toBeNull()
    const logged = errSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join(' ')
    expect(logged).toContain('Jira refresh failed: 502')
  })

  it('does NOT route jira to the asana endpoint (the explicit-switch guarantee)', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'jira', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'x', expires_in: 3600, refresh_token: 'r' }),
    })
    await getValidTokenForAccount('acct-1')
    expect(hoisted.fetch.mock.calls[0][0]).not.toContain('asana')
  })
})

describe('getValidTokenForAccount — linear refresh (ROTATING)', () => {
  function linearRotation(refreshToken = 'rotated-linear-1') {
    hoisted.tokenRow = tokenRow({ provider: 'linear', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-linear-access',
        // ~24h, unlike Atlassian's 3600 — which is why a Linear 401 almost
        // never means "the connection is dead".
        expires_in: 86400,
        refresh_token: refreshToken,
      }),
    })
  }

  it('refreshes an expiring linear token against api.linear.app, form-encoded', async () => {
    linearRotation()

    expect(await getValidTokenForAccount('acct-1')).toEqual({
      token: 'new-linear-access',
      email: 'user@example.com',
      accountId: 'acct-1',
    })

    const [url, options] = hoisted.fetch.mock.calls[0]
    expect(url).toBe('https://api.linear.app/oauth/token')
    expect((options.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    const body = new URLSearchParams(options.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_id')).toBe('l-id')
    expect(body.get('client_secret')).toBe('l-secret')
    expect(body.get('refresh_token')).toBe('refresh-abc')
  })

  /**
   * Linear rotates like Atlassian: the response carries a NEW refresh token and
   * the one just spent is dead (with a ~30-minute reuse grace for the
   * concurrency race two lambdas can lose). Failing to persist it doesn't break
   * this call — it breaks the NEXT one, a day later, permanently.
   */
  it('PERSISTS the rotated refresh token', async () => {
    linearRotation()
    await getValidTokenForAccount('acct-1')

    expect(hoisted.updates).toHaveLength(1)
    expect(hoisted.updates[0].refresh_token).toBe('rotated-linear-1')
  })

  it('writes the access token and the rotated refresh token in ONE statement', async () => {
    linearRotation()
    await getValidTokenForAccount('acct-1')

    expect(hoisted.updates).toHaveLength(1)
    expect(hoisted.updates[0]).toMatchObject({
      access_token: 'new-linear-access',
      refresh_token: 'rotated-linear-1',
    })
    expect(hoisted.updates[0].expires_at).toBeTruthy()
  })

  /**
   * The CAS is what makes a rotating provider safe against a concurrent writer.
   * Registering 'linear' in refreshTokenRotates() is not cosmetic: it is what
   * puts this provider on the same conditional-write path Jira uses, and the
   * filter below is that path's signature.
   */
  it('CASes on the refresh token it just spent, like the other rotating provider', async () => {
    linearRotation()
    await getValidTokenForAccount('acct-1')
    expect(hoisted.updateFilters[0]).toEqual({ id: 'tok-1', refresh_token: 'refresh-abc' })
  })

  it('warns that a lost write needs a RECONNECT — the rotating-provider message', async () => {
    // The message differs by provider class: for a non-rotating one the stored
    // token is still good and the next call just refreshes again. Linear must
    // get the rotating message, or an operator reading the log will wait for a
    // self-heal that cannot come.
    linearRotation()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.writeResults = [
      { error: { message: 'statement timeout' } },
      { error: { message: 'statement timeout' } },
    ]

    const result = await getValidTokenForAccount('acct-1')

    // The access token in hand is still valid, so it is returned rather than
    // failing a call we already paid for.
    expect(result?.token).toBe('new-linear-access')
    const logged = errSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join(' ')
    expect(logged).toContain('ROTATES refresh tokens')
    expect(logged).toContain('manual reconnect')
  })

  it('surfaces invalid_grant in the log — the one failure only a RECONNECT fixes', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.tokenRow = tokenRow({ provider: 'linear', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    })

    expect(await getValidTokenForAccount('acct-1')).toBeNull()
    expect(hoisted.updates).toHaveLength(0)
    const logged = errSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join(' ')
    expect(logged).toContain('Linear refresh failed: 400')
    expect(logged).toContain('invalid_grant')
  })

  it('still reports the status when the error body is not JSON', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.tokenRow = tokenRow({ provider: 'linear', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json')
      },
    })

    expect(await getValidTokenForAccount('acct-1')).toBeNull()
    expect(errSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join(' ')).toContain(
      'Linear refresh failed: 502',
    )
  })

  it('does NOT route linear to the jira or asana endpoint', async () => {
    // The explicit-switch guarantee: an unmapped provider must fail loudly
    // rather than fall into a neighbour's handler.
    linearRotation()
    await getValidTokenForAccount('acct-1')
    const url = String(hoisted.fetch.mock.calls[0][0])
    expect(url).not.toContain('atlassian')
    expect(url).not.toContain('asana')
    expect(url).toContain('linear.app')
  })
})

/**
 * REGRESSION (review finding: "rotating refresh token can be silently lost —
 * the persist result is never checked").
 *
 * The write used to be `await …update(…).eq('id', …)` with the result dropped
 * on the floor. supabase-js does not throw on a failed write, so a transient
 * PostgREST failure was invisible — harmless for a provider whose refresh token
 * survives (the next call just refreshes again) and TERMINAL for Atlassian,
 * which kills the token the moment it is exchanged. The write is now CHECKED,
 * retried once, and made CONDITIONAL on the token it just spent.
 */
describe('refresh persistence — checked, retried and compare-and-swapped', () => {
  function jiraRotation() {
    hoisted.tokenRow = tokenRow({ provider: 'jira', capability: 'tasks' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-jira-access',
        expires_in: 3600,
        refresh_token: 'rotated-1',
      }),
    })
  }

  it('CASes on the refresh token it just spent, not on the row id alone', async () => {
    // Without this filter the write is last-writer-wins on `id`: an in-flight
    // refresh landing after the user reconnected (the OAuth callback UPDATEs
    // this same row) overwrites the fresh credentials with values derived from
    // a chain Atlassian has already killed.
    jiraRotation()

    await getValidTokenForAccount('acct-1')

    expect(hoisted.updateFilters[0]).toEqual({ id: 'tok-1', refresh_token: 'refresh-abc' })
  })

  it('CASes on the STORED ciphertext, and spends its plaintext', async () => {
    // A ciphertext never equals its plaintext, nor another encryption of it:
    // a CAS on the decrypted value would match 0 rows and lose every rotation.
    jiraRotation()
    const stored = encryptOAuthToken('refresh-abc')
    hoisted.tokenRow = tokenRow({ provider: 'jira', capability: 'tasks', refresh_token: stored })

    await getValidTokenForAccount('acct-1')

    const body = new URLSearchParams(hoisted.fetch.mock.calls[0][1].body as string)
    expect(body.get('refresh_token')).toBe('refresh-abc')
    expect(hoisted.updateFilters[0]).toEqual({ id: 'tok-1', refresh_token: stored })
    expect(hoisted.updates[0]).toMatchObject({ access_token: 'new-jira-access', refresh_token: 'rotated-1' })
  })

  it('RETRIES the write once when it fails, and succeeds on the retry', async () => {
    jiraRotation()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoisted.writeResults = [{ error: { message: 'statement timeout' } }]

    const result = await getValidTokenForAccount('acct-1')

    expect(hoisted.updates).toHaveLength(2)
    expect(hoisted.updates[1].refresh_token).toBe('rotated-1')
    expect(result?.token).toBe('new-jira-access')
    expect(warn).toHaveBeenCalled()
  })

  it('logs LOUDLY with the account id when both write attempts fail — and still returns the token', async () => {
    // The access token in hand is valid for its full hour and Atlassian allows
    // a 10-minute reuse window on the spent refresh token, so returning it
    // beats failing a call we already paid for. What must NOT happen is
    // silence: this is the one log line that distinguishes a lost rotation from
    // a user revoking the app.
    jiraRotation()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.writeResults = [
      { error: { message: 'statement timeout' } },
      { error: { message: 'statement timeout' } },
    ]

    const result = await getValidTokenForAccount('acct-1')

    expect(result?.token).toBe('new-jira-access')
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(logged).toContain('acct-1')
    expect(logged).toContain('COULD NOT PERSIST')
    // Jira rotates, so the log has to say the connection is now doomed rather
    // than "we'll refresh again next time".
    expect(logged).toContain('ROTATES')
  })

  it('does not clobber a racing writer: 0 rows matched is a LOST RACE, not a failure', async () => {
    jiraRotation()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoisted.writeResults = [{ data: [] }]

    const result = await getValidTokenForAccount('acct-1')

    // One attempt only — an empty match is not an error to retry, it is another
    // writer having already stored NEWER credentials.
    expect(hoisted.updates).toHaveLength(1)
    expect(result?.token).toBe('new-jira-access')
    expect(warn.mock.calls.map((c) => c.join(' ')).join(' ')).toContain('concurrent writer')
  })

  it('tells the truth for a NON-rotating provider when the write fails', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'google' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'new-g', expires_in: 3600 }),
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.writeResults = [{ error: { message: 'boom' } }, { error: { message: 'boom' } }]

    const result = await getValidTokenForAccount('acct-1')

    expect(result?.token).toBe('new-g')
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(logged).toContain('still valid')
  })
})

describe('getValidTokenForAccount — google/microsoft dispatch unchanged', () => {
  it('routes an expiring google token to the google endpoint', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'google' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'new-g', expires_in: 3600 }),
    })

    const result = await getValidTokenForAccount('acct-1')
    expect(result?.token).toBe('new-g')
    expect(hoisted.fetch.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token')
  })

  it('routes an expiring microsoft token to the microsoft endpoint', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'microsoft', capability: 'email' })
    hoisted.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'new-m', expires_in: 3600 }),
    })

    const result = await getValidTokenForAccount('acct-1')
    expect(result?.token).toBe('new-m')
    expect(hoisted.fetch.mock.calls[0][0]).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    )
  })
})

describe('getValidTokenForAccount — unsupported provider', () => {
  it('does not fall through to another provider endpoint and returns null', async () => {
    // github has no refresh handler — the switch must throw, not silently hit
    // the Microsoft endpoint (the pre-refactor latent bug).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.tokenRow = tokenRow({ provider: 'github', capability: 'github' })

    const result = await getValidTokenForAccount('acct-1')

    // Refresh failed → null. Crucially, NO network call was made to any endpoint.
    expect(result).toBeNull()
    expect(hoisted.fetch).not.toHaveBeenCalled()

    // The thrown message surfaced via refreshToken's catch/log.
    const logged = errSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join(' ')
    expect(logged).toContain('No refresh handler for provider: github')
  })
})

describe('getValidTokenForAccount — refresh buffer', () => {
  it('returns the stored token without refreshing when far from expiry', async () => {
    hoisted.tokenRow = tokenRow({ provider: 'hubspot', capability: 'crm', expires_at: FRESH })

    const result = await getValidTokenForAccount('acct-1')

    expect(result).toEqual({
      token: 'old-access',
      email: 'user@example.com',
      accountId: 'acct-1',
    })
    expect(hoisted.fetch).not.toHaveBeenCalled()
    expect(hoisted.updates).toHaveLength(0)
  })

  it('decrypts a stored access token', async () => {
    hoisted.tokenRow = tokenRow({
      provider: 'hubspot',
      capability: 'crm',
      expires_at: FRESH,
      access_token: encryptOAuthToken('old-access'),
    })

    expect((await getValidTokenForAccount('acct-1'))?.token).toBe('old-access')
    expect(hoisted.fetch).not.toHaveBeenCalled()
  })
})

describe('getValidTokenForAccount — a token that will not decrypt', () => {
  /** A v1 ciphertext that fails its auth tag: what another key's would do here. */
  function undecryptable(plaintext: string): string {
    const parts = encryptOAuthToken(plaintext).split('.')
    const ct = Buffer.from(parts[3], 'base64')
    ct[0] ^= 0x01
    parts[3] = ct.toString('base64')
    return parts.join('.')
  }

  it('returns null (callers expect it) and logs the account, never the value', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stored = undecryptable('old-access')
    hoisted.tokenRow = tokenRow({ provider: 'hubspot', capability: 'crm', expires_at: FRESH, access_token: stored })

    await expect(getValidTokenForAccount('acct-1')).resolves.toBeNull()
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(logged).toContain('acct-1')
    expect(logged).not.toContain(stored)
    expect(hoisted.fetch).not.toHaveBeenCalled()
  })

  it('never spends an undecryptable refresh token: null, no provider call, no write', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stored = undecryptable('refresh-abc')
    hoisted.tokenRow = tokenRow({ provider: 'jira', capability: 'tasks', refresh_token: stored })

    await expect(getValidTokenForAccount('acct-1')).resolves.toBeNull()
    expect(hoisted.fetch).not.toHaveBeenCalled()
    expect(hoisted.updates).toHaveLength(0)
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(logged).toContain('acct-1')
    expect(logged).not.toContain(stored)
  })
})
