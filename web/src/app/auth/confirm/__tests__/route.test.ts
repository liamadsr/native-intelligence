import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { APP_DOMAINS } from '@/lib/app-url'

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

// The hosted app answers on two domains while it moves (src/lib/app-url.ts): every case below runs on each.
describe.each(APP_DOMAINS)('on %s', (DOMAIN) => {
  function request(query: Record<string, string>, headers?: Record<string, string>) {
    const url = new URL(`https://${DOMAIN}/auth/confirm`)
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
        ['magiclink', `https://${DOMAIN}/auth/callback`],
        ['signup', `https://${DOMAIN}/auth/callback`],
        ['magiclink', `https://${DOMAIN}/auth/desktop-callback`],
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
      fetchMock.mockResolvedValue(redirect(`https://${DOMAIN}/reset-password?code=abc`))
      const res = await GET(request({ token_hash: HASH, type: 'recovery', redirect_to: `https://${DOMAIN}/reset-password` }))
      expect(verifyCall()).toMatchObject({ type: 'recovery', redirect_to: `https://${DOMAIN}/reset-password` })
      expect(m.exchange).toHaveBeenCalledWith('abc')
      expect(location(res)).toBe(`https://${DOMAIN}/reset-password`)
    })

    it('keeps the reset page shut for a reset code this browser cannot redeem, or a spent link', async () => {
      fetchMock.mockResolvedValue(redirect(`https://${DOMAIN}/reset-password?code=abc`))
      m.exchange.mockResolvedValue({ error: { code: 'pkce_code_verifier_not_found', message: 'PKCE code verifier not found' } })
      expect(location(await GET(request({ token_hash: HASH, type: 'recovery' })))).toBe(
        `https://${DOMAIN}/reset-password?error=auth_failed`,
      )

      fetchMock.mockResolvedValue(redirect(`https://${DOMAIN}/reset-password?error=access_denied&error_code=otp_expired`))
      expect(location(await GET(request({ token_hash: HASH, type: 'recovery' })))).toBe(
        `https://${DOMAIN}/reset-password?error=link_expired`,
      )
      expect(m.exchange).toHaveBeenCalledTimes(1)
    })

    it('hands the browser the code, never the token', async () => {
      fetchMock.mockResolvedValue(redirect(`https://${DOMAIN}/auth/callback?code=abc`))
      const res = await GET(request({ token_hash: HASH, type: 'magiclink', redirect_to: `https://${DOMAIN}/auth/callback` }))
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
      const spent = `https://${DOMAIN}/auth/callback?error=access_denied&error_code=otp_expired`
      fetchMock.mockResolvedValue(redirect(`${spent}#error=access_denied`))
      expect(location(await GET(request({ token_hash: HASH, type: 'magiclink', redirect_to: `https://${DOMAIN}/auth/callback` })))).toBe(spent)
    })

    it('lands a link without a redirect of its own where its type does', async () => {
      fetchMock.mockResolvedValue(redirect(`https://${DOMAIN}/reset-password?code=abc`))
      await GET(request({ token_hash: HASH, type: 'recovery' }))
      expect(verifyCall().redirect_to).toBe(`https://${DOMAIN}/reset-password`)

      fetchMock.mockResolvedValue(redirect(`https://${DOMAIN}/auth/callback?code=abc`))
      await GET(request({ token_hash: HASH, type: 'signup', redirect_to: 'not a url' }))
      expect(verifyCall(1).redirect_to).toBe(`https://${DOMAIN}/auth/callback`)
    })

    it('never asks Supabase to send the code to another origin', async () => {
      for (const elsewhere of ['https://evil.example/auth/callback', `http://${DOMAIN}/auth/callback`, `https://${DOMAIN}.evil.example/auth/callback`]) {
        fetchMock.mockReset().mockResolvedValue(redirect(`https://${DOMAIN}/auth/callback?code=abc`))
        await GET(request({ token_hash: HASH, type: 'magiclink', redirect_to: elsewhere }))
        expect(verifyCall().redirect_to, elsewhere).toBe(`https://${DOMAIN}/auth/callback`)
      }
    })

    describe("a link asked for on the app's other domain", () => {
      const OTHER = APP_DOMAINS.find((d) => d !== DOMAIN)!
      const asked = { token_hash: HASH, type: 'magiclink', redirect_to: `https://${OTHER}/auth/desktop-callback` }

      it('is handed to that domain unspent, with everything the link carried', async () => {
        for (const host of [OTHER, `www.${OTHER}`]) {
          const res = await GET(request({ ...asked, redirect_to: `https://${host}/auth/desktop-callback` }))
          const there = new URL(location(res)!)
          expect(`${there.origin}${there.pathname}`, host).toBe(`https://${host}/auth/confirm`)
          expect(Object.fromEntries(there.searchParams)).toEqual({ ...asked, redirect_to: `https://${host}/auth/desktop-callback`, handed: '1' })
        }
        expect(fetchMock).not.toHaveBeenCalled()
        expect(m.exchange).not.toHaveBeenCalled()
      })

      it('is handed over once only: a link that comes back is finished here', async () => {
        fetchMock.mockResolvedValue(redirect(`https://${DOMAIN}/auth/callback?code=abc`))
        const res = await GET(request({ ...asked, handed: '1' }))
        expect(verifyCall().redirect_to).toBe(`https://${DOMAIN}/auth/callback`)
        expect(location(res)).toBe(`https://${DOMAIN}/auth/callback?code=abc`)
      })

      it('goes to no look-alike, no other host on that domain, and not over http', async () => {
        for (const elsewhere of [`https://evil.${OTHER}/auth/callback`, `https://not${OTHER}/auth/callback`, `https://${OTHER}.evil.example/auth/callback`, `https://browser-relay.${OTHER}/auth/callback`, `http://${OTHER}/auth/callback`, `https://${OTHER}:8443/auth/callback`]) {
          fetchMock.mockReset().mockResolvedValue(redirect(`https://${DOMAIN}/auth/callback?code=abc`))
          const res = await GET(request({ token_hash: HASH, type: 'magiclink', redirect_to: elsewhere }))
          expect(verifyCall().redirect_to, elsewhere).toBe(`https://${DOMAIN}/auth/callback`)
          expect(new URL(location(res)!).host, elsewhere).toBe(DOMAIN)
        }
      })

      it('is never handed over by a malformed link', async () => {
        const res = await GET(request({ ...asked, token_hash: 'short' }))
        expect(location(res)).toBe(`https://${DOMAIN}/login?error=auth_failed`)
      })

      it('is never handed to the hosted app from a preview or local dev', async () => {
        for (const here of ['https://preview-abc.vercel.app', 'http://localhost:3000']) {
          fetchMock.mockReset().mockResolvedValue(redirect(`${here}/auth/callback?code=abc`))
          const url = new URL(`${here}/auth/confirm`)
          for (const [k, v] of Object.entries({ token_hash: HASH, type: 'magiclink', redirect_to: `https://${DOMAIN}/auth/callback` })) url.searchParams.set(k, v)
          const res = await GET(new NextRequest(url))
          expect(verifyCall().redirect_to, here).toBe(`${here}/auth/callback`)
          expect(new URL(location(res)!).origin, here).toBe(here)
        }
      })
    })

    it('follows Supabase nowhere but the target, and never hands the browser a fragment', async () => {
      const desktop = { token_hash: HASH, type: 'magiclink', redirect_to: `https://${DOMAIN}/auth/desktop-callback` }
      fetchMock.mockResolvedValue(redirect(`https://${DOMAIN}/auth/desktop-callback#access_token=secret`))
      expect(location(await GET(request(desktop)))).toBe(`https://${DOMAIN}/auth/desktop-callback`)

      for (const elsewhere of [`https://${DOMAIN}/`, `https://${DOMAIN}/auth/callback?code=abc`, 'https://evil.example/auth/desktop-callback?code=abc', `${SUPABASE}/auth/v1/verify`]) {
        fetchMock.mockResolvedValue(redirect(elsewhere))
        expect(location(await GET(request(desktop))), elsewhere).toBe(`https://${DOMAIN}/auth/desktop-callback?error=auth_failed`)
      }
    })

    it('fails to the target when Supabase answers without a redirect or is unreachable', async () => {
      const web = { token_hash: HASH, type: 'magiclink', redirect_to: `https://${DOMAIN}/auth/callback` }
      // 429: Supabase's verification rate limit, answered before the token is spent.
      for (const status of [400, 429]) {
        fetchMock.mockResolvedValue(new Response('{}', { status }))
        expect(location(await GET(request(web))), String(status)).toBe(`https://${DOMAIN}/auth/callback?error=auth_failed`)
      }
      fetchMock.mockRejectedValue(new Error('offline'))
      expect(location(await GET(request({ ...web, type: 'recovery', redirect_to: `https://${DOMAIN}/reset-password` })))).toBe(
        `https://${DOMAIN}/reset-password?error=auth_failed`,
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
        expect(location(await GET(request(query))), JSON.stringify(query)).toBe(`https://${DOMAIN}/login?error=auth_failed`)
      }
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("answers HEAD without spending the token (link previews, mail scanners)", async () => {
      const res = HEAD()
      expect(res.status).toBe(204)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
