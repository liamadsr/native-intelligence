/**
 * The proxy (src/proxy.ts) and the forward from the old domain it runs first
 * (src/lib/old-domain-forward.ts): the forward through the real proxy, both
 * domains, the setting on and off; the proxy's matcher; and the check that every
 * route the app has is classified for the forward.
 */
import { vi } from 'vitest'

// Next's request storage looks for this global when next/server first loads;
// the server sets it, a test has to (before the imports below run).
vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  ;(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage
})

// The account and admin paths ask Supabase who is signed in: nobody here.
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
}))

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config, proxy } from '@/proxy'
import { APP_PAGE_HOSTS } from '@/lib/app-url'
import { API_FAMILIES, FORWARD_FROM_DOMAINS, ROUTES, routeRule } from '@/lib/old-domain-forward'

const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const DESKTOP_WEBVIEW = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'

const OLD_HOSTS = FORWARD_FROM_DOMAINS.flatMap((domain) => [domain, `www.${domain}`])

function req(method: string, url: string, headers: Record<string, string> = {}) {
  const host = new URL(url).host
  return new NextRequest(url, { method, headers: { host, 'user-agent': SAFARI, 'sec-fetch-dest': 'document', ...headers } })
}

/** Where the proxy's answer sends the browser, or 'stays' when it goes on to the page on the same host. */
async function outcome(request: NextRequest): Promise<{ status: number; to: string } | 'stays'> {
  const response = await proxy(request)
  const location = response.headers.get('location')
  if (!location) {
    // On to the page or route, or the proxy's own 401 for an API call nobody signed.
    expect(response.headers.get('x-middleware-next') === '1' || response.status === 401).toBe(true)
    return 'stays'
  }
  // The proxy's own redirects (to /login, /account) stay on the host they were asked on.
  if (new URL(location).host === new URL(request.url).host) return 'stays'
  return { status: response.status, to: location }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev')
  vi.stubEnv('GOOGLE_SIGN_IN_REDIRECT_URI', '')
  vi.stubEnv('CHATGPT_REDIRECT_URI', '')
  vi.stubEnv('NI_FORWARD_OLD_DOMAIN', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the forward, through the proxy', () => {
  // [method, path, forwarded when on]
  const rows: Array<[string, string, boolean]> = [
    ['GET', '/', true],
    ['HEAD', '/', true],
    ['GET', '/account', true],
    ['HEAD', '/account', true],
    ['GET', '/account/settings/connectors?tab=mail', true],
    ['GET', '/admin/users', true],
    ['GET', '/login?redirect=%2Finvite%2Fabc', true],
    ['GET', '/pricing', true],
    ['GET', '/s/abc123', true],
    ['GET', '/invite/abc123', true],
    ['GET', '/book/acme?day=2026-11-12', true],
    ['POST', '/account', false],
    ['POST', '/pricing', false],
    ['PUT', '/', false],
    ['DELETE', '/account/captures', false],
    ['OPTIONS', '/login', false],
    ['GET', '/auth/confirm?token_hash=x&type=magiclink', false],
    ['GET', '/auth/callback?code=x', false],
    ['GET', '/auth/desktop-callback?code=x', false],
    ['GET', '/auth/google', false],
    ['GET', '/admin/auth/callback?code=x', false],
    ['GET', '/admin/login', true],
    ['GET', '/sign-out', false],
    ['GET', '/reset-password', false],
    ['GET', '/welcome', false],
    ['GET', '/mcp/authorize?client_id=x', false],
    ['GET', '/oauth-popup-callback', false],
    ['GET', '/hud/agent', false],
    ['GET', '/.well-known/oauth-authorization-server', false],
    ['GET', '/api/desktop/update/darwin/aarch64/0.2.106', false],
    ['GET', '/api/account/workspace/list', false],
    ['POST', '/api/webhooks/gmail/push', false],
    ['PUT', '/api/inngest', false],
    ['GET', '/sms', false],
    ['GET', '/terms', false],
    ['GET', '/privacy', false],
    ['GET', '/no-such-page', false],
  ]

  describe.each(['307', '308'] as const)('NI_FORWARD_OLD_DOMAIN=%s', (setting) => {
    beforeEach(() => vi.stubEnv('NI_FORWARD_OLD_DOMAIN', setting))

    it.each(OLD_HOSTS.flatMap((host) => rows.map(([method, p, forwarded]) => [method, host, p, forwarded] as const)))(
      '%s https://%s%s forwarded: %s',
      async (method, host, p, forwarded) => {
        const result = await outcome(req(method, `https://${host}${p}`))
        expect(result).toEqual(forwarded ? { status: Number(setting), to: `https://nativeintelligence.dev${p}` } : 'stays')
      },
    )

    it.each(['nativeintelligence.dev', 'browser-relay.dial8.ai', 'dial8-website-git-x.vercel.app', 'localhost:3000'].flatMap((host) =>
      rows.map(([method, p]) => [method, host, p] as const),
    ))('%s https://%s%s stays', async (method, host, p) => {
      expect(await outcome(req(method, `https://${host}${p}`))).toBe('stays')
    })
  })

  describe('NI_FORWARD_OLD_DOMAIN unset', () => {
    it.each([...OLD_HOSTS, 'nativeintelligence.dev'].flatMap((host) => rows.map(([method, p]) => [method, host, p] as const)))(
      '%s https://%s%s stays',
      async (method, host, p) => {
        expect(await outcome(req(method, `https://${host}${p}`))).toBe('stays')
      },
    )
  })

  it('a 307 may not be cached; a 308 may', async () => {
    vi.stubEnv('NI_FORWARD_OLD_DOMAIN', '307')
    expect((await proxy(req('GET', 'https://dial8.ai/pricing'))).headers.get('cache-control')).toBe('private, no-store')
    vi.stubEnv('NI_FORWARD_OLD_DOMAIN', '308')
    expect((await proxy(req('GET', 'https://dial8.ai/pricing'))).headers.get('cache-control')).toBeNull()
  })

  it('an open window\'s in-page navigation and a desktop build older than 0.2.107 stay', async () => {
    vi.stubEnv('NI_FORWARD_OLD_DOMAIN', '307')
    expect(await outcome(req('GET', 'https://dial8.ai/pricing', { rsc: '1', 'sec-fetch-dest': 'empty' }))).toBe('stays')
    expect(await outcome(req('GET', 'https://dial8.ai/pricing', { 'user-agent': DESKTOP_WEBVIEW }))).toBe('stays')
    // The account page goes on to the proxy's own sign-in check, on the old domain.
    const desktop = await proxy(req('GET', 'https://dial8.ai/account', { 'user-agent': DESKTOP_WEBVIEW }))
    expect(desktop.headers.get('location')).toBe('https://dial8.ai/login')
  })

  it('with the setting on but the app\'s address still on the old domain: nothing moves, and it says why once', async () => {
    vi.stubEnv('NI_FORWARD_OLD_DOMAIN', '307')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await outcome(req('GET', 'https://dial8.ai/pricing'))).toBe('stays')
    expect(await outcome(req('GET', 'https://dial8.ai/docs'))).toBe('stays')
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[old-domain-forward]'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('NEXT_PUBLIC_APP_URL')
  })
})

