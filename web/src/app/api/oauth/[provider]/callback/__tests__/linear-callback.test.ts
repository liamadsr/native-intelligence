import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'

/**
 * Tests for the linear branch of GET /api/oauth/[provider]/callback.
 *
 * Identity lookup at callback time is a one-line REST GET for every other
 * provider in this route. Linear is the exception: it has no /me resource and
 * exactly one GraphQL endpoint, so the connecting user is read with a POSTed
 * query. That makes its branch the only one where the METHOD, the body and the
 * response shape can each be wrong independently, and none of those errors are
 * type errors — they surface as an account row labelled `<uuid>@unknown`, which
 * looks like a cosmetic display bug rather than a failed identity lookup.
 *
 * The GraphQL failure mode is the one worth pinning hardest: a Linear error is
 * a **200** carrying an `errors` array and a null field, so `res.ok` is true on
 * failure and the ONLY thing separating "no identity" from "identity" is that
 * the read falls through to null. Anything that makes this branch return a
 * non-null placeholder on that payload — a default, a `?? 'linear'`, reading
 * `errors[0]` — silently pins a bogus identity onto the account row and, worse,
 * makes it look like a successful lookup. (The `body?.data?.viewer` optional
 * chain is defence in depth rather than the load-bearing part: `getUserEmail`
 * wraps everything in a bare try/catch, so a throw here lands on the same null.)
 *
 * These run the REAL route end to end — state signing, token exchange, the
 * identity lookup, the account/token writes — with only `fetch` and the two
 * Supabase clients faked, so a break anywhere along that path fails here.
 */

const hoisted = vi.hoisted(() => ({
  /**
   * Rows the service-role client hands back from a LOOKUP (`.maybeSingle()`),
   * keyed by table. Empty by default so the route takes the create path — the
   * one whose `connected_account` insert payload carries the account_email
   * these tests read back. A row here instead models the re-auth path.
   */
  rows: {} as Record<string, unknown>,
  /** Every `.insert()` payload the route wrote, in order. */
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/email/gmail-watch', () => ({ setupGmailWatch: vi.fn() }))
vi.mock('@/lib/email/outlook-webhook', () => ({ setupOutlookSubscription: vi.fn() }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

/** The session client, used only by the `source: 'web'` CSRF binding. */
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) },
  }),
}))

/** The route's service-role client: account lookup + the token/account writes. */
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        is: () => api,
        limit: () => api,
        update: () => api,
        upsert: () => api,
        insert: (payload: Record<string, unknown>) => {
          hoisted.inserts.push({ table, payload })
          return api
        },
        // `.single()` is reached only by the create-path insert
        // (`.insert(...).select('id').single()`), so it always yields the new
        // row's id; `.maybeSingle()` is every LOOKUP, which reads `rows`.
        single: async () => ({ data: { id: 'acct-new' }, error: null }),
        maybeSingle: async () => ({ data: hoisted.rows[table] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null, count: 0 }).then(resolve),
      }
      return api
    },
  }),
}))

// The connect stores its tokens encrypted (src/lib/oauth/token-crypto.ts).
process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')

// The route module reads no env at import time, but the mock factories above
// close over `hoisted`, so the import must be deferred past their hoisting.
const { GET } = await import('../route')

/** Signed state matching what the authorize route mints, so the CSRF gate passes. */
function signedState(overrides: Record<string, unknown> = {}) {
  const payload = {
    user_id: 'u-1',
    capability: 'tasks',
    source: 'web',
    nonce: 'nonce-1',
    workspace_id: 'ws-1',
    exp: Date.now() + 60_000,
    ...overrides,
  }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto
    .createHmac('sha256', process.env.OAUTH_STATE_SECRET!)
    .update(b64)
    .digest('base64url')
  return `${b64}.${sig}`
}

/** The provider's redirect back to the browser that started the flow (its nonce cookie rides along). */
function callback(provider: string, state = signedState()) {
  return GET(
    new Request(
      `https://dial8.ai/api/oauth/${provider}/callback?code=auth-code&state=${state}`,
      { headers: { cookie: 'oauth_nonce=nonce-1' } },
    ),
    { params: Promise.resolve({ provider }) },
  )
}

/** Calls made to the Linear GraphQL endpoint during the last request. */
function graphqlCalls() {
  return fetchMock.mock.calls.filter(
    ([url]) => String(url) === 'https://api.linear.app/graphql',
  )
}

/** The `account_email` the route persisted on the new connected_account row. */
function persistedEmail() {
  return hoisted.inserts.find((i) => i.table === 'connected_account')?.payload
    .account_email
}

let fetchMock: ReturnType<typeof vi.fn>

