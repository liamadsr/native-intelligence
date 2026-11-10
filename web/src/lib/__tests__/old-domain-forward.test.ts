/**
 * The forward from the old domain (src/lib/old-domain-forward.ts): which
 * requests it moves, and which it never touches. The proxy that runs it, its
 * matcher and the check that every route is classified are in
 * src/__tests__/proxy.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  API_FAMILIES,
  FORWARD_FROM_DOMAINS,
  FORWARD_TO_DOMAIN,
  ROUTES,
  desktopWebViewOnOldDomain,
  forwardBlockedBy,
  forwardStatus,
  oldDomainForward,
  routeRule,
} from '../old-domain-forward'

// What the desktop app's web views send: WebKit's bare default (measured from a
// WKWebView made as wry 0.54.3 makes one, with no user agent of its own).
const DESKTOP_WEBVIEW = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0'
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'

function request(url: string, { method = 'GET', headers = {} as Record<string, string> } = {}) {
  const nextUrl = new URL(url)
  return { method, headers: new Headers({ host: nextUrl.host, 'user-agent': SAFARI, ...headers }), nextUrl }
}

const ON = { NI_FORWARD_OLD_DOMAIN: '307' }

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev')
  vi.stubEnv('GOOGLE_SIGN_IN_REDIRECT_URI', '')
  vi.stubEnv('CHATGPT_REDIRECT_URI', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('the domains', () => {
  it('forwards from dial8.ai to nativeintelligence.dev', () => {
    expect(FORWARD_TO_DOMAIN).toBe('nativeintelligence.dev')
    expect(FORWARD_FROM_DOMAINS).toEqual(['dial8.ai'])
  })
})

describe('the setting', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['0', null],
    ['off', null],
    ['false', null],
    ['1', null],
    ['on', null],
    ['true', null],
    ['yes', null],
    ['301', null],
    ['302', null],
    ['307', 307],
    [' 307 ', 307],
    ['308', 308],
  ] as const)('NI_FORWARD_OLD_DOMAIN=%j → %j', (value, status) => {
    expect(forwardStatus(value === undefined ? {} : { NI_FORWARD_OLD_DOMAIN: value })).toBe(status)
  })

  it('off: nothing is forwarded, not even a page on the old domain', () => {
    expect(oldDomainForward(request('https://dial8.ai/account'), {})).toEqual({ forward: false, reason: 'off' })
  })
})

describe('what is forwarded', () => {
  const pages = [
    '/',
    '/account',
    '/account/settings/connectors?tab=mail',
    '/account/captures/abc/',
    '/admin',
    '/admin/login',
    '/admin/users',
    '/login?redirect=%2Fs%2Fabc',
    '/forgot-password',
    '/pricing',
    '/docs/getting-started',
    '/blog/hello-world',
    '/s/abc123',
    '/invite/abc123',
    '/link/abc123',
    '/l/abc123',
    '/book/acme',
    '/payments/paid?session=x',
    '/vs/granola',
  ]
  it.each(FORWARD_FROM_DOMAINS.flatMap((domain) => [domain, `www.${domain}`]).flatMap((host) =>
    pages.flatMap((path) => (['GET', 'HEAD'] as const).map((method) => [method, host, path] as const)),
  ))('%s https://%s%s → the same path and query on nativeintelligence.dev', (method, host, path) => {
    expect(oldDomainForward(request(`https://${host}${path}`, { method }), ON)).toEqual({
      forward: true,
      location: `https://nativeintelligence.dev${path}`,
      status: 307,
    })
  })

  it('308 when the setting says 308', () => {
    expect(oldDomainForward(request('https://dial8.ai/pricing'), { NI_FORWARD_OLD_DOMAIN: '308' })).toEqual({
      forward: true,
      location: 'https://nativeintelligence.dev/pricing',
      status: 308,
    })
  })

  it('keeps an encoded path and an encoded query as they came', () => {
    const decision = oldDomainForward(request('https://dial8.ai/s/a%2Fb?next=%2Faccount%3Fx%3D1&q=a+b'), ON)
    expect(decision).toMatchObject({ location: 'https://nativeintelligence.dev/s/a%2Fb?next=%2Faccount%3Fx%3D1&q=a+b' })
  })

  it('a page load says so (Sec-Fetch-Dest: document) and is forwarded; so is a client that says nothing', () => {
    expect(oldDomainForward(request('https://dial8.ai/', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } }), ON).forward).toBe(true)
    expect(oldDomainForward(request('https://dial8.ai/', { headers: { 'user-agent': 'curl/8.7.1' } }), ON).forward).toBe(true)
  })

  it.each([SAFARI, CHROME_MAC, FIREFOX_MAC, IPHONE_SAFARI])('a browser is forwarded: %s', (ua) => {
    expect(oldDomainForward(request('https://dial8.ai/account', { headers: { 'user-agent': ua } }), ON).forward).toBe(true)
  })
})

describe('what is never forwarded', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s to a page', (method) => {
    expect(oldDomainForward(request('https://dial8.ai/account', { method }), ON)).toEqual({ forward: false, reason: 'not GET or HEAD' })
  })

  it.each([
    'nativeintelligence.dev',
    'www.nativeintelligence.dev',
    'browser-relay.dial8.ai',
    'browser-relay.nativeintelligence.dev',
    'test.nativeintelligence.dev',
    'dial8-website-git-main-example.vercel.app',
    'localhost:3000',
    '127.0.0.1:3001',
    'evil.dial8.ai',
    'notdial8.ai',
    'dial8.ai.evil.example',
    'dial8.ai:8443',
  ])('host %s', (host) => {
    const r = request(`https://${host}/account`)
    expect(oldDomainForward(r, ON)).toEqual({ forward: false, reason: 'not the old domain' })
  })

  // Written out by hand, not read from ROUTES, so that moving one of these
  // into 'page' fails here as well as in review.
  it.each([
    // Sign-in, email links, connects: they finish where they began.
    '/auth/callback?code=abc',
    '/auth/confirm?token_hash=abc&type=magiclink&next=%2Faccount',
    '/auth/desktop-callback?code=abc',
    '/auth/google',
    '/auth/google?desktop=1&bind=0123abcd',
    '/auth/google/callback?code=abc&state=x',
    '/auth/chatgpt',
    '/auth/chatgpt/callback?code=abc',
    '/auth/demo-link',
    '/admin/auth/callback?code=abc',
    '/admin/sign-out',
    '/sign-out',
    '/reset-password',
    '/reset-password?error=opened_elsewhere',
    '/welcome?type=recovery',
    '/mcp/authorize?client_id=x',
    '/oauth-popup-callback?status=ok',
    '/mcp-oauth-popup-callback?status=ok',
    // Programs.
    '/api/desktop/update/darwin/aarch64/0.2.106',
    '/api/inngest',
    '/api/internal/chat/tool',
    '/api/mcp',
    '/api/mcp/oauth/authorize?client_id=x',
    '/api/oauth/google/callback?code=x&state=y',
    '/api/webhooks/gmail/push',
    '/api/twilio/sms',
    '/api/download',
    '/api/email/unsubscribe?token=x',
    '/api/version',
    '/api',
    '/hud/agent',
    '/hud/dictate',
    '/hud/meeting-detected',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource/api/mcp',
    '/llms.txt',
    '/robots.txt',
    '/sitemap.xml',
    '/manifest.webmanifest',
    '/opengraph-image',
    '/twitter-image',
    '/favicon.ico',
    '/icon.png',
    '/blog/feed.xml',
    '/_next/static/chunks/main.js',
    '/_vercel/insights/view',
    '/eve/chat-agent/v1/session',
    '/ingest/e/',
    // Held while the SMS campaign names the old domain.
    '/sms',
    '/terms',
    '/privacy',
    // Nobody classified these.
    '/no-such-page',
    '/brand/logo.png',
    '/ort/ort-wasm.wasm',
    '/cloud-browser/relay.mjs',
    '/Account',
    '//evil.example/x',
  ])('GET %s', (path) => {
    expect(oldDomainForward(request(`https://dial8.ai${path}`), ON).forward).toBe(false)
  })

  it.each([
    [{ rsc: '1' }, 'in-page request'],
    [{ rsc: '1', 'next-router-prefetch': '1' }, 'in-page request'],
    [{ 'next-router-segment-prefetch': '/_tree' }, 'in-page request'],
    [{ 'next-router-state-tree': '%5B%5D' }, 'in-page request'],
    [{ 'next-action': 'abc' }, 'in-page request'],
    [{ 'x-nextjs-data': '1' }, 'in-page request'],
    [{ 'sec-fetch-dest': 'empty' }, 'not a page load'],
    [{ 'sec-fetch-dest': 'script' }, 'not a page load'],
    [{ 'sec-fetch-dest': 'iframe' }, 'not a page load'],
    [{ 'sec-fetch-dest': 'image' }, 'not a page load'],
  ])('an open window\'s own request, a prefetch or a fetch: %j', (headers, reason) => {
    expect(oldDomainForward(request('https://dial8.ai/account', { headers }), ON)).toEqual({ forward: false, reason })
  })

  it('a request for the page\'s data by query (`_rsc`)', () => {
    expect(oldDomainForward(request('https://dial8.ai/account?_rsc=1x2y'), ON)).toEqual({ forward: false, reason: 'in-page request' })
  })
})

describe('installed desktop builds older than 0.2.107', () => {
  it('their windows send WebKit\'s bare user agent and stay on the old domain', () => {
    for (const path of ['/', '/account', '/login', '/account/settings']) {
      expect(oldDomainForward(request(`https://dial8.ai${path}`, { headers: { 'user-agent': DESKTOP_WEBVIEW } }), ON)).toEqual({
        forward: false,
        reason: 'desktop build older than 0.2.107',
      })
    }
  })

  it('also after moving within the old domain', () => {
    const headers = { 'user-agent': DESKTOP_WEBVIEW, referer: 'https://dial8.ai/account' }
    expect(oldDomainForward(request('https://dial8.ai/pricing', { headers }), ON).forward).toBe(false)
  })

  it('a desktop window that came from the new domain (only newer builds can be there) is forwarded', () => {
    for (const referer of ['https://nativeintelligence.dev/', 'https://www.nativeintelligence.dev/account']) {
      const headers = { 'user-agent': DESKTOP_WEBVIEW, referer }
      expect(oldDomainForward(request('https://dial8.ai/s/abc', { headers }), ON).forward).toBe(true)
    }
  })

  it.each([
    [DESKTOP_WEBVIEW, true],
    [`${DESKTOP_WEBVIEW} SomeEmbeddingApp/2.0`, true],
    [SAFARI, false],
    [CHROME_MAC, false],
    [FIREFOX_MAC, false],
    [IPHONE_SAFARI, false],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', false],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0', false],
    ['', false],
    ['curl/8.7.1', false],
  ])('%j is a desktop web view: %s', (ua, expected) => {
    expect(desktopWebViewOnOldDomain(new Headers(ua ? { 'user-agent': ua } : {}))).toBe(expected)
  })

  it('a Referer that is not a URL leaves the decision to the user agent', () => {
    expect(desktopWebViewOnOldDomain(new Headers({ 'user-agent': DESKTOP_WEBVIEW, referer: 'not a url' }))).toBe(true)
  })
})

describe('the forward waits for the address and the sign-in callbacks to move', () => {
  it.each(['https://dial8.ai', 'https://www.dial8.ai', 'https://dial8-website-git-x.vercel.app', 'not a url'])(
    'NEXT_PUBLIC_APP_URL=%s: blocked, and says why',
    (address) => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', address)
      const decision = oldDomainForward(request('https://dial8.ai/account'), ON)
      expect(decision).toMatchObject({ forward: false, blocked: true })
      expect(decision.forward === false && decision.reason).toContain('NEXT_PUBLIC_APP_URL')
    },
  )

  it('unset NEXT_PUBLIC_APP_URL is the new domain (src/lib/app-url.ts): not blocked', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(forwardBlockedBy({})).toBeNull()
  })

  it.each([
    ['GOOGLE_SIGN_IN_REDIRECT_URI', 'https://dial8.ai/auth/google/callback'],
    ['GOOGLE_SIGN_IN_REDIRECT_URI', 'https://www.dial8.ai/auth/google/callback'],
    ['CHATGPT_REDIRECT_URI', 'https://dial8.ai/auth/chatgpt/callback'],
  ])('%s=%s: blocked, that sign-in would finish on the old domain', (name, value) => {
    expect(forwardBlockedBy({ [name]: value })).toContain(name)
    expect(oldDomainForward(request('https://dial8.ai/login'), { ...ON, [name]: value })).toMatchObject({ forward: false, blocked: true })
  })

  it('callbacks on the new domain, or left to follow the page: not blocked', () => {
    expect(
      forwardBlockedBy({
        GOOGLE_SIGN_IN_REDIRECT_URI: 'https://nativeintelligence.dev/auth/google/callback',
        CHATGPT_REDIRECT_URI: 'https://nativeintelligence.dev/auth/chatgpt/callback',
      }),
    ).toBeNull()
    expect(forwardBlockedBy({ GOOGLE_SIGN_IN_REDIRECT_URI: '', CHATGPT_REDIRECT_URI: '  ' })).toBeNull()
  })

  it('a request that would not be forwarded anyway is not reported as blocked', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
    expect(oldDomainForward(request('https://dial8.ai/api/inngest', { method: 'PUT' }), ON)).toEqual({ forward: false, reason: 'not GET or HEAD' })
    expect(oldDomainForward(request('https://nativeintelligence.dev/account'), ON)).toEqual({ forward: false, reason: 'not the old domain' })
  })
})

describe('the route table', () => {
  it('every rule says why', () => {
    for (const [name, rule] of Object.entries(ROUTES)) {
      expect(rule.why.length, name).toBeGreaterThan(5)
      for (const [sub, inner] of Object.entries(rule.except ?? {})) expect(inner.why.length, `${name}/${sub}`).toBeGreaterThan(5)
    }
    for (const [name, why] of Object.entries(API_FAMILIES)) expect(why.length, name).toBeGreaterThan(5)
  })

  it('a sub-path exception wins over its family', () => {
    expect(routeRule('/admin/users')?.kind).toBe('page')
    expect(routeRule('/admin/auth/callback')?.kind).toBe('flow')
    expect(routeRule('/admin/sign-out')?.kind).toBe('flow')
    expect(routeRule('/blog/feed.xml')?.kind).toBe('program')
  })

  it('names inherited from Object are not routes', () => {
    for (const path of ['/constructor', '/__proto__', '/toString', '/hasOwnProperty', '/admin/constructor']) {
      expect(routeRule(path)?.kind ?? null, path).not.toBe('flow')
    }
    expect(routeRule('/constructor')).toBeNull()
    expect(routeRule('/admin/__proto__')?.kind).toBe('page')
  })
})
