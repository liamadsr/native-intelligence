import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const m = vi.hoisted(() => ({
  exchange: vi.fn(async (_code: string) => ({ error: null as { code?: string; message: string } | null })),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { exchangeCodeForSession: m.exchange } }) }))

const { GET, HEAD } = await import('../route')

/**
 * GET /auth/confirm, where every Supabase Auth email links. It makes the hop
 * to Supabase's verify endpoint from the server and passes its redirect on,
 * so the browser lands on the page the sign-in asked for, with the PKCE code,
 * and never visits supabase.co.
 */

const HASH = 'pkce_0123456789abcdef0123456789abcdef0123456789abcdef01234567'
const SUPABASE = 'https://project.supabase.co'

function request(query: Record<string, string>, headers?: Record<string, string>) {
  const url = new URL('https://dial8.ai/auth/confirm')
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return new NextRequest(url, headers ? { headers } : undefined)
}
const location = (res: Response) => res.headers.get('location')
const redirect = (to: string) => new Response(null, { status: 303, headers: { location: to } })
const fetchMock = vi.fn<typeof fetch>()
/** The verify call's URL, as Supabase's query fields. */
const verifyCall = (n = 0): Record<string, string> => {
  const url = new URL(String(fetchMock.mock.calls[n][0]))
  return { endpoint: `${url.origin}${url.pathname}`, ...Object.fromEntries(url.searchParams) }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  m.exchange.mockReset().mockResolvedValue({ error: null })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('GET /auth/confirm', () => {
  it("asks Supabase's verify endpoint from the server and passes the PKCE code on", async () => {
    for (const [type, redirectTo] of [
      ['magiclink', 'https://dial8.ai/auth/callback'],
      ['signup', 'https://dial8.ai/auth/callback'],
      ['magiclink', 'https://dial8.ai/auth/desktop-callback'],
    ]) {
      fetchMock.mockReset().mockResolvedValue(redirect(`${redirectTo}?code=abc`))
      const res = await GET(request({ token_hash: HASH, type, redirect_to: redirectTo }))
      expect(location(res), type).toBe(`${redirectTo}?code=abc`)
      expect(verifyCall(), type).toEqual({
        endpoint: `${SUPABASE}/auth/v1/verify`,
        token: HASH,
        type,
        redirect_to: redirectTo,
      })
      expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual')
    }
  })

  it("exchanges a reset link's code here, with this browser's verifier, and opens the reset page", async () => {
    fetchMock.mockResolvedValue(redirect('https://dial8.ai/reset-password?code=abc'))
    const res = await GET(request({ token_hash: HASH, type: 'recovery', redirect_to: 'https://dial8.ai/reset-password' }))
    expect(verifyCall()).toMatchObject({ type: 'recovery', redirect_to: 'https://dial8.ai/reset-password' })
    expect(m.exchange).toHaveBeenCalledWith('abc')
    expect(location(res)).toBe('https://dial8.ai/reset-password')
  })

  it('keeps the reset page shut for a reset code this browser cannot redeem, or a spent link', async () => {
    fetchMock.mockResolvedValue(redirect('https://dial8.ai/reset-password?code=abc'))
    m.exchange.mockResolvedValue({ error: { code: 'pkce_code_verifier_not_found', message: 'PKCE code verifier not found' } })
    expect(location(await GET(request({ token_hash: HASH, type: 'recovery' })))).toBe(
      'https://dial8.ai/reset-password?error=auth_failed',
    )

    fetchMock.mockResolvedValue(redirect('https://dial8.ai/reset-password?error=access_denied&error_code=otp_expired'))
    expect(location(await GET(request({ token_hash: HASH, type: 'recovery' })))).toBe(
      'https://dial8.ai/reset-password?error=link_expired',
    )
    expect(m.exchange).toHaveBeenCalledTimes(1)
  })

  it('hands the browser the code, never the token', async () => {
    fetchMock.mockResolvedValue(redirect('https://dial8.ai/auth/callback?code=abc'))
    const res = await GET(request({ token_hash: HASH, type: 'magiclink', redirect_to: 'https://dial8.ai/auth/callback' }))
    expect(location(res)).not.toContain(HASH)
  })

  it('works on the host the browser used (behind a proxy, or a dev server on another port)', async () => {
    fetchMock.mockResolvedValue(redirect('http://localhost:3001/auth/callback?code=abc'))
    const res = await GET(
      request(
        { token_hash: HASH, type: 'magiclink', redirect_to: 'http://localhost:3001/auth/callback' },
        { 'x-forwarded-host': 'localhost:3001', 'x-forwarded-proto': 'http' },
      ),
    )
    expect(verifyCall().redirect_to).toBe('http://localhost:3001/auth/callback')
    expect(location(res)).toBe('http://localhost:3001/auth/callback?code=abc')
  })

  it("passes Supabase's own failure on to the page, which names it", async () => {
    const spent = 'https://dial8.ai/auth/callback?error=access_denied&error_code=otp_expired'
    fetchMock.mockResolvedValue(redirect(`${spent}#error=access_denied`))
    expect(location(await GET(request({ token_hash: HASH, type: 'magiclink', redirect_to: 'https://dial8.ai/auth/callback' })))).toBe(spent)
  })

  it('lands a link without a redirect of its own where its type does', async () => {
    fetchMock.mockResolvedValue(redirect('https://dial8.ai/reset-password?code=abc'))
    await GET(request({ token_hash: HASH, type: 'recovery' }))
    expect(verifyCall().redirect_to).toBe('https://dial8.ai/reset-password')

    fetchMock.mockResolvedValue(redirect('https://dial8.ai/auth/callback?code=abc'))
    await GET(request({ token_hash: HASH, type: 'signup', redirect_to: 'not a url' }))
    expect(verifyCall(1).redirect_to).toBe('https://dial8.ai/auth/callback')
  })

  it('never asks Supabase to send the code to another origin', async () => {
    for (const elsewhere of ['https://evil.example/auth/callback', 'http://dial8.ai/auth/callback', 'https://dial8.ai.evil.example/auth/callback']) {
      fetchMock.mockReset().mockResolvedValue(redirect('https://dial8.ai/auth/callback?code=abc'))
      await GET(request({ token_hash: HASH, type: 'magiclink', redirect_to: elsewhere }))
      expect(verifyCall().redirect_to, elsewhere).toBe('https://dial8.ai/auth/callback')
    }
  })

  it('follows Supabase nowhere but the target, and never hands the browser a fragment', async () => {
    const desktop = { token_hash: HASH, type: 'magiclink', redirect_to: 'https://dial8.ai/auth/desktop-callback' }
    fetchMock.mockResolvedValue(redirect('https://dial8.ai/auth/desktop-callback#access_token=secret'))
    expect(location(await GET(request(desktop)))).toBe('https://dial8.ai/auth/desktop-callback')

    for (const elsewhere of ['https://dial8.ai/', 'https://dial8.ai/auth/callback?code=abc', 'https://evil.example/auth/desktop-callback?code=abc', `${SUPABASE}/auth/v1/verify`]) {
      fetchMock.mockResolvedValue(redirect(elsewhere))
      expect(location(await GET(request(desktop))), elsewhere).toBe('https://dial8.ai/auth/desktop-callback?error=auth_failed')
    }
  })

  it('fails to the target when Supabase answers without a redirect or is unreachable', async () => {
    const web = { token_hash: HASH, type: 'magiclink', redirect_to: 'https://dial8.ai/auth/callback' }
    // 429: Supabase's verification rate limit, answered before the token is spent.
    for (const status of [400, 429]) {
      fetchMock.mockResolvedValue(new Response('{}', { status }))
      expect(location(await GET(request(web))), String(status)).toBe('https://dial8.ai/auth/callback?error=auth_failed')
    }
    fetchMock.mockRejectedValue(new Error('offline'))
    expect(location(await GET(request({ ...web, type: 'recovery', redirect_to: 'https://dial8.ai/reset-password' })))).toBe(
      'https://dial8.ai/reset-password?error=auth_failed',
    )
  })

  it('refuses a missing or malformed token, or an unknown type, before calling Supabase', async () => {
    for (const query of [
      { type: 'magiclink' },
      { token_hash: HASH },
      { token_hash: HASH, type: 'sms' },
      { token_hash: 'short', type: 'magiclink' },
      { token_hash: `${HASH}&type=recovery`, type: 'magiclink' },
      { token_hash: 'x'.repeat(200), type: 'magiclink' },
      // A link without PKCE: nothing binds it to the browser that asked.
      { token_hash: HASH.slice('pkce_'.length), type: 'magiclink' },
      { token_hash: `pkce_${'A'.repeat(56)}`, type: 'magiclink' },
    ] as Record<string, string>[]) {
      expect(location(await GET(request(query))), JSON.stringify(query)).toBe('https://dial8.ai/login?error=auth_failed')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("answers HEAD without spending the token (link previews, mail scanners)", async () => {
    const res = HEAD()
    expect(res.status).toBe(204)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
