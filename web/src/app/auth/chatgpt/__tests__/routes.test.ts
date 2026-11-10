/**
 * /auth/chatgpt → OpenAI → /auth/chatgpt/callback, end to end through the
 * real OAuth code (src/lib/chatgpt); only OpenAI's token endpoint and JWKS
 * are stubbed, with an ID token signed by a local key.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeService, type FakeService } from '@/lib/chatgpt/__tests__/fake-service'

const hoisted = vi.hoisted(() => ({
  svc: null as unknown as FakeService,
  verifyOtp: vi.fn(async (_p: { token_hash: string; type: string }) => ({ error: null as { message: string } | null })),
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.svc.client }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { verifyOtp: hoisted.verifyOtp } }) }))

import { GET as start } from '../route'
import { GET as callback } from '../callback/route'
import { resetJwksCacheForTests } from '@/lib/chatgpt/oidc'

const ORIGIN = 'https://nativeintelligence.dev'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }

function idToken(nonce: string, claims: Record<string, unknown> = {}) {
  const nowS = Math.floor(Date.now() / 1000)
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url')
  const p = Buffer.from(
    JSON.stringify({
      iss: 'https://auth.openai.com',
      aud: 'oaiapp_partner',
      sub: 'chatgpt-sub',
      iat: nowS,
      exp: nowS + 3600,
      nonce,
      email: 'ada@acme.com',
      email_verified: true,
      name: 'Ada',
      ...claims,
    }),
  ).toString('base64url')
  return `${h}.${p}.${sign('sha256', new TextEncoder().encode(`${h}.${p}`), privateKey).toString('base64url')}`
}

/** Start a sign-in; returns what the browser would carry back. */
async function begin(query = '') {
  const res = await start(new NextRequest(`${ORIGIN}/auth/chatgpt${query}`))
  const authorize = new URL(res.headers.get('location')!)
  const setCookie = res.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]
  return { res, authorize, setCookie, cookie, state: authorize.searchParams.get('state')!, nonce: authorize.searchParams.get('nonce')! }
}

function finish(cookie: string, query: string) {
  return callback(new NextRequest(`${ORIGIN}/auth/chatgpt/callback?${query}`, { headers: { cookie } }))
}

let fetchMock: ReturnType<typeof vi.fn>
let tokenBody: Record<string, unknown>

beforeAll(() => {
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
})

