/**
 * THE CSP LIMITS WHERE SCRIPTS AND WORKERS COME FROM, AND NOTHING ELSE.
 *
 * next.config.mjs sends one Content-Security-Policy on every route. Pinned
 * here: it only allows first-party script and worker sources (no third-party
 * host can run code as nativeintelligence.dev), and it sets no default-src or fetch-style
 * directive, because the desktop app runs these same pages and its IPC is a
 * fetch to ipc://localhost (a connect-src would break it). It must also keep
 * working with Next's inline scripts: a nonce, hash or 'strict-dynamic' would
 * make browsers ignore 'unsafe-inline'.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentSecurityPolicy, headers } from '../../../next.config.mjs'

type HeaderRule = { source: string; headers: { key: string; value: string }[] }

/** Parse a policy into { directive: sources[] }. */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const [name, ...sources] = part.split(/\s+/)
      return [name, sources]
    }),
  )
}

/** The CSP header headers() sends for a path, matching sources as path-to-regexp anchors them. */
async function cspFor(path: string): Promise<string[]> {
  const rules = (await headers()) as HeaderRule[]
  return rules
    .filter((rule) => new RegExp(`^${rule.source.replace(/:path\*/g, '.*')}$`).test(path))
    .flatMap((rule) => rule.headers.filter((h) => h.key.toLowerCase() === 'content-security-policy'))
    .map((h) => h.value)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the Content-Security-Policy header', () => {
  it('is on every app route, once', async () => {
    for (const path of ['/', '/account', '/account/chat', '/admin', '/docs/getting-started', '/login', '/hud/bots', '/api/account/me', '/_next/static/chunks/main.js', '/ort/1.0.0/ort-wasm-simd-threaded.jsep.wasm']) {
      expect(await cspFor(path), path).toEqual([contentSecurityPolicy()])
    }
  })

  it('sets only script-src, worker-src, object-src and base-uri', () => {
    expect(Object.keys(directives(contentSecurityPolicy())).sort()).toEqual(['base-uri', 'object-src', 'script-src', 'worker-src'])
    for (const dev of [false, true]) {
      const policy = directives(contentSecurityPolicy({ dev }))
      for (const name of ['default-src', 'connect-src', 'img-src', 'style-src', 'font-src', 'frame-src', 'frame-ancestors']) {
        expect(policy[name], name).toBeUndefined()
      }
    }
  })

  it('allows first-party scripts and workers only', () => {
    const policy = directives(contentSecurityPolicy({ dev: false }))
    expect(policy['script-src']).toEqual(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'blob:'])
    expect(policy['worker-src']).toEqual(["'self'", 'blob:'])
    expect(policy['object-src']).toEqual(["'none'"])
    expect(policy['base-uri']).toEqual(["'self'"])
    // No host, scheme or wildcard source a third party could serve from.
    for (const source of [...policy['script-src'], ...policy['worker-src']]) {
      expect(source, source).toMatch(/^('[a-z-]+'|blob:)$/)
    }
  })

  it("never carries a nonce, hash or 'strict-dynamic' (browsers would drop 'unsafe-inline' and Next's inline scripts)", () => {
    for (const dev of [false, true]) {
      expect(contentSecurityPolicy({ dev })).not.toMatch(/'nonce-|'sha(256|384|512)-|'strict-dynamic'/)
    }
  })

  it("adds 'unsafe-eval' in dev only", async () => {
    expect(directives(contentSecurityPolicy({ dev: false }))['script-src']).not.toContain("'unsafe-eval'")
    expect(directives(contentSecurityPolicy({ dev: true }))['script-src']).toContain("'unsafe-eval'")

    vi.stubEnv('NODE_ENV', 'production')
    expect(directives((await cspFor('/account'))[0])['script-src']).not.toContain("'unsafe-eval'")
    vi.stubEnv('NODE_ENV', 'development')
    expect(directives((await cspFor('/account'))[0])['script-src']).toContain("'unsafe-eval'")
  })
})

describe('the ONNX Runtime files', () => {
  it('are cached for good (their path carries the version)', async () => {
    const rules = (await headers()) as HeaderRule[]
    const ort = rules.find((rule) => rule.source === '/ort/:path*')
    expect(ort?.headers).toEqual([{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }])
  })
})
