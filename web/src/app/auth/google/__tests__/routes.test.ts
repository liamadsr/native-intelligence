/**
 * /auth/google → Google → /auth/google/callback, end to end through the real
 * flow code (src/lib/auth/google-sign-in.ts); Google's token endpoint and
 * Supabase's signInWithIdToken are stubbed.
 */
import { createHash, randomBytes } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type SignInResult = { data: { user: { email: string } | null }; error: { message: string } | null }
type IdTokenParams = { provider: string; token: string; access_token?: string; nonce?: string }

const hoisted = vi.hoisted(() => {
  const ok = (email: string): SignInResult => ({ data: { user: { email } }, error: null })
  return {
    ok,
    // The cookie client (web and admin).
    cookieSignIn: vi.fn(async (_p: IdTokenParams): Promise<SignInResult> => ok('ada@acme.com')),
    cookieSignOut: vi.fn(async (_o: { scope: string }) => ({ error: null })),
    // The desktop's client that keeps nothing.
    verifierSignIn: vi.fn(async (_p: IdTokenParams): Promise<SignInResult> => ok('ada@acme.com')),
    verifierSignOut: vi.fn(async (_o: { scope: string }) => ({ error: null as { message: string } | null })),
    verifierOptions: vi.fn((_o: unknown) => {}),
    generateLink: vi.fn(async ({ email }: { type: string; email: string }) => ({
      data: { properties: { hashed_token: `hash-for-${email}` } },
      error: null,
    })),
  }
})

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ auth: { admin: { generateLink: hoisted.generateLink } } }),
  isAuthorizedAdmin: (email: string | undefined) => email === 'liam@dial8.ai',
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signInWithIdToken: hoisted.cookieSignIn, signOut: hoisted.cookieSignOut } }),
}))
vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: (_url: string, _key: string, options: unknown) => {
    hoisted.verifierOptions(options)
    return { auth: { signInWithIdToken: hoisted.verifierSignIn, signOut: hoisted.verifierSignOut } }
  },
}))

import { GET as start } from '../route'
import { GET as callback } from '../callback/route'

const ORIGIN = 'https://dial8.ai'
const BIND = 'ab'.repeat(24)

/** Start a sign-in; returns what the browser would carry back. */
async function begin(query = '') {
  const res = await start(new NextRequest(`${ORIGIN}/auth/google${query}`))
  const authorize = new URL(res.headers.get('location')!)
  const setCookie = res.headers.get('set-cookie') ?? ''
  return { res, authorize, setCookie, cookie: setCookie.split(';')[0], state: authorize.searchParams.get('state')! }
}

function finish(cookie: string, query: string) {
  return callback(new NextRequest(`${ORIGIN}/auth/google/callback?${query}`, { headers: { cookie } }))
}

let fetchMock: ReturnType<typeof vi.fn>
let tokenResponse: () => Response

beforeAll(() => {
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
})