describe('the proxy\'s matcher', () => {
  const forwardEntry = config.matcher.find((entry): entry is Exclude<(typeof config.matcher)[number], string> => typeof entry !== 'string')!
  const matches = (url: string, host = new URL(url).host) => unstable_doesMiddlewareMatch({ config, url, headers: { host } })

  it('names exactly the old domain and its www.', () => {
    const hostPattern = new RegExp(`^${forwardEntry.has[0].value}$`)
    const candidates = [...APP_PAGE_HOSTS, 'browser-relay.dial8.ai', 'browser-relay.nativeintelligence.dev', 'evil.dial8.ai', 'dial8xai', 'xdial8.ai', 'dial8.ai.evil.example', 'www.dial8.ai.', 'localhost']
    expect(candidates.filter((host) => hostPattern.test(host)).sort()).toEqual([...OLD_HOSTS].sort())
  })

  it('runs the proxy on the old domain for every family that is forwarded', () => {
    const pageFamilies = Object.entries(ROUTES).filter(([, rule]) => rule.kind === 'page').map(([name]) => name)
    for (const host of OLD_HOSTS) {
      for (const family of pageFamilies) {
        for (const p of family ? [`/${family}`, `/${family}/x`, `/${family}?q=1`] : ['/', '/?q=1']) {
          expect(matches(`https://${host}${p}`), `${host}${p}`).toBe(true)
        }
      }
    }
  })

  it.each([
    '/api/version',
    '/api/inngest',
    '/api',
    '/_next/static/chunks/main.js',
    '/_next/image?url=x',
    '/_vercel/insights/view',
    '/eve/chat-agent/v1/session',
    '/ingest/e/',
    '/brand/logo.png',
    '/screenshots/a.webp',
    '/robots.txt',
    '/sitemap.xml',
    '/llms.txt',
    '/favicon.ico',
    '/manifest.webmanifest',
    '/ort/ort-wasm-simd-threaded.wasm',
    '/cloud-browser/relay.mjs',
    '/blog/feed.xml',
  ])('does not run for %s on the old domain', (p) => {
    expect(matches(`https://dial8.ai${p}`)).toBe(false)
  })

  it('on any other host, only for account and admin, as before', () => {
    for (const host of ['nativeintelligence.dev', 'www.nativeintelligence.dev', 'browser-relay.dial8.ai', 'dial8-website-git-x.vercel.app', 'localhost:3000']) {
      expect(matches(`https://${host}/pricing`), host).toBe(false)
      expect(matches(`https://${host}/`), host).toBe(false)
      expect(matches(`https://${host}/account/settings`), host).toBe(true)
      expect(matches(`https://${host}/api/account/x`), host).toBe(true)
      expect(matches(`https://${host}/api/version`), host).toBe(false)
    }
  })
})

