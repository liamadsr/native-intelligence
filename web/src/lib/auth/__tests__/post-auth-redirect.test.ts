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

    it('honours a page of the app with its deep link, clears it, and refuses anything else', () => {
      const link = '/account?page=studio&video=aaaaaaaa-1111-4222-8333-444444444444&export=bbbbbbbb-1111-4222-8333-444444444444'
      const res = postAuthRedirect(request({ account_redirect: link }))
      expect(location(res)).toBe(`https://${DOMAIN}${link}`)
      expect(cleared(res, 'account_redirect')).toBe(true)
      for (const evil of ['//evil.example/account', 'https://evil.example/account', '/accountx', '/account//evil.example']) expect(location(postAuthRedirect(request({ account_redirect: evil }))), evil).toBe(`https://${DOMAIN}/account`)
    })

    it('clears the account redirect whichever way the sign-in ends, so it never waits for the next one', () => {
      const link = '/account?page=studio&video=aaaaaaaa-1111-4222-8333-444444444444&export=bbbbbbbb-1111-4222-8333-444444444444'
      for (const winner of [{ invite_redirect: '/invite/tok' }, { share_redirect: '/s/abc' }, { mcp_redirect: '/api/mcp/oauth/authorize?x=1' }, {}]) {
        const res = postAuthRedirect(request({ ...winner, account_redirect: link }))
        expect(cleared(res, 'account_redirect'), JSON.stringify(winner)).toBe(true)
      }
      // A dot segment in the cookie is not followed: it lands on /account.
      expect(location(postAuthRedirect(request({ account_redirect: '/account/../anything' })))).toBe(`https://${DOMAIN}/account`)
      expect(location(postAuthRedirect(request({ account_redirect: '/account/./settings' })))).toBe(`https://${DOMAIN}/account/settings`)
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

    it('lands on a home the caller names when there is no redirect cookie, and only then', () => {
      expect(location(postAuthRedirect(request(), undefined, { home: '/join/team' }))).toBe(`https://${DOMAIN}/join/team`)
      expect(location(postAuthRedirect(request({ invite_redirect: '/invite/tok' }), undefined, { home: '/join/team' }))).toBe(`https://${DOMAIN}/invite/tok`)
    })

    it('a page of the app the person was sent to wins over that home, is cleared either way, and a bad one falls to /account, not to the home', () => {
      const link = '/account?page=studio&video=v1'
      const res = postAuthRedirect(request({ account_redirect: link }), undefined, { home: '/join/team' })
      expect(location(res)).toBe(`https://${DOMAIN}${link}`)
      expect(cleared(res, 'account_redirect')).toBe(true)
      const bad = postAuthRedirect(request({ account_redirect: '//evil.example/account' }), undefined, { home: '/join/team' })
      expect(location(bad)).toBe(`https://${DOMAIN}/account`)
      expect(cleared(bad, 'account_redirect')).toBe(true)
      // With no account redirect the home still holds, and the cookie's clearing is harmless.
      expect(cleared(postAuthRedirect(request(), undefined, { home: '/join/team' }), 'account_redirect')).toBe(true)
    })

    it("honours a workspace join link through the invite cookie, so sign-in comes back to join", () => {
      const res = postAuthRedirect(request({ invite_redirect: '/join/Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-' }))
      expect(location(res)).toBe(`https://${DOMAIN}/join/Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-`)
      expect(cleared(res, 'invite_redirect')).toBe(true)
      expect(location(postAuthRedirect(request({ invite_redirect: '/join//evil.example' })))).toBe(`https://${DOMAIN}/account`)
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
