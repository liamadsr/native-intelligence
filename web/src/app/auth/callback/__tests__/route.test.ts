import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { APP_DOMAINS } from '@/lib/app-url'

/**
 * GET /auth/callback after a Supabase OAuth sign-in: where the person lands.
 * The redirect cookies come from `/login?redirect=`, which anyone can link
 * to, so the MCP one is honoured only on this origin.
 */

const m = vi.hoisted(() => ({
  exchange: vi.fn(async (_code: string) => ({ error: null as { code?: string; message: string } | null })),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { exchangeCodeForSession: m.exchange } }) }))

const { GET } = await import('../route')

// The hosted app answers on two domains while it moves (src/lib/app-url.ts): every case below runs on each.
describe.each(APP_DOMAINS)('on %s', (DOMAIN) => {
  /** The cookies as the login form writes them (encodeURIComponent), on a raw header, so Next's own parser reads them. */
  function request(cookies: Record<string, string> = {}, query = '?code=abc') {
    const cookie = Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; ')
    return new NextRequest(`https://${DOMAIN}/auth/callback${query}`, cookie ? { headers: { cookie } } : undefined)
  }
  const location = (res: Response) => res.headers.get('location')
  const cleared = (res: Response, name: string) => (res.headers.get('set-cookie') ?? '').includes(`${name}=;`)

  beforeEach(() => {
    m.exchange.mockReset().mockResolvedValue({ error: null })
  })

  describe('GET /auth/callback', () => {
    it('clears a waiting account redirect when the sign-in fails', async () => {
      const link = '/account?page=studio&video=aaaaaaaa-1111-4222-8333-444444444444'
      expect(cleared(await GET(request({ account_redirect: link }, '')), 'account_redirect')).toBe(true)
      m.exchange.mockResolvedValue({ error: { message: 'bad code' } })
      expect(cleared(await GET(request({ account_redirect: link })), 'account_redirect')).toBe(true)
    })

    it('lands on /account, and sends a missing or failed code back to /login', async () => {
      expect(location(await GET(request()))).toBe(`https://${DOMAIN}/account`)
      expect(location(await GET(request({}, '')))).toMatch(new RegExp(`^https://${DOMAIN.replace('.', '\\.')}/login\\?error=`))
      m.exchange.mockResolvedValue({ error: { message: 'bad code' } })
      expect(location(await GET(request()))).toBe(`https://${DOMAIN}/login?code=abc&error=auth_failed`)
    })

    it('says to open an email link where it was asked for when this browser has no verifier', async () => {
      m.exchange.mockResolvedValue({ error: { code: 'pkce_code_verifier_not_found', message: 'PKCE code verifier not found' } })
      expect(location(await GET(request()))).toBe(`https://${DOMAIN}/login?code=abc&error=other_browser`)
    })

    it('resumes the MCP authorize step from a path or a full URL on this origin, and clears the cookie', async () => {
      for (const value of ['/api/mcp/oauth/authorize?client_id=x', `https://${DOMAIN}/api/mcp/oauth/authorize?client_id=x`]) {
        const res = await GET(request({ mcp_redirect: value }))
        expect(location(res), value).toBe(`https://${DOMAIN}/api/mcp/oauth/authorize?client_id=x`)
        expect(cleared(res, 'mcp_redirect'), value).toBe(true)
      }
    })

    it('never sends a signed-in person off-site through an MCP-shaped redirect', async () => {
      for (const evil of ['https://evil.example/api/mcp/x', '//evil.example/api/mcp/x', `http://${DOMAIN}/api/mcp/x`, `https://${DOMAIN}.evil.example/mcp/x`]) {
        const res = await GET(request({ mcp_redirect: evil }))
        expect(location(res), evil).toBe(`https://${DOMAIN}/account`)
        expect(cleared(res, 'mcp_redirect'), evil).toBe(true)
      }
    })

    it("keeps the authorize query's own escapes (one decode, not two)", async () => {
      const target = '/api/mcp/oauth/authorize?client_id=x&state=a%2Bb%26c&redirect_uri=https%3A%2F%2Fclient.example%2Fcb'
      expect(location(await GET(request({ mcp_redirect: target })))).toBe(`https://${DOMAIN}${target}`)
    })

    it('a malformed cookie lands on /account rather than failing', async () => {
      const req = new NextRequest(`https://${DOMAIN}/auth/callback?code=abc`, { headers: { cookie: 'mcp_redirect=%E0%A4%A' } })
      expect(location(await GET(req))).toBe(`https://${DOMAIN}/account`)
    })
  })
})