beforeEach(() => {
  vi.stubEnv('CHATGPT_CLIENT_ID', 'oaiapp_partner')
  vi.stubEnv('CHATGPT_CLIENT_SECRET', 'secret')
  vi.stubEnv('CHATGPT_DEV_HOST_ID', '')
  vi.stubEnv('CHATGPT_REDIRECT_URI', '')
  hoisted.svc = fakeService()
  hoisted.verifyOtp.mockClear()
  resetJwksCacheForTests()
  tokenBody = {}
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/jwks.json')) return new Response(JSON.stringify({ keys: [jwk] }))
    return new Response(JSON.stringify(tokenBody))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('GET /auth/chatgpt', () => {
  it('sends the browser to OpenAI with a sealed one-time transaction', async () => {
    const { res, authorize, setCookie } = await begin()
    expect(res.status).toBe(307)
    expect(authorize.origin + authorize.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/chatgpt/callback`)
    expect(setCookie).toMatch(/^chatgpt_auth_tx=v1\./)
    expect(setCookie).toMatch(/Path=\/auth\/chatgpt/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=lax/i)
    expect(setCookie).toMatch(/Secure/i)
  })

  it('moves the browser to the callback host before setting the cookie', async () => {
    vi.stubEnv('CHATGPT_REDIRECT_URI', 'http://127.0.0.1:3002/auth/chatgpt/callback')
    const res = await start(
      new NextRequest('http://localhost:3002/auth/chatgpt?desktop=1&bind=' + 'cd'.repeat(24), {
        headers: { host: 'localhost:3002' },
      }),
    )
    expect(res.headers.get('location')).toBe(`http://127.0.0.1:3002/auth/chatgpt?desktop=1&bind=${'cd'.repeat(24)}`)
    expect(res.headers.get('set-cookie')).toBeNull()

    const same = await start(new NextRequest('http://localhost:3002/auth/chatgpt', { headers: { host: '127.0.0.1:3002' } }))
    expect(same.headers.get('location')).toMatch(/^https:\/\/auth\.openai\.com\//)
    expect(same.headers.get('set-cookie')).toMatch(/^chatgpt_auth_tx=/)
  })

  it('refuses a desktop start without a valid bind, and does nothing when unconfigured', async () => {
    const res = await start(new NextRequest(`${ORIGIN}/auth/chatgpt?desktop=1&bind=nope`))
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=auth_failed`)
    vi.stubEnv('CHATGPT_CLIENT_ID', '')
    expect((await start(new NextRequest(`${ORIGIN}/auth/chatgpt`))).headers.get('location')).toBe(`${ORIGIN}/login`)
  })
})

describe('GET /auth/chatgpt/callback', () => {
  it('signs the web in, stores the connection and clears the transaction', async () => {
    const { cookie, state, nonce } = await begin()
    tokenBody = { access_token: 'at', refresh_token: 'rt', id_token: idToken(nonce), expires_in: 3600, scope: 'openid email chatgpt.tokens.use.direct' }
    const res = await finish(cookie, `code=c1&state=${state}`)

    expect(res.headers.get('location')).toBe(`${ORIGIN}/account`)
    expect(hoisted.verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash-for-ada@acme.com', type: 'magiclink' })
    expect(res.headers.get('set-cookie')).toMatch(/chatgpt_auth_tx=;.*Max-Age=0/i)
    const [conn] = [...hoisted.svc.rows.values()]
    expect(conn).toMatchObject({ subject: 'chatgpt-sub', client_id: 'oaiapp_partner', plan_enabled: true, status: 'active' })
    expect(hoisted.svc.calls.createUser[0]).toMatchObject({ email: 'ada@acme.com', email_confirm: true })
    // The code exchange carried resource (plan usage needs it).
    const tokenCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/oauth/token'))!
    expect(new URLSearchParams(String((tokenCall[1] as RequestInit).body)).get('resource')).toBe('https://api.openai.com/v1')
  })

  it('hands the desktop a bound one-time token on its deep link', async () => {
    const bind = 'ab'.repeat(24)
    const { cookie, state, nonce } = await begin(`?desktop=1&bind=${bind}`)
    tokenBody = { access_token: 'at', refresh_token: 'rt', id_token: idToken(nonce), expires_in: 3600, scope: 'openid' }
    const res = await finish(cookie, `code=c1&state=${state}`)
    const html = await res.text()
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(html).toContain(`dial8desktop://auth/callback?token_hash=hash-for-ada%40acme.com&amp;bind=${bind}`)
    expect(hoisted.verifyOtp).not.toHaveBeenCalled()
  })

  it('refuses a mismatched state or a missing transaction before any exchange', async () => {
    const { cookie } = await begin()
    expect((await finish(cookie, 'code=c1&state=forged')).headers.get('location')).toBe(`${ORIGIN}/login?error=auth_failed`)
    expect((await finish('', 'code=c1&state=x')).headers.get('location')).toBe(`${ORIGIN}/login?error=auth_failed`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names a declined consent', async () => {
    const { cookie, state } = await begin()
    const res = await finish(cookie, `error=access_denied&state=${state}`)
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=chatgpt_declined`)
  })

  it('refuses an ID token with the wrong nonce, and an unverified email', async () => {
    let { cookie, state } = await begin()
    tokenBody = { access_token: 'at', id_token: idToken('someone-elses-nonce'), expires_in: 3600 }
    expect((await finish(cookie, `code=c1&state=${state}`)).headers.get('location')).toBe(`${ORIGIN}/login?error=auth_failed`)

    let nonce
    ;({ cookie, state, nonce } = await begin())
    tokenBody = { access_token: 'at', id_token: idToken(nonce, { email_verified: false }), expires_in: 3600 }
    expect((await finish(cookie, `code=c1&state=${state}`)).headers.get('location')).toBe(`${ORIGIN}/login?error=unverified_email`)
    expect(hoisted.verifyOtp).not.toHaveBeenCalled()
  })
})