/** Default: token exchange succeeds, then the viewer query returns an email. */
function stubFetch(viewerResponse: { status?: number; body: unknown }) {
  fetchMock = vi.fn(async (url: string | URL | Request) => {
    const href = String(typeof url === 'object' && 'url' in url ? url.url : url)
    if (href === 'https://api.linear.app/oauth/token') {
      return new Response(
        JSON.stringify({ access_token: 'linear-tok', token_type: 'Bearer' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (href === 'https://api.linear.app/graphql') {
      return new Response(JSON.stringify(viewerResponse.body), {
        status: viewerResponse.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch to ${href}`)
  })
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.inserts = []
  // No existing account/token row → the create path.
  // The callback re-checks the state's workspace membership.
  hoisted.rows = { member: { id: 'm-1' } }
  vi.stubEnv('OAUTH_STATE_SECRET', 'state-secret')
  vi.stubEnv('LINEAR_CLIENT_ID', 'linear-client')
  vi.stubEnv('LINEAR_CLIENT_SECRET', 'linear-secret')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
  // getRedirectUri() prefers OAUTH_REDIRECT_BASE_URL over NEXT_PUBLIC_APP_URL,
  // so a value inherited from the shell would change the token exchange's
  // redirect_uri. Unset it so the base comes from NEXT_PUBLIC_APP_URL above.
  vi.stubEnv('OAUTH_REDIRECT_BASE_URL', undefined)
  stubFetch({ body: { data: { viewer: { email: 'dev@acme.com', name: 'Dev' } } } })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/oauth/linear/callback — viewer identity lookup', () => {
  /**
   * Everything about this call is Linear-specific and none of it is enforced by
   * a type: a GET (the shape every sibling uses) returns 405, a missing
   * Content-Type is rejected, and an unauthenticated POST is a 200 with errors.
   */
  it('POSTs the viewer query to the GraphQL endpoint with the bearer token', async () => {
    await callback('linear')

    const calls = graphqlCalls()
    expect(calls).toHaveLength(1)
    const init = calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer linear-tok',
    )
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    )
    expect(JSON.parse(init.body as string)).toEqual({
      query: '{ viewer { email name } }',
    })
  })

  /**
   * The query is deliberately SHALLOW. Linear budgets requests by complexity
   * points and this one runs on every connect, so nesting `organization` or
   * `teams` in here (tempting — the destination picker wants exactly that) buys
   * a rate limit on the hot path. The picker loads them later, on demand.
   */
  it('asks for viewer only — no nested organization or teams', async () => {
    await callback('linear')
    const query = JSON.parse(
      (graphqlCalls()[0][1] as RequestInit).body as string,
    ).query as string
    expect(query).not.toContain('organization')
    expect(query).not.toContain('teams')
  })

  it('extracts the viewer email and stores it as the account email', async () => {
    const res = await callback('linear')

    expect(persistedEmail()).toBe('dev@acme.com')
    // …and it reaches the caller, which is what the settings UI labels the row with.
    expect(new URL(res.headers.get('location')!).searchParams.get('email')).toBe(
      'dev@acme.com',
    )
  })

  it('uses LINEAR_CLIENT_ID/SECRET for the exchange, not another provider’s', async () => {
    await callback('linear')

    const tokenCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === 'https://api.linear.app/oauth/token',
    )!
    const body = new URLSearchParams(
      (tokenCall[1] as RequestInit).body as string,
    )
    expect(body.get('client_id')).toBe('linear-client')
    expect(body.get('client_secret')).toBe('linear-secret')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe('https://dial8.ai/api/oauth/linear/callback')
  })
})

describe('GET /api/oauth/[provider]/callback — workspace membership', () => {
  it('refuses a state whose workspace the user is not a member of', async () => {
    hoisted.rows = {}
    const res = await callback('linear', signedState({ workspace_id: 'ws-foreign' }))

    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('not_member')
    expect(hoisted.inserts.find((i) => i.table === 'connected_account')).toBeUndefined()
  })
})

describe('GET /api/oauth/linear/callback — identity fallbacks', () => {
  /**
   * Linear does not require an email be visible to an OAuth app, so `email` can
   * come back null on a perfectly healthy viewer. The name is a real identity —
   * far better than a uuid — and every sibling provider falls back the same way.
   */
  it('falls back to the viewer NAME when the email is absent', async () => {
    stubFetch({ body: { data: { viewer: { email: null, name: 'Dev Person' } } } })

    await callback('linear')

    expect(persistedEmail()).toBe('Dev Person')
  })

  it('prefers the email over the name when both are present', async () => {
    await callback('linear')
    expect(persistedEmail()).toBe('dev@acme.com')
  })

  /**
   * THE GraphQL trap: a failed Linear query is a 200 — `res.ok` is true — with
   * the payload in `errors` and `data.viewer` null. The lookup has to READ that
   * as "no identity" and fall through to null, so the caller's `<userId>@unknown`
   * is reached. The second half matters just as much: this is a degraded label
   * on a SUCCESSFUL connect (the token is fine), not an error redirect.
   */
  it('falls back to <userId>@unknown on a 200-with-errors GraphQL failure', async () => {
    stubFetch({
      body: {
        data: null,
        errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }],
      },
    })

    const res = await callback('linear')

    expect(persistedEmail()).toBe('u-1@unknown')
    // The connect still SUCCEEDS — the token is good, only the label is unknown.
    const location = new URL(res.headers.get('location')!)
    expect(location.searchParams.get('integration_success')).toBe('true')
    expect(location.searchParams.get('error')).toBeNull()
  })

  it('falls back to <userId>@unknown when viewer comes back null but data does not', async () => {
    stubFetch({ body: { data: { viewer: null } } })

    await callback('linear')

    expect(persistedEmail()).toBe('u-1@unknown')
  })

  it('falls back to <userId>@unknown on a non-200 from the GraphQL endpoint', async () => {
    stubFetch({ status: 401, body: { errors: [{ message: 'Invalid token' }] } })

    const res = await callback('linear')

    expect(persistedEmail()).toBe('u-1@unknown')
    expect(
      new URL(res.headers.get('location')!).searchParams.get('integration_success'),
    ).toBe('true')
  })

  /**
   * `getUserEmail` is wrapped in a bare try/catch that swallows everything, so a
   * transport failure has to reach the SAME fallback rather than the catch-all
   * `server_error` redirect one level up.
   */
  it('falls back to <userId>@unknown when the GraphQL call throws outright', async () => {
    fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href === 'https://api.linear.app/oauth/token') {
        return new Response(JSON.stringify({ access_token: 'linear-tok' }), {
          status: 200,
        })
      }
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await callback('linear')

    expect(persistedEmail()).toBe('u-1@unknown')
    expect(
      new URL(res.headers.get('location')!).searchParams.get('integration_success'),
    ).toBe('true')
  })
})

describe('GET /api/oauth/linear/callback — the linear branch is linear-only', () => {
  /**
   * The identity lookup is chosen by provider. A branch that fell through to the
   * final `else` would POST nothing and GET graph.microsoft.com with a Linear
   * token — which returns 401, i.e. it degrades to `<uuid>@unknown` silently
   * instead of failing loudly.
   */
  it('does not call any other identity endpoint for linear', async () => {
    await callback('linear')

    const hosts = fetchMock.mock.calls.map(([url]) => new URL(String(url)).host)
    expect(hosts).toEqual(['api.linear.app', 'api.linear.app'])
  })

  it('labels the new account "Linear"', async () => {
    await callback('linear')

    expect(
      hoisted.inserts.find((i) => i.table === 'connected_account')?.payload
        .display_name,
    ).toBe('Linear')
  })

  /**
   * `tasks` is provider-generic on purpose — the seed keys off capability, not
   * provider — so a Linear connect must round-trip its capability with no
   * linear-specific code, and must NOT be mistaken for an email/calendar
   * connect (which would create the wrong preference row and, for email, fire a
   * background import against a provider that has no mailbox).
   */
  it('completes as a tasks connect — no email/calendar preference rows', async () => {
    const res = await callback('linear')

    expect(
      new URL(res.headers.get('location')!).searchParams.get('capability'),
    ).toBe('tasks')
    const tables = hoisted.inserts.map((i) => i.table)
    expect(tables).not.toContain('email_account_preference')
    expect(tables).not.toContain('calendar_account_preference')
    expect(tables).not.toContain('email_sync_state')
  })

  it('does NOT hit api.linear.app when the provider is jira', async () => {
    vi.stubEnv('JIRA_CLIENT_ID', 'jira-client')
    vi.stubEnv('JIRA_CLIENT_SECRET', 'jira-secret')
    fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('atlassian.com/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'jira-tok' }), { status: 200 })
      }
      return new Response(JSON.stringify({ email: 'dev@acme.com' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await callback('jira')

    const hosts = fetchMock.mock.calls.map(([url]) => new URL(String(url)).host)
    expect(hosts).not.toContain('api.linear.app')
  })
})

describe('GET /api/oauth/[provider]/callback — desktop hand-back', () => {
  /**
   * The desktop gets the code back UNEXCHANGED by deep link; the initiating
   * window claims it (/api/oauth/[provider]/claim). The callback itself never
   * exchanges a desktop code (security review 2026-10-31, P0-2 — see
   * account-linking-csrf.test.ts for the attack this closes).
   */
  it('redirects to the complete deep link with the code SEALED and the state, without exchanging', async () => {
    const state = signedState({ source: 'desktop', claim: 'claim-hash' })
    const res = await callback('linear', state)

    expect(res.status).toBe(307) // NextResponse.redirect's default
    const deepLink = new URL(res.headers.get('location')!)
    expect(deepLink.protocol).toBe('dial8desktop:')
    expect(deepLink.host).toBe('oauth')
    expect(deepLink.pathname).toBe('/complete')
    expect(deepLink.searchParams.get('code')).toBeNull()
    expect(deepLink.searchParams.get('sealed')).toBeTruthy()
    expect(deepLink.href).not.toContain('auth-code')
    expect(deepLink.searchParams.get('state')).toBe(state)
    expect(deepLink.searchParams.get('provider')).toBe('linear')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hands a provider error back the same way', async () => {
    const res = await GET(
      new Request(
        `https://dial8.ai/api/oauth/linear/callback?error=access_denied&state=${signedState({ source: 'desktop' })}`,
      ),
      { params: Promise.resolve({ provider: 'linear' }) },
    )
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('dial8desktop://oauth/error?provider=linear&error=access_denied')
  })
})
