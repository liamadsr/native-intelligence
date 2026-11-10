/**
 * The hosted app answers on two domains while it moves (src/lib/app-url.ts):
 * nativeintelligence.dev, and dial8.ai for desktop builds from before the
 * rename. The checks that ask "is this host ours?" must say yes on both, with
 * `www.`, and no to a look-alike of either. Checks with a test file of their
 * own cover both domains there (security/same-origin, auth/login-redirect,
 * the auth routes, stripe, open-external, the Gmail push audience, the relay
 * host); the rest are here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { APP_DOMAINS } from '@/lib/app-url'
import { appOwnSites, blockedSiteForUrl, NI_OWN_SITES } from '@/lib/browser-agent/blocked-sites'
import { isSameOriginPost } from '@/lib/links/same-origin'

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }))

afterEach(() => vi.unstubAllEnvs())

/** Hosts that only look like `domain`: none of them is the app. */
const lookAlikes = (domain: string) => [`not${domain}`, `${domain}.evil.example`, `evil-${domain}`, `${domain.replace('.', '')}.com`]

it('the two domains are the new one and the one it replaces', () => {
  expect([...APP_DOMAINS]).toEqual(['nativeintelligence.dev', 'dial8.ai'])
})

describe.each(APP_DOMAINS)('on %s', (DOMAIN) => {
  const OTHER = APP_DOMAINS.find((d) => d !== DOMAIN)!

  describe("a single-use link's button (links/same-origin)", () => {
    const post = (host: string, headers: Record<string, string>) => new Request(`https://${host}/api/links/tok`, { method: 'POST', headers: { host, ...headers } })

    it('takes a POST from the page it was served on, apex or www', () => {
      for (const host of [DOMAIN, `www.${DOMAIN}`]) {
        expect(isSameOriginPost(post(host, { origin: `https://${host}` })), host).toBe(true)
        expect(isSameOriginPost(post(host, { 'sec-fetch-site': 'same-origin' })), host).toBe(true)
        // Behind the proxy the forwarded host is the one the browser used.
        expect(isSameOriginPost(new Request('http://internal/api/links/tok', { method: 'POST', headers: { origin: `https://${host}`, 'x-forwarded-host': host } })), host).toBe(true)
      }
    })

    it("refuses a look-alike, a sibling subdomain, the app's other domain, and a request that says where it came from in neither header", () => {
      for (const from of [...lookAlikes(DOMAIN), `evil.${DOMAIN}`, `www.${DOMAIN}`, OTHER, 'attacker.example']) {
        expect(isSameOriginPost(post(DOMAIN, { origin: `https://${from}` })), from).toBe(false)
      }
      expect(isSameOriginPost(post(DOMAIN, { 'sec-fetch-site': 'same-site' }))).toBe(false)
      expect(isSameOriginPost(post(DOMAIN, { 'sec-fetch-site': 'cross-site', origin: `https://${DOMAIN}` }))).toBe(false)
      expect(isSameOriginPost(post(DOMAIN, {}))).toBe(false)
    })
  })

  describe("the browser agent keeps off the app's own pages (browser-agent/blocked-sites)", () => {
    it('whatever the address setting says', () => {
      expect(NI_OWN_SITES).toContain(DOMAIN)
      for (const setting of [undefined, '', `https://${OTHER}`, 'https://staging.example.com', 'http://localhost:3000']) {
        const sites = appOwnSites(setting)
        for (const url of [`https://${DOMAIN}/account/chat`, `https://www.${DOMAIN}/account`, `https://browser-relay.${DOMAIN}/cloud-browser/relay.mjs`, `https://docs.${DOMAIN}/`]) {
          expect(blockedSiteForUrl(url, sites), `${url} with ${setting}`).toBe(DOMAIN)
        }
      }
    })

    it('and a look-alike is just another site', () => {
      const sites = appOwnSites(undefined)
      for (const host of lookAlikes(DOMAIN)) expect(blockedSiteForUrl(`https://${host}/account`, sites), host).toBeNull()
    })
  })

  describe("the MCP server's OAuth metadata (.well-known, the 401 challenge)", () => {
    const get = (host: string, path: string) => new Request(`https://${host}${path}`, { headers: { host } })
    const metadata = async (host: string) => {
      const { GET: resource } = await import('@/app/.well-known/oauth-protected-resource/api/mcp/route')
      const { GET: server } = await import('@/app/.well-known/oauth-authorization-server/route')
      return {
        resource: await (await resource(get(host, '/.well-known/oauth-protected-resource/api/mcp'))).json(),
        server: await (await server(get(host, '/.well-known/oauth-authorization-server'))).json(),
      }
    }
    const challenge = async (host: string) => {
      const { authenticateMcpRequest } = await import('@/lib/mcp/auth')
      const refused = await authenticateMcpRequest(get(host, '/api/mcp')).catch((r: Response) => r)
      return (refused as Response).headers.get('www-authenticate')
    }

    it('names the host the client connected on, whichever domain the address setting names', async () => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', `https://${OTHER}`)
      for (const host of [DOMAIN, `www.${DOMAIN}`]) {
        const { resource, server } = await metadata(host)
        expect(resource).toMatchObject({ resource: `https://${host}/api/mcp`, authorization_servers: [`https://${host}`] })
        expect(server).toMatchObject({ issuer: `https://${host}`, authorization_endpoint: `https://${host}/api/mcp/oauth/authorize`, token_endpoint: `https://${host}/api/mcp/oauth/token`, registration_endpoint: `https://${host}/api/mcp/oauth/register` })
        expect(await challenge(host)).toBe(`Bearer resource_metadata="https://${host}/.well-known/oauth-protected-resource/api/mcp"`)
      }
    })

    it('gives any other host the address setting, never the host it claims', async () => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', `https://${OTHER}`)
      for (const host of [...lookAlikes(DOMAIN), `evil.${DOMAIN}`, `browser-relay.${DOMAIN}`, `${DOMAIN}:8443`, 'preview-abc.vercel.app']) {
        const { resource, server } = await metadata(host)
        expect(resource.resource, host).toBe(`https://${OTHER}/api/mcp`)
        expect(server.issuer, host).toBe(`https://${OTHER}`)
        expect(await challenge(host), host).toBe(`Bearer resource_metadata="https://${OTHER}/.well-known/oauth-protected-resource/api/mcp"`)
      }
    })
  })

  describe('the signed-in check other origins may read (api/auth/check-session)', () => {
    const allowed = async (origin: string) => {
      // The route builds its list once, when it loads: load it after the setting is in place.
      vi.resetModules()
      const { OPTIONS, GET } = await import('@/app/api/auth/check-session/route')
      const request = () => new NextRequest(`https://${DOMAIN}/api/auth/check-session`, { headers: { origin } })
      const preflight = (await OPTIONS(request())).headers.get('access-control-allow-origin')
      expect((await GET(request())).headers.get('access-control-allow-origin')).toBe(preflight)
      return preflight
    }

    it('answers the app on this domain, apex and www, whatever the address setting says', async () => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', `https://${OTHER}`)
      for (const origin of [`https://${DOMAIN}`, `https://www.${DOMAIN}`]) expect(await allowed(origin), origin).toBe(origin)
    })

    it('answers no look-alike, no other subdomain, and not http', async () => {
      for (const host of [...lookAlikes(DOMAIN), `evil.${DOMAIN}`, `browser-relay.${DOMAIN}`]) expect(await allowed(`https://${host}`), host).toBe('')
      expect(await allowed(`http://${DOMAIN}`)).toBe('')
    })
  })
})
