import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'

/**
 * A reconnect clears connected_account.reauth_required_at (migration 348):
 * the re-auth path (an existing connected_account) calls the token-manager's
 * column-tolerant setReauthRequiredAt(…, null) once the new tokens are saved.
 * A brand-new account starts NULL, so the create path doesn't call it, and a
 * failed token save leaves the flag alone.
 */

const hoisted = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  tokenWriteError: null as { message: string } | null,
  setReauthRequiredAt: vi.fn(async () => {}),
}))

vi.mock('@/lib/oauth/token-manager', () => ({
  setReauthRequiredAt: hoisted.setReauthRequiredAt,
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/email/gmail-watch', () => ({ setupGmailWatch: vi.fn() }))
vi.mock('@/lib/email/outlook-webhook', () => ({ setupOutlookSubscription: vi.fn() }))
vi.mock('@/lib/email/account-scope', () => ({ reconcileThreadCopies: vi.fn() }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) },
  }),
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      let writingTokens = false
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        is: () => api,
        limit: () => api,
        upsert: () => api,
        update: () => ((writingTokens = table === 'user_oauth_tokens'), api),
        insert: () => ((writingTokens = table === 'user_oauth_tokens'), api),
        single: async () => ({ data: { id: 'acct-new' }, error: null }),
        maybeSingle: async () => ({ data: hoisted.rows[table] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({
            data: null,
            error: writingTokens ? hoisted.tokenWriteError : null,
            count: 0,
          }).then(resolve),
      }
      return api
    },
  }),
}))

// The connect stores its tokens encrypted (src/lib/oauth/token-crypto.ts).
process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')

const { GET } = await import('../route')

function signedState() {
  const payload = { user_id: 'u-1', capability: 'tasks', source: 'web', nonce: 'n-1', workspace_id: 'ws-1', exp: Date.now() + 60_000 }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', process.env.OAUTH_STATE_SECRET!).update(b64).digest('base64url')
  return `${b64}.${sig}`
}

/** The provider's redirect back to the browser that started the flow (its nonce cookie rides along). */
function callback() {
  return GET(
    new Request(`https://dial8.ai/api/oauth/linear/callback?code=auth-code&state=${signedState()}`, {
      headers: { cookie: 'oauth_nonce=n-1' },
    }),
    { params: Promise.resolve({ provider: 'linear' }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // The callback re-checks the state's workspace membership.
  hoisted.rows = { member: { id: 'm-1' } }
  hoisted.tokenWriteError = null
  vi.stubEnv('OAUTH_STATE_SECRET', 'state-secret')
  vi.stubEnv('LINEAR_CLIENT_ID', 'linear-client')
  vi.stubEnv('LINEAR_CLIENT_SECRET', 'linear-secret')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
  vi.stubEnv('OAUTH_REDIRECT_BASE_URL', undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const href = String(typeof url === 'object' && 'url' in url ? url.url : url)
      if (href === 'https://api.linear.app/oauth/token') {
        return new Response(JSON.stringify({ access_token: 'linear-tok', token_type: 'Bearer' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (href === 'https://api.linear.app/graphql') {
        return new Response(JSON.stringify({ data: { viewer: { email: 'dev@acme.com', name: 'Dev' } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch to ${href}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('OAuth callback clears reauth_required_at on reconnect', () => {
  it('re-auth of an existing account clears the flag after saving the tokens', async () => {
    hoisted.rows = {
      member: { id: 'm-1' },
      connected_account: { id: 'acct-existing' },
      user_oauth_tokens: { id: 'tok-existing' },
    }

    await callback()

    expect(hoisted.setReauthRequiredAt).toHaveBeenCalledTimes(1)
    expect(hoisted.setReauthRequiredAt).toHaveBeenCalledWith(expect.anything(), 'acct-existing', null)
  })

  it('a new account (starts NULL) does not call it', async () => {
    await callback()

    expect(hoisted.setReauthRequiredAt).not.toHaveBeenCalled()
  })

  it('a failed token save leaves the flag alone', async () => {
    hoisted.rows = {
      member: { id: 'm-1' },
      connected_account: { id: 'acct-existing' },
      user_oauth_tokens: { id: 'tok-existing' },
    }
    hoisted.tokenWriteError = { message: 'statement timeout' }

    await callback()

    expect(hoisted.setReauthRequiredAt).not.toHaveBeenCalled()
  })
})
