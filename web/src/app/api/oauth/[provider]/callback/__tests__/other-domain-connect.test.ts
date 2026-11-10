import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'

/**
 * A web connect begun on the app's OTHER domain. The hosted app answers on two
 * domains while it moves, and each provider knows one callback, on the app's
 * address (`NEXT_PUBLIC_APP_URL`). The browser that started on the other domain
 * holds its nonce cookie there, so the callback on the app's address hands the
 * provider's answer over, unspent, to the domain the connect began on.
 *
 * These run the REAL authorize and callback routes against a fake token
 * endpoint and a recording Supabase, once for each direction of the move.
 */

const hoisted = vi.hoisted(() => ({
  authUser: null as { id: string } | null,
  tokenBodies: [] as string[],
  tokenRows: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/oauth/token-manager', () => ({ setReauthRequiredAt: vi.fn(async () => {}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/email/gmail-watch', () => ({ setupGmailWatch: vi.fn() }))
vi.mock('@/lib/email/outlook-webhook', () => ({ setupOutlookSubscription: vi.fn() }))
vi.mock('@/lib/email/account-scope', () => ({ reconcileThreadCopies: vi.fn() }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}))
vi.mock('@/lib/ai/auth', () => ({
  authenticateUser: async () => {
    if (!hoisted.authUser) throw new Response('{}', { status: 401 })
    const supabase = {
      from: () => {
        const api: Record<string, unknown> = {
          select: () => api,
          eq: () => api,
          maybeSingle: async () => ({ data: { id: 'm-1' }, error: null }),
        }
        return api
      },
    }
    return { user: hoisted.authUser, supabase, via: 'cookie' }
  },
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      let pendingInsert: Record<string, unknown> | null = null
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        is: () => api,
        limit: () => api,
        upsert: () => api,
        update: () => api,
        insert: (row: Record<string, unknown>) => {
          if (table === 'user_oauth_tokens') pendingInsert = row
          return api
        },
        single: async () => ({ data: { id: 'acct-new' }, error: null }),
        maybeSingle: async () => ({ data: table === 'member' ? { id: 'm-1' } : null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (pendingInsert) hoisted.tokenRows.push(pendingInsert)
          pendingInsert = null
          return Promise.resolve({ data: null, error: null, count: 0 }).then(resolve)
        },
      }
      return api
    },
  }),
}))

// The connect stores its tokens encrypted (src/lib/oauth/token-crypto.ts).
process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')

const { GET: authorize } = await import('../../authorize/route')
const { GET: callback } = await import('../route')

const PARAMS = { params: Promise.resolve({ provider: 'linear' }) }

function sign(payload: Record<string, unknown>) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', process.env.OAUTH_STATE_SECRET!).update(b64).digest('base64url')
  return `${b64}.${sig}`
}

function stateData(state: string) {
  return JSON.parse(Buffer.from(state.slice(0, state.lastIndexOf('.')), 'base64url').toString())
}

/** Start a connect as `userId` from a page on `origin`, through the REAL authorize route. */
async function startOn(origin: string, userId: string, query: Record<string, string> = {}) {
  hoisted.authUser = { id: userId }
  const qs = new URLSearchParams({ capability: 'tasks', ...query })
  const res = await authorize(new Request(`${origin}/api/oauth/linear/authorize?${qs}`), PARAMS)
  expect(res.status).toBe(200)
  const setCookie = res.headers.get('set-cookie')
  // "name=value": what the starting browser sends back, to this origin only.
  const cookie = setCookie ? setCookie.split(';')[0] : undefined
  return { ...((await res.json()) as { url: string; state: string }), cookie }
}

/** A request to the callback on `origin`, with whatever the browser holds for that origin. */
function callbackOn(origin: string, query: string, cookie?: string) {
  return callback(new Request(`${origin}/api/oauth/linear/callback?${query}`, { headers: cookie ? { cookie } : {} }), PARAMS)
}

const answer = (state: string) => `code=the-code&state=${encodeURIComponent(state)}`
const location = (res: Response) => new URL(res.headers.get('location')!)

