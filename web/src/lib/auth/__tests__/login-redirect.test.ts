import { describe, expect, it } from 'vitest'
import { isInviteRedirectPath, isMcpTarget, mcpRedirectTarget, resolvePostAuthRedirect, signInReturnUrl } from '../login-redirect'
import { APP_DOMAINS } from '@/lib/app-url'

// The hosted app answers on two domains while it moves (src/lib/app-url.ts): every case below runs on each.
describe.each(APP_DOMAINS)('on %s', (DOMAIN) => {
  const ORIGIN = `https://${DOMAIN}`
  const APP = `https://${DOMAIN}`

  describe('mcpRedirectTarget', () => {
    it('resumes the MCP authorize step from a path or a full URL on this origin, as a path and search', () => {
      expect(mcpRedirectTarget('/api/mcp/oauth/authorize?client_id=x&state=y', ORIGIN, APP)).toBe('/api/mcp/oauth/authorize?client_id=x&state=y')
      expect(mcpRedirectTarget(`https://${DOMAIN}/api/mcp/oauth/authorize?client_id=x`, ORIGIN, APP)).toBe('/api/mcp/oauth/authorize?client_id=x')
      expect(mcpRedirectTarget('/mcp/authorize?client_id=x', ORIGIN, APP)).toBe('/mcp/authorize?client_id=x')
    })

    it("trusts the app's configured origin too (the authorize route links back from it)", () => {
      expect(mcpRedirectTarget('http://localhost:3000/api/mcp/oauth/authorize?x=1', 'http://127.0.0.1:3000', 'http://localhost:3000')).toBe('/api/mcp/oauth/authorize?x=1')
    })

    it('never names another site, or anything outside the MCP paths', () => {
      for (const evil of [
        'https://evil.example/api/mcp/x',
        '//evil.example/api/mcp/x',
        '/\\evil.example/api/mcp/x',
        `http://${DOMAIN}/api/mcp/x`,
        `https://${DOMAIN}.evil.example/mcp/x`,
        `https://${DOMAIN}@evil.example/api/mcp/x`,
        `https://evil.${DOMAIN}/api/mcp/x`,
        `https://not${DOMAIN}/api/mcp/x`,
        `https://browser-relay.${DOMAIN}/api/mcp/x`,
        'javascript:alert(1)//api/mcp/',
        '/api/mcp/../../account/settings',
        '/somewhere-else',
      ]) {
        expect(mcpRedirectTarget(evil, ORIGIN, APP), evil).toBeNull()
      }
    })
  })

  describe('while the app answers on two domains', () => {
    const OTHER = APP_DOMAINS.find((d) => d !== DOMAIN)!

    it("resumes a step that began on the app's other domain, as a path on this one", () => {
      for (const host of [OTHER, `www.${OTHER}`, `www.${DOMAIN}`]) {
        expect(mcpRedirectTarget(`https://${host}/api/mcp/oauth/authorize?client_id=x`, ORIGIN, undefined), host).toBe('/api/mcp/oauth/authorize?client_id=x')
      }
    })

    it('still refuses a look-alike of either domain', () => {
      for (const host of [`evil.${OTHER}`, `not${OTHER}`, `${OTHER}.evil.example`, `browser-relay.${OTHER}`]) {
        expect(mcpRedirectTarget(`https://${host}/api/mcp/oauth/authorize?client_id=x`, ORIGIN, undefined), host).toBeNull()
      }
      expect(mcpRedirectTarget(`http://${OTHER}/api/mcp/oauth/authorize?client_id=x`, ORIGIN, undefined)).toBeNull()
    })
  })

  describe('signInReturnUrl (where Supabase sends a sign-in back)', () => {
    const OTHER = APP_DOMAINS.find((d) => d !== DOMAIN)!

    it("a desktop sign-in comes back through the app's address, whatever origin the app's window is on", () => {
      // The window on this domain, the address (and Supabase's redirect list) on the other.
      expect(signInReturnUrl('desktop', ORIGIN, `https://${OTHER}`)).toBe(`https://${OTHER}/auth/desktop-callback`)
      expect(signInReturnUrl('desktop', ORIGIN, ORIGIN)).toBe(`${ORIGIN}/auth/desktop-callback`)
      expect(signInReturnUrl('desktop', 'http://localhost:3000', 'http://localhost:3000')).toBe('http://localhost:3000/auth/desktop-callback')
    })

    it("a browser's comes back to the page's own origin, where its verifier cookie is", () => {
      expect(signInReturnUrl('browser', ORIGIN, `https://${OTHER}`)).toBe(`${ORIGIN}/auth/callback`)
      expect(signInReturnUrl('browser', `https://www.${DOMAIN}`, `https://${OTHER}`)).toBe(`https://www.${DOMAIN}/auth/callback`)
    })
  })

  describe('resolvePostAuthRedirect (a password sign-in)', () => {
    it('resumes the MCP authorize step (it used to drop it on /account)', () => {
      const target = resolvePostAuthRedirect(`https://${DOMAIN}/api/mcp/oauth/authorize?client_id=x`, ORIGIN)
      expect(target).toBe('/api/mcp/oauth/authorize?client_id=x')
      expect(isMcpTarget(target)).toBe(true)
    })

    it('keeps the invite, share and in-app targets, and refuses everything else', () => {
      expect(resolvePostAuthRedirect(null, ORIGIN)).toBe('/account')
      expect(resolvePostAuthRedirect('/invite/tok', ORIGIN)).toBe('/invite/tok')
      expect(resolvePostAuthRedirect('/s/abc', ORIGIN)).toBe('/s/abc')
      expect(resolvePostAuthRedirect('/account/settings', ORIGIN)).toBe('/account/settings')
      expect(isMcpTarget('/account/settings')).toBe(false)
      for (const evil of ['//evil.example/account', 'https://evil.example/api/mcp/x', '/somewhere-else', '/invite//evil.example', '/link//evil.example']) {
        expect(resolvePostAuthRedirect(evil, ORIGIN), evil).toBe('/account')
      }
    })

    it("keeps an agent link's connect link, so a new account lands back on the request", () => {
      expect(resolvePostAuthRedirect('/link/abc', ORIGIN)).toBe('/link/abc')
      expect(isInviteRedirectPath('/link/abc')).toBe(true)
      expect(isInviteRedirectPath('/invite/tok')).toBe(true)
      for (const no of ['/linkx/abc', '/link//evil.example', 'https://evil.example/link/abc', '/s/abc']) expect(isInviteRedirectPath(no), no).toBe(false)
    })
  })
})
