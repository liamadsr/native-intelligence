import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'

/**
 * Account-linking CSRF (security review 2026-10-31, P0-2). The attack: an
 * attacker, signed in as themselves, starts a connect, sends the provider
 * consent link to a victim, and the victim's provider tokens are stored under
 * the attacker's user_id. These run the REAL authorize, callback and claim
 * routes against a fake token endpoint and a recording Supabase.
 *
 * Covered:
 *   - an omitted or unknown `source` gets the enforced web binding (it used to
 *     default to 'app', the weak path);
 *   - a desktop callback never exchanges the code: it deep-links it back;
 *   - the claim refuses the wrong user, the wrong secret, a web state, and a
 *     missing claim hash; only the initiator with their secret completes;
 *   - an expired or unexpiring state is refused.
 */

const hoisted = vi.hoisted(() => ({
  sessionUserId: null as string | null,
  authUser: null as { id: string } | null,
  authVia: 'cookie' as 'cookie' | 'jwt' | 'device',
  tokenExchanges: 0,
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
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: hoisted.sessionUserId ? { id: hoisted.sessionUserId } : null } }) },
  }),
}))
vi.mock('@/lib/ai/auth', () => ({
  authenticateUser: async () => {
    if (!hoisted.authUser) throw new Response('{}', { status: 401 })
    // The authorize route's own membership check reads through this client.
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
    return { user: hoisted.authUser, supabase, via: hoisted.authVia }
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
const { POST: claim } = await import('../../claim/route')

const PARAMS = { params: Promise.resolve({ provider: 'linear' }) }

function sign(payload: Record<string, unknown>) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', process.env.OAUTH_STATE_SECRET!).update(b64).digest('base64url')
  return `${b64}.${sig}`
}

/** Start a connect as `userId` through the REAL authorize route. */
async function start(userId: string, source?: string) {
  hoisted.authUser = { id: userId }
  const qs = new URLSearchParams({ capability: 'tasks', ...(source !== undefined ? { source } : {}) })
  const res = await authorize(new Request(`https://dial8.ai/api/oauth/linear/authorize?${qs}`), PARAMS)
  expect(res.status).toBe(200)
  const setCookie = res.headers.get('set-cookie')
  // "name=value": what the starting browser sends back to the callback.
  const cookie = setCookie ? setCookie.split(';')[0] : undefined
  return { ...((await res.json()) as { url: string; state: string; claimSecret?: string }), cookie, setCookie }
}

function stateData(state: string) {
  return JSON.parse(Buffer.from(state.slice(0, state.lastIndexOf('.')), 'base64url').toString())
}

/** The provider redirecting the (victim's) browser back, with no Native Intelligence cookies. */
function providerReturn(state: string, cookie?: string) {
  return callback(
    new Request(`https://dial8.ai/api/oauth/linear/callback?code=victim-code&state=${encodeURIComponent(state)}`, {
      headers: cookie ? { cookie } : {},
    }),
    PARAMS,
  )
}

/** The sealed code the callback deep-links back for a desktop state (what the app would claim). */
async function sealedFor(state: string): Promise<string> {
  const res = await providerReturn(state)
  const sealed = new URL(res.headers.get('location')!).searchParams.get('sealed')
  expect(sealed).toBeTruthy()
  return sealed!
}

function claimAs(userId: string | null, body: Record<string, unknown>, via: 'cookie' | 'device' = 'cookie') {
  hoisted.authUser = userId ? { id: userId } : null
  hoisted.authVia = via
  return claim(
    new Request('https://dial8.ai/api/oauth/linear/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    PARAMS,
  )
}

beforeEach(() => {
  hoisted.sessionUserId = null
  hoisted.authUser = null
  hoisted.authVia = 'cookie'
  hoisted.tokenExchanges = 0
  hoisted.tokenRows = []
  vi.stubEnv('OAUTH_STATE_SECRET', 'state-secret')
  vi.stubEnv('LINEAR_CLIENT_ID', 'linear-client')
  vi.stubEnv('LINEAR_CLIENT_SECRET', 'linear-secret')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (href.includes('linear.app/oauth/token') || href.includes('api.linear.app/oauth/token')) {
      hoisted.tokenExchanges++
      return new Response(JSON.stringify({ access_token: 'victim-access', token_type: 'Bearer', scope: 'read' }))
    }
    if (href.includes('api.linear.app/graphql')) {
      return new Response(JSON.stringify({ data: { viewer: { email: 'victim@corp.com' } } }))
    }
    throw new Error(`unexpected fetch to ${href}`)
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('the authorize route picks the binding', () => {
  it('an omitted source is web: no claim secret, and the state says web', async () => {
    const started = await start('attacker')
    expect(started.claimSecret).toBeUndefined()
    expect(stateData(started.state).source).toBe('web')
    expect(typeof stateData(started.state).exp).toBe('number')
  })

  it("the retired 'app' source (and any unknown one) is web, never the weak path", async () => {
    for (const source of ['app', 'mobile', '']) {
      const started = await start('attacker', source)
      expect(stateData(started.state).source).toBe('web')
      expect(started.claimSecret).toBeUndefined()
    }
  })

  it('desktop gets a claim secret, and the state carries only its hash', async () => {
    const started = await start('alice', 'desktop')
    expect(started.claimSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    const data = stateData(started.state)
    expect(data.source).toBe('desktop')
    expect(data.claim).toBe(crypto.createHash('sha256').update(started.claimSecret!).digest('base64url'))
    expect(started.state).not.toContain(started.claimSecret!)
  })
})

describe('web: the victim completing an attacker-started connect', () => {
  it('omitted source: the victim has neither the attacker session nor the nonce cookie → refused, nothing stored', async () => {
    const started = await start('attacker') // no source: the old default path
    hoisted.sessionUserId = 'victim' // the victim's own browser session
    const res = await providerReturn(started.state)
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('csrf_validation_failed')
    expect(hoisted.tokenExchanges).toBe(0)
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('the browser that started it (its nonce cookie) connects', async () => {
    const started = await start('alice')
    expect(started.cookie).toMatch(/^oauth_nonce=/)
    const res = await providerReturn(started.state, started.cookie)
    expect(new URL(res.headers.get('location')!).searchParams.get('integration_success')).toBe('true')
    expect(hoisted.tokenRows).toHaveLength(1)
    expect(hoisted.tokenRows[0].user_id).toBe('alice')
  })

  it("a session alone never stands in for the cookie, even the state's own user (a subdomain could toss its owner's session)", async () => {
    const started = await start('attacker')
    hoisted.sessionUserId = 'attacker' // the attacker's session cookie, tossed into the victim's browser
    const res = await providerReturn(started.state)
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('csrf_validation_failed')
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('in production the nonce cookie is __Host- (no subdomain can plant one): Secure, Path=/, no Domain', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const started = await start('alice')
    expect(started.setCookie).toMatch(/^__Host-oauth_nonce=/)
    expect(started.setCookie).toMatch(/Secure/i)
    expect(started.setCookie).toMatch(/Path=\//)
    expect(started.setCookie).not.toMatch(/Domain=/i)
    // A plain-named copy (what a subdomain could set) is not the binding.
    const plain = started.cookie!.replace(/^__Host-/, '')
    expect(new URL((await providerReturn(started.state, plain)).headers.get('location')!).searchParams.get('error')).toBe(
      'csrf_validation_failed',
    )
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('a desktop connect sets no nonce cookie (its binding is the claim secret)', async () => {
    expect((await start('alice', 'desktop')).setCookie).toBeNull()
  })
})

describe('desktop: the callback never exchanges, and only the initiator can claim', () => {
  it('the callback deep-links the code back unexchanged and SEALED: the raw code never leaves the server', async () => {
    const started = await start('alice', 'desktop')
    const res = await providerReturn(started.state)
    const loc = res.headers.get('location')!
    expect(loc.startsWith('dial8desktop://oauth/complete?')).toBe(true)
    const link = new URL(loc)
    expect(link.searchParams.get('code')).toBeNull()
    expect(link.searchParams.get('sealed')).toBeTruthy()
    expect(loc).not.toContain('victim-code')
    expect(link.searchParams.get('state')).toBe(started.state)
    expect(link.searchParams.get('claimSecret')).toBeNull()
    expect(hoisted.tokenExchanges).toBe(0)
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('a sealed code opens only for its own flow: another flow\'s state, a raw code or a tampered blob is refused', async () => {
    const alice = await start('alice', 'desktop')
    const sealed = await sealedFor(alice.state)
    // Alice's second connect: her own session and secret, but another nonce.
    const second = await start('alice', 'desktop')
    expect((await claimAs('alice', { sealed, state: second.state, claimSecret: second.claimSecret })).status).toBe(400)
    // A raw code where the sealed one belongs.
    expect((await claimAs('alice', { sealed: 'victim-code', state: alice.state, claimSecret: alice.claimSecret })).status).toBe(400)
    // A flipped byte.
    const raw = Buffer.from(sealed, 'base64url')
    raw[raw.length - 1] ^= 1
    expect((await claimAs('alice', { sealed: raw.toString('base64url'), state: alice.state, claimSecret: alice.claimSecret })).status).toBe(400)
    expect(hoisted.tokenExchanges).toBe(0)
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('THE ATTACK: the victim\'s app gets the code but is signed in as the victim → refused', async () => {
    const started = await start('attacker', 'desktop')
    // The deep link lands on the VICTIM's machine; the victim's app claims it.
    const sealed = await sealedFor(started.state)
    const res = await claimAs('victim', { sealed, state: started.state, claimSecret: 'not-the-secret' })
    expect(res.status).toBe(403)
    expect(hoisted.tokenExchanges).toBe(0)
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('THE ATTACK: even holding the code, the attacker needs it delivered — and a guessed secret fails too', async () => {
    const started = await start('attacker', 'desktop')
    const sealed = await sealedFor(started.state)
    const res = await claimAs('attacker', { sealed, state: started.state, claimSecret: 'guessed' })
    expect(res.status).toBe(403)
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('the initiator, signed in, with their secret, connects', async () => {
    const started = await start('alice', 'desktop')
    const sealed = await sealedFor(started.state)
    const res = await claimAs('alice', { sealed, state: started.state, claimSecret: started.claimSecret })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, provider: 'linear', capability: 'tasks' })
    expect(hoisted.tokenExchanges).toBe(1)
    expect(hoisted.tokenRows[0].user_id).toBe('alice')
  })

  it('the right secret but another signed-in user → refused', async () => {
    const started = await start('alice', 'desktop')
    const sealed = await sealedFor(started.state)
    const res = await claimAs('mallory', { sealed, state: started.state, claimSecret: started.claimSecret })
    expect(res.status).toBe(403)
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('a device token, or no sign-in at all, never claims', async () => {
    const started = await start('alice', 'desktop')
    expect((await claimAs('alice', { sealed: 'c', state: started.state, claimSecret: started.claimSecret }, 'device')).status).toBe(401)
    expect((await claimAs(null, { sealed: 'c', state: started.state, claimSecret: started.claimSecret })).status).toBe(401)
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('a web state, or a desktop state without a claim hash, is never claimable', async () => {
    const web = await start('alice')
    expect((await claimAs('alice', { sealed: 'c', state: web.state, claimSecret: 'x' })).status).toBe(400)
    const noClaim = sign({ user_id: 'alice', capability: 'tasks', source: 'desktop', nonce: 'n', exp: Date.now() + 60_000 })
    expect((await claimAs('alice', { sealed: 'c', state: noClaim, claimSecret: 'x' })).status).toBe(400)
    // …and the callback refuses to hand such a state's code back at all.
    const res = await providerReturn(noClaim)
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('csrf_validation_failed')
    expect(hoisted.tokenRows).toHaveLength(0)
  })
})

describe('state expiry', () => {
  it('an expired state is refused by the callback and the claim', async () => {
    const expired = sign({ user_id: 'alice', capability: 'tasks', source: 'web', nonce: 'n', exp: Date.now() - 1 })
    hoisted.sessionUserId = 'alice'
    const res = await providerReturn(expired)
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('state_expired')
    const claimRes = await claimAs('alice', { sealed: 'c', state: expired, claimSecret: 'x' })
    expect(claimRes.status).toBe(400)
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('a state signed without an exp (pre-fix) is refused, not treated as live forever', async () => {
    const old = sign({ user_id: 'alice', capability: 'tasks', source: 'web', nonce: 'n' })
    hoisted.sessionUserId = 'alice'
    const res = await providerReturn(old)
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('state_expired')
    expect(hoisted.tokenRows).toHaveLength(0)
  })

  it('a tampered state fails the signature', async () => {
    const started = await start('attacker', 'desktop')
    const [b64, sig] = started.state.split('.')
    const forged = JSON.parse(Buffer.from(b64, 'base64url').toString())
    forged.user_id = 'victim'
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`
    const res = await claimAs('victim', { sealed: 'c', state: tampered, claimSecret: started.claimSecret })
    expect(res.status).toBe(400)
    expect(hoisted.tokenRows).toHaveLength(0)
  })
})