/**
 * Every route the app has must be in the forward's table, so a new one is
 * never forwarded (or kept back) by accident: a new folder in src/app, a
 * metadata file there, or a family in src/app/api fails here until it is added
 * to ROUTES or API_FAMILIES in src/lib/old-domain-forward.ts, with why.
 */
describe('every route is classified for the forward', () => {
  const APP = path.resolve(__dirname, '../app')
  const API = path.join(APP, 'api')
  /** First segments served from outside src/app: next.config.mjs, Next itself. */
  const NOT_IN_APP = ['_next', 'eve', 'ingest']

  const isDir = (p: string) => statSync(p).isDirectory()
  const CODE = /\.(?:tsx?|jsx?|mdx)$/
  /** Next's metadata files: the first segment of the URL each one serves. */
  function metadataRoute(file: string): string | null {
    const stem = file.replace(/\.[^.]+$/, '')
    const code = CODE.test(file)
    if (stem === 'robots') return 'robots.txt'
    if (stem === 'sitemap') return 'sitemap.xml'
    if (stem === 'manifest') return code ? 'manifest.webmanifest' : file
    if (['opengraph-image', 'twitter-image', 'icon', 'apple-icon'].includes(stem)) return code ? stem : file
    if (stem === 'favicon') return file
    return null
  }

  function hasRoute(dir: string): boolean {
    return readdirSync(dir).some((name) => {
      const p = path.join(dir, name)
      if (isDir(p)) return name !== '__tests__' && hasRoute(p)
      return /^(?:page|route)\.(?:tsx?|jsx?|mdx)$/.test(name)
    })
  }

  /** The URL first segments src/app serves, from a folder (src/app or a route group in it). */
  function firstSegments(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (isDir(p)) {
        if (name === '__tests__' || name.startsWith('_')) continue
        // A route group or a parallel route adds no segment: its children are top level.
        if (/^\(.*\)$/.test(name) || name.startsWith('@')) {
          out.push(...firstSegments(p))
          continue
        }
        if (!hasRoute(p)) continue
        if (name.startsWith('[')) throw new Error(`src/app/${name} is a dynamic top-level segment: the forward classifies paths by their first segment and cannot classify it`)
        out.push(name)
      } else if (/^(?:page|route)\.(?:tsx?|jsx?|mdx)$/.test(name)) {
        out.push('')
      } else {
        const route = metadataRoute(name)
        if (route) out.push(route)
      }
    }
    return out
  }

  it('every first segment in src/app', () => {
    const missing = firstSegments(APP).filter((segment) => !Object.hasOwn(ROUTES, segment))
    expect(missing, `add these to ROUTES in src/lib/old-domain-forward.ts: ${missing.join(', ')}`).toEqual([])
  })

  it('no entry in ROUTES for a route that is gone', () => {
    const served = new Set([...firstSegments(APP), ...NOT_IN_APP])
    const stale = Object.keys(ROUTES).filter((segment) => !served.has(segment))
    expect(stale, `remove these from ROUTES: ${stale.join(', ')}`).toEqual([])
  })

  it('every family in src/app/api, and nothing else', () => {
    const families = readdirSync(API).filter((name) => isDir(path.join(API, name)) && name !== '__tests__')
    expect(families.filter((name) => !Object.hasOwn(API_FAMILIES, name)), 'add these to API_FAMILIES in src/lib/old-domain-forward.ts').toEqual([])
    expect(Object.keys(API_FAMILIES).filter((name) => !families.includes(name)), 'remove these from API_FAMILIES').toEqual([])
    expect(ROUTES.api.kind).toBe('program')
  })

  it('no route handler sits in a family that is forwarded, unless an exception says what it is', () => {
    const handlers: string[] = []
    const walk = (dir: string, segments: string[]) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name)
        if (isDir(p)) {
          if (name === '__tests__' || name.startsWith('_')) continue
          walk(p, /^\(.*\)$/.test(name) || name.startsWith('@') ? segments : [...segments, name])
        } else if (/^route\.(?:tsx?|jsx?)$/.test(name)) {
          handlers.push(`/${segments.join('/')}`)
        }
      }
    }
    walk(APP, [])
    expect(handlers.length).toBeGreaterThan(100)
    const forwarded = handlers.filter((handler) => routeRule(handler)?.kind === 'page')
    expect(forwarded, 'a route handler a program calls must not be forwarded: add an `except` for it in ROUTES').toEqual([])
  })
})