beforeEach(() => {
  vi.stubEnv('GOOGLE_SIGN_IN_CLIENT_ID', 'google-client.apps.googleusercontent.com')
  vi.stubEnv('GOOGLE_SIGN_IN_CLIENT_SECRET', 'google-secret')
  vi.stubEnv('GOOGLE_SIGN_IN_REDIRECT_URI', '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon')
  for (const m of [
    hoisted.cookieSignIn,
    hoisted.cookieSignOut,
    hoisted.verifierSignIn,
    hoisted.verifierSignOut,
    hoisted.verifierOptions,
    hoisted.generateLink,
  ]) {
    m.mockClear()
  }
  tokenResponse = () => new Response(JSON.stringify({ id_token: 'google-id-token', access_token: 'google-at' }))
  fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('GET /auth/google', () => {
  it('sends the browser to Google with a sealed one-time transaction', async () => {
    const { res, authorize, setCookie } = await begin()
    expect(res.status).toBe(307)
    expect(authorize.origin + authorize.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: 'google-client.apps.googleusercontent.com',
      redirect_uri: `${ORIGIN}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    })
    // Google is sent the nonce's hash, never the raw value.
    expect(authorize.searchParams.get('nonce')).toMatch(/^[0-9a-f]{64}$/)
    expect(authorize.searchParams.get('hd')).toBeNull()
    expect(setCookie).toMatch(/^google_auth_tx=v1\./)
    expect(setCookie).toMatch(/Path=\/auth\/google/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=lax/i)
    expect(setCookie).toMatch(/Secure/i)
  })

  it('asks for a dial8.ai account for the admin panel', async () => {
    const { authorize } = await begin('?admin=1')
    expect(authorize.searchParams.get('hd')).toBe('dial8.ai')
  })

  it('moves the browser to the callback host before setting the cookie', async () => {
    vi.stubEnv('GOOGLE_SIGN_IN_REDIRECT_URI', 'https://dial8.ai/auth/google/callback')
    const res = await start(
      new NextRequest(`https://www.dial8.ai/auth/google?desktop=1&bind=${BIND}`, { headers: { host: 'www.dial8.ai' } }),
    )
    expect(res.headers.get('location')).toBe(`https://dial8.ai/auth/google?desktop=1&bind=${BIND}`)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('refuses a desktop start without a valid bind, and does nothing when unconfigured', async () => {
    const res = await start(new NextRequest(`${ORIGIN}/auth/google?desktop=1&bind=nope`))
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=auth_failed`)
    vi.stubEnv('GOOGLE_SIGN_IN_CLIENT_SECRET', '')
    expect((await start(new NextRequest(`${ORIGIN}/auth/google`))).headers.get('location')).toBe(`${ORIGIN}/login`)
    expect((await start(new NextRequest(`${ORIGIN}/auth/google?admin=1`))).headers.get('location')).toBe(
      `${ORIGIN}/admin/login`,
    )
  })
})

describe('GET /auth/google/callback', () => {
  it('signs the web in with Google’s ID token and clears the transaction', async () => {
    const { cookie, state, authorize } = await begin()
    const res = await finish(cookie, `code=c1&state=${state}`)

    expect(res.headers.get('location')).toBe(`${ORIGIN}/account`)
    expect(res.headers.get('set-cookie')).toMatch(/google_auth_tx=;.*Max-Age=0/i)
    // The code exchange: PKCE verifier matching the challenge, the client's secret.
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    const form = new URLSearchParams(String(init!.body))
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'c1',
      redirect_uri: `${ORIGIN}/auth/google/callback`,
      client_id: 'google-client.apps.googleusercontent.com',
      client_secret: 'google-secret',
    })
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
      authorize.searchParams.get('code_challenge'),
    )
    // Supabase gets the raw nonce (it hashes it and compares with what Google was sent).
    const [params] = hoisted.cookieSignIn.mock.calls[0]
    expect(params).toMatchObject({ provider: 'google', token: 'google-id-token', access_token: 'google-at' })
    expect(createHash('sha256').update(params.nonce!).digest('hex')).toBe(authorize.searchParams.get('nonce'))
    expect(hoisted.verifierSignIn).not.toHaveBeenCalled()
  })

  it('follows the redirect cookies the login form left', async () => {
    const { cookie, state } = await begin()
    const res = await finish(`${cookie}; share_redirect=${encodeURIComponent('/s/tok')}`, `code=c1&state=${state}`)
    expect(res.headers.get('location')).toBe(`${ORIGIN}/s/tok`)
  })

  it('hands the desktop a bound one-time token and ends the interim session', async () => {
    const { cookie, state } = await begin(`?desktop=1&bind=${BIND}`)
    const res = await finish(cookie, `code=c1&state=${state}`)
    const html = await res.text()

    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(html).toContain(`dial8desktop://auth/callback?token_hash=hash-for-ada%40acme.com&amp;bind=${BIND}`)
    expect(hoisted.verifierOptions).toHaveBeenCalledWith({
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    expect(hoisted.verifierSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', token: 'google-id-token', access_token: 'google-at' }),
    )
    expect(hoisted.verifierSignOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(hoisted.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'ada@acme.com' })
    expect(hoisted.cookieSignIn).not.toHaveBeenCalled()
  })

  it('ends the interim session even when the account has no address to sign in', async () => {
    hoisted.verifierSignIn.mockResolvedValueOnce({ data: { user: { email: '' } }, error: null })
    const { cookie, state } = await begin(`?desktop=1&bind=${BIND}`)
    const html = await (await finish(cookie, `code=c1&state=${state}`)).text()
    expect(html).toContain('dial8desktop://auth/callback?error=auth_failed')
    expect(hoisted.verifierSignOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(hoisted.generateLink).not.toHaveBeenCalled()
  })

  it('lands an admin on /admin, and signs anyone else straight back out', async () => {
    hoisted.cookieSignIn.mockResolvedValueOnce(hoisted.ok('liam@dial8.ai'))
    let { cookie, state } = await begin('?admin=1')
    expect((await finish(cookie, `code=c1&state=${state}`)).headers.get('location')).toBe(`${ORIGIN}/admin`)
    expect(hoisted.cookieSignOut).not.toHaveBeenCalled()

    ;({ cookie, state } = await begin('?admin=1'))
    const res = await finish(cookie, `code=c1&state=${state}`)
    expect(res.headers.get('location')).toBe(`${ORIGIN}/admin/login?error=unauthorized_domain`)
    expect(hoisted.cookieSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('names a signup the work-email hook refused, on the web and the desktop', async () => {
    const refused: SignInResult = {
      data: { user: null },
      error: { message: "Native Intelligence requires a business email to sign up. Personal addresses like Gmail or Yahoo aren't accepted." },
    }
    hoisted.cookieSignIn.mockResolvedValueOnce(refused)
    let { cookie, state } = await begin()
    expect((await finish(cookie, `code=c1&state=${state}`)).headers.get('location')).toBe(
      `${ORIGIN}/login?error=work_email_required`,
    )

    hoisted.verifierSignIn.mockResolvedValueOnce(refused)
    ;({ cookie, state } = await begin(`?desktop=1&bind=${BIND}`))
    const html = await (await finish(cookie, `code=c1&state=${state}`)).text()
    expect(html).toContain('dial8desktop://auth/callback?error=work_email_required')
    expect(hoisted.generateLink).not.toHaveBeenCalled()
  })

  it('refuses a mismatched state or a missing transaction before any exchange', async () => {
    const { cookie } = await begin()
    expect((await finish(cookie, 'code=c1&state=forged')).headers.get('location')).toBe(`${ORIGIN}/login?error=auth_failed`)
    expect((await finish('', 'code=c1&state=x')).headers.get('location')).toBe(`${ORIGIN}/login?error=auth_failed`)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(hoisted.cookieSignIn).not.toHaveBeenCalled()
  })

  it('names a declined consent, and fails a refused code exchange', async () => {
    let { cookie, state } = await begin()
    expect((await finish(cookie, `error=access_denied&state=${state}`)).headers.get('location')).toBe(
      `${ORIGIN}/login?error=google_declined`,
    )

    tokenResponse = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    ;({ cookie, state } = await begin('?admin=1'))
    expect((await finish(cookie, `code=c1&state=${state}`)).headers.get('location')).toBe(
      `${ORIGIN}/admin/login?error=auth_failed`,
    )
    expect(hoisted.cookieSignIn).not.toHaveBeenCalled()
  })
})