beforeEach(() => {
  hoisted.authUser = null
  hoisted.tokenBodies = []
  hoisted.tokenRows = []
  vi.stubEnv('OAUTH_STATE_SECRET', 'state-secret')
  vi.stubEnv('LINEAR_CLIENT_ID', 'linear-client')
  vi.stubEnv('LINEAR_CLIENT_SECRET', 'linear-secret')
  vi.stubEnv('OAUTH_REDIRECT_BASE_URL', '')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (href.includes('linear.app/oauth/token')) {
      hoisted.tokenBodies.push(String(init?.body))
      return new Response(JSON.stringify({ access_token: 'access', token_type: 'Bearer', scope: 'read' }))
    }
    if (href.includes('api.linear.app/graphql')) {
      return new Response(JSON.stringify({ data: { viewer: { email: 'someone@example.com' } } }))
    }
    throw new Error(`unexpected fetch to ${href}`)
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

// Both directions of the move: today the app's address is the old domain and
// people may arrive on the new one; after the setting moves it is the reverse.
describe.each([
  { setting: 'https://dial8.ai', other: 'https://nativeintelligence.dev' },
  { setting: 'https://nativeintelligence.dev', other: 'https://dial8.ai' },
  { setting: 'https://dial8.ai', other: 'https://www.dial8.ai' },
])('the app at $setting, a connect begun on $other', ({ setting, other }) => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', setting)
  })

  it('still sends the provider the one registered callback, and the state says where it began', async () => {
    const started = await startOn(other, 'alice')
    expect(new URL(started.url).searchParams.get('redirect_uri')).toBe(`${setting}/api/oauth/linear/callback`)
    expect(stateData(started.state).origin).toBe(other)
    expect(started.cookie).toMatch(/^oauth_nonce=/)
  })

  it('the callback on the app address hands the answer over unspent; the domain it began on finishes it and returns there', async () => {
    const started = await startOn(other, 'alice', { redirect: '/oauth-popup-callback' })

    // The provider sends the browser to the registered callback. The nonce
    // cookie belongs to the other domain, so the browser sends none here.
    const first = await callbackOn(setting, answer(started.state))
    expect(first.status).toBeGreaterThanOrEqual(300)
    expect(first.status).toBeLessThan(400)
    const handed = location(first)
    expect(handed.origin).toBe(other)
    expect(handed.pathname).toBe('/api/oauth/linear/callback')
    expect(handed.searchParams.get('code')).toBe('the-code')
    expect(handed.searchParams.get('state')).toBe(started.state)
    expect(handed.searchParams.get('handed')).toBe('1')
    expect(hoisted.tokenBodies).toHaveLength(0)
    expect(hoisted.tokenRows).toHaveLength(0)

    // The browser follows it to the domain it began on, cookie attached.
    const second = await callbackOn(other, handed.search.slice(1), started.cookie)
    const done = location(second)
    expect(done.origin).toBe(other)
    expect(done.pathname).toBe('/oauth-popup-callback')
    expect(done.searchParams.get('integration_success')).toBe('true')
    expect(hoisted.tokenRows).toHaveLength(1)
    expect(hoisted.tokenRows[0].user_id).toBe('alice')
    // The exchange names the same redirect_uri the authorize step sent.
    expect(hoisted.tokenBodies).toHaveLength(1)
    expect(new URLSearchParams(hoisted.tokenBodies[0]).get('redirect_uri')).toBe(`${setting}/api/oauth/linear/callback`)
  })

  it('the handed answer is still refused for a browser without the nonce cookie, and the refusal lands where it began', async () => {
    const started = await startOn(other, 'attacker')
    const handed = location(await callbackOn(setting, answer(started.state)))
    const res = await callbackOn(other, handed.search.slice(1))
    expect(location(res).origin).toBe(other)
    expect(location(res).searchParams.get('error')).toBe('csrf_validation_failed')
    expect(hoisted.tokenBodies).toHaveLength(0)
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('an answer is handed over once: a handed one on the wrong domain is judged there, never bounced again', async () => {
    const started = await startOn(other, 'alice')
    const res = await callbackOn(setting, `${answer(started.state)}&handed=1`)
    expect(location(res).pathname).not.toBe('/api/oauth/linear/callback')
    expect(location(res).searchParams.get('error')).toBe('csrf_validation_failed')
    expect(hoisted.tokenBodies).toHaveLength(0)
  })

  it("the provider's refusal is handed over too, so the person lands back on the page they began on", async () => {
    const started = await startOn(other, 'alice')
    const first = await callbackOn(setting, `error=access_denied&state=${encodeURIComponent(started.state)}`)
    const handed = location(first)
    expect(handed.origin).toBe(other)
    expect(handed.searchParams.get('error')).toBe('access_denied')
    const res = await callbackOn(other, handed.search.slice(1), started.cookie)
    expect(location(res).origin).toBe(other)
    expect(location(res).pathname).toBe('/account/settings/connectors')
    expect(location(res).searchParams.get('error')).toBe('access_denied')
  })

  it('a connect begun on the app address is not handed anywhere', async () => {
    const started = await startOn(setting, 'alice')
    expect(stateData(started.state).origin).toBeUndefined()
    const res = await callbackOn(setting, answer(started.state), started.cookie)
    expect(location(res).origin).toBe(setting)
    expect(location(res).searchParams.get('integration_success')).toBe('true')
    expect(hoisted.tokenRows).toHaveLength(1)
  })

  it('a desktop connect is never handed over: its answer goes back to the app by deep link', async () => {
    const started = await startOn(other, 'alice', { source: 'desktop' })
    expect(stateData(started.state).origin).toBeUndefined()
    const res = await callbackOn(setting, answer(started.state))
    expect(res.headers.get('location')).toMatch(/^dial8desktop:\/\/oauth\/complete\?/)
  })
})

describe('only the app’s own page origins are ever a place to hand an answer to', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
  })

  it.each([
    'https://nativeintelligence.dev.evil.example',
    'https://evil-nativeintelligence.dev',
    'https://docs.nativeintelligence.dev',
    'https://browser-relay.nativeintelligence.dev',
    'https://dial8.ai.evil.example',
    'https://app.dial8.ai',
    'https://preview-abc123.vercel.app',
    'http://nativeintelligence.dev',
    'http://localhost:3000',
  ])('a connect begun on %s records no origin', async (origin) => {
    const started = await startOn(origin, 'alice')
    expect(stateData(started.state).origin).toBeUndefined()
  })

  it('a forwarded host decides where it began, as it decides the same-origin check', async () => {
    hoisted.authUser = { id: 'alice' }
    const res = await authorize(
      new Request('https://internal.example/api/oauth/linear/authorize?capability=tasks', {
        headers: { 'x-forwarded-host': 'nativeintelligence.dev', 'x-forwarded-proto': 'https' },
      }),
      PARAMS,
    )
    const { state } = (await res.json()) as { state: string }
    expect(stateData(state).origin).toBe('https://nativeintelligence.dev')
  })

  it.each([
    'https://evil.example',
    'https://nativeintelligence.dev.evil.example',
    'https://docs.nativeintelligence.dev',
    'http://nativeintelligence.dev',
    'https://nativeintelligence.dev/',
    'https://nativeintelligence.dev@evil.example',
  ])('a signed state naming %s is not followed', async (origin) => {
    const state = sign({ nonce: 'n-1', user_id: 'alice', capability: 'tasks', source: 'web', exp: Date.now() + 60_000, origin })
    const res = await callbackOn('https://dial8.ai', answer(state), 'oauth_nonce=n-1')
    const to = location(res)
    expect(to.origin).toBe('https://dial8.ai')
    expect(to.pathname).toBe('/account/settings/connectors')
  })

  it('a state whose signature does not match is refused before any hand-over', async () => {
    const good = sign({ nonce: 'n-1', user_id: 'alice', capability: 'tasks', source: 'web', exp: Date.now() + 60_000, origin: 'https://nativeintelligence.dev' })
    const forged = `${Buffer.from(JSON.stringify({ ...stateData(good), origin: 'https://www.nativeintelligence.dev' })).toString('base64url')}.${good.slice(good.lastIndexOf('.') + 1)}`
    const res = await callbackOn('https://dial8.ai', answer(forged))
    expect(location(res).origin).toBe('https://dial8.ai')
    expect(location(res).pathname).toBe('/account/settings/connectors')
    expect(location(res).searchParams.get('error')).toBeTruthy()
  })
})
