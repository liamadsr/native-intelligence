import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { postAuthRedirect } from '../post-auth-redirect'
import { APP_DOMAINS } from '@/lib/app-url'

// The hosted app answers on two domains while it moves (src/lib/app-url.ts): every case below runs on each.
describe.each(APP_DOMAINS)('on %s', (DOMAIN) => {
  /** The cookies as the login form writes them (encodeURIComponent), on a raw header, so Next's own parser reads them. */
  function request(cookies: Record<string, string> = {}) {
    const cookie = Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; ')
    return new NextRequest(`https://${DOMAIN}/auth/callback?code=abc`, cookie ? { headers: { cookie } } : undefined)
  }

  const location = (res: Response) => res.headers.get('location')
  const cleared = (res: Response, name: string) =>
    (res.headers.get('set-cookie') ?? '').split(/,(?=\s*\w+=)/).some((c) => c.trim().startsWith(`${name}=;`))

  describe('postAuthRedirect', () => {
    it('lands on /account without a redirect cookie', () => {
      expect(location(postAuthRedirect(request()))).toBe(`https://${DOMAIN}/account`)
    })

    it('honours an invite redirect and clears it', () => {
      const res = postAuthRedirect(request({ invite_redirect: '/invite/tok' }))
      expect(location(res)).toBe(`https://${DOMAIN}/invite/tok`)
      expect(cleared(res, 'invite_redirect')).toBe(true)
    })

    it("honours an agent link's connect link through the invite cookie", () => {
      const res = postAuthRedirect(request({ invite_redirect: '/link/abc' }))
      expect(location(res)).toBe(`https://${DOMAIN}/link/abc`)
      expect(cleared(res, 'invite_redirect')).toBe(true)
      expect(location(postAuthRedirect(request({ invite_redirect: '/link//evil.example' })))).toBe(`https://${DOMAIN}/account`)
    })

    it('honours a share redirect, and refuses a path outside its family', () => {
      expect(location(postAuthRedirect(request({ share_redirect: '/s/abc' })))).toBe(`https://${DOMAIN}/s/abc`)
      expect(location(postAuthRedirect(request({ share_redirect: '//evil.example/s/x' })))).toBe(`https://${DOMAIN}/account`)
      expect(location(postAuthRedirect(request({ invite_redirect: '/account/settings' })))).toBe(`https://${DOMAIN}/account`)
    })

    it('resumes the MCP authorize step', () => {
      expect(location(postAuthRedirect(request({ mcp_redirect: '/api/mcp/oauth/authorize?client_id=x' })))).toBe(
        `https://${DOMAIN}/api/mcp/oauth/authorize?client_id=x`,
      )
      expect(location(postAuthRedirect(request({ mcp_redirect: '/somewhere-else' })))).toBe(`https://${DOMAIN}/account`)
      // A full URL on this origin is the authorize step too.
      expect(location(postAuthRedirect(request({ mcp_redirect: `https://${DOMAIN}/api/mcp/oauth/authorize?client_id=x` })))).toBe(
        `https://${DOMAIN}/api/mcp/oauth/authorize?client_id=x`,
      )
    })

    it('never sends a signed-in person off-site through an MCP-shaped redirect', () => {
      for (const evil of ['https://evil.example/api/mcp/x', '//evil.example/api/mcp/x', `http://${DOMAIN}/api/mcp/x`, `https://${DOMAIN}.evil.example/mcp/x`]) {
        const res = postAuthRedirect(request({ mcp_redirect: evil }))
        expect(location(res), evil).toBe(`https://${DOMAIN}/account`)
        expect(cleared(res, 'mcp_redirect'), evil).toBe(true)
      }
    })
  })
})
