import { describe, expect, it } from 'vitest'
import { accountRedirectTarget, isAccountRedirectPath, isInviteRedirectPath, isJoinLinkPath, isMcpTarget, mcpRedirectTarget, resolvePostAuthRedirect, signInReturnUrl } from '../login-redirect'
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

    it("a desktop window on the app's other domain comes back through the app's address", () => {
      // The window on this domain, the address (and Supabase's redirect list) on the other.
      expect(signInReturnUrl('desktop', ORIGIN, `https://${OTHER}`)).toBe(`https://${OTHER}/auth/desktop-callback`)
      expect(signInReturnUrl('desktop', `https://www.${DOMAIN}`, `https://${OTHER}`)).toBe(`https://${OTHER}/auth/desktop-callback`)
      expect(signInReturnUrl('desktop', ORIGIN, `https://www.${OTHER}`)).toBe(`https://www.${OTHER}/auth/desktop-callback`)
    })

    it("any other desktop window comes back to its own origin, exactly as before the app had two domains", () => {
      // On the address's own domain, whichever of its two hosts each is on.
      expect(signInReturnUrl('desktop', ORIGIN, ORIGIN)).toBe(`${ORIGIN}/auth/desktop-callback`)
      expect(signInReturnUrl('desktop', ORIGIN, `https://www.${DOMAIN}`)).toBe(`${ORIGIN}/auth/desktop-callback`)
      expect(signInReturnUrl('desktop', `https://www.${DOMAIN}`, ORIGIN)).toBe(`https://www.${DOMAIN}/auth/desktop-callback`)
      // Local dev and a preview, whatever the address says (unset, it is the hosted app's).
      expect(signInReturnUrl('desktop', 'http://localhost:3000', 'http://localhost:3000')).toBe('http://localhost:3000/auth/desktop-callback')
      expect(signInReturnUrl('desktop', 'http://localhost:3000', ORIGIN)).toBe('http://localhost:3000/auth/desktop-callback')
      expect(signInReturnUrl('desktop', 'https://branch-abc.vercel.app', ORIGIN)).toBe('https://branch-abc.vercel.app/auth/desktop-callback')
      // A page that only looks like the app's is not moved either.
      expect(signInReturnUrl('desktop', `https://${DOMAIN}.evil.example`, `https://${OTHER}`)).toBe(`https://${DOMAIN}.evil.example/auth/desktop-callback`)
      expect(signInReturnUrl('desktop', `http://${DOMAIN}`, `https://${OTHER}`)).toBe(`http://${DOMAIN}/auth/desktop-callback`)
      // An address that is not the hosted app's (a self-hosted copy) or cannot be read: the page's own.
      expect(signInReturnUrl('desktop', ORIGIN, 'https://app.example.com')).toBe(`${ORIGIN}/auth/desktop-callback`)
      expect(signInReturnUrl('desktop', ORIGIN, 'not a url')).toBe(`${ORIGIN}/auth/desktop-callback`)
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
      // An email share link, beside the stricter reading of an in-app target: both hold.
      expect(resolvePostAuthRedirect('/mail/s/abc', ORIGIN)).toBe('/mail/s/abc')
      expect(resolvePostAuthRedirect('/account/settings', ORIGIN)).toBe('/account/settings')
      expect(isMcpTarget('/account/settings')).toBe(false)
      for (const evil of ['//evil.example/account', 'https://evil.example/api/mcp/x', '/somewhere-else', '/invite//evil.example', '/link//evil.example', '/mail/s//evil.example', '/mail/x', '/account/../mail/s/abc']) {
        expect(resolvePostAuthRedirect(evil, ORIGIN), evil).toBe('/account')
      }
    })

    it('keeps a page of the app with its deep link (the Studio export a desktop download opens), and nothing like it', () => {
      const link = '/account?page=studio&video=aaaaaaaa-1111-4222-8333-444444444444&export=bbbbbbbb-1111-4222-8333-444444444444'
      expect(resolvePostAuthRedirect(link, ORIGIN)).toBe(link)
      expect(isAccountRedirectPath(link)).toBe(true)
      expect(isAccountRedirectPath('/account')).toBe(true)
      for (const no of ['/accountx', '/account//evil.example', '/account\\evil.example', 'https://evil.example/account', '//evil.example/account', '/s/abc']) expect(isAccountRedirectPath(no), no).toBe(false)
      expect(resolvePostAuthRedirect('/accountx', ORIGIN)).toBe('/account')
    })

    it('reads an account target as a browser would: dot segments, tabs, line breaks and look-alikes are refused', () => {
      const bad = [
        '/account/../anything', '/account/%2e%2e/anything', '/account/%2E%2E/%2e%2e/x', '/account/./../x',
        '/account/../\t/evil.example', '/account/..\t/evil.example', '/account\n', '/account/\r\n../x', '/acc\tount',
        '//evil.example/account', '/account//evil.example', '/account/..//evil.example', '/\\evil.example/account', '/account\\..\\x',
        '/account@evil.example', '/account.evil', '/accountx', 'account', 'https://evil.example/account', '',
      ]
      for (const path of bad) {
        expect(accountRedirectTarget(path), JSON.stringify(path)).toBeNull()
        expect(resolvePostAuthRedirect(path, ORIGIN), JSON.stringify(path)).toBe('/account')
      }
    })

    it('returns the parsed account path, never the raw value; a nested redirect stays a query of /account', () => {
      expect(accountRedirectTarget('/account')).toBe('/account')
      expect(accountRedirectTarget('/account/settings/./x?a=1#h')).toBe('/account/settings/x?a=1#h')
      expect(accountRedirectTarget('/account?redirect=//evil.example')).toBe('/account?redirect=//evil.example')
      expect(new URL(accountRedirectTarget('/account?redirect=//evil.example')!, ORIGIN).origin).toBe(ORIGIN)
      expect(accountRedirectTarget('/account?page=studio&video=a b')).toBe('/account?page=studio&video=a%20b')
    })

    it("keeps an agent link's connect link, so a new account lands back on the request", () => {
      expect(resolvePostAuthRedirect('/link/abc', ORIGIN)).toBe('/link/abc')
      expect(isInviteRedirectPath('/link/abc')).toBe(true)
      expect(isInviteRedirectPath('/invite/tok')).toBe(true)
      for (const no of ['/linkx/abc', '/link//evil.example', 'https://evil.example/link/abc', '/s/abc']) expect(isInviteRedirectPath(no), no).toBe(false)
    })

    it("keeps a workspace's join link, so a signed-out person comes back to join", () => {
      expect(resolvePostAuthRedirect('/join/Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-', ORIGIN)).toBe('/join/Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-')
      expect(isInviteRedirectPath('/join/abc')).toBe(true)
      expect(isJoinLinkPath('/join/abc')).toBe(true)
      // An emailed invite is not a join link (the signup gate exempts only the former).
      expect(isJoinLinkPath('/invite/tok')).toBe(false)
      for (const no of ['/joinx/abc', '/join//evil.example', 'https://evil.example/join/abc']) {
        expect(isInviteRedirectPath(no), no).toBe(false)
        expect(resolvePostAuthRedirect(no, ORIGIN), no).toBe('/account')
      }
    })
  })
})
