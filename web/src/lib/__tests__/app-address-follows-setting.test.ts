/**
 * The deployed app's address is whatever NEXT_PUBLIC_APP_URL says, and nothing
 * else (src/lib/app-url.ts). This pins both halves:
 *
 *   - with the setting on the address production has today, nothing the app
 *     hands out names any other address (so a deploy changes no link, email,
 *     canonical URL or OAuth metadata until the setting itself moves);
 *   - no source file writes the hosted domain down for itself: it is in
 *     app-url.ts, and everything else asks.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe.each([
  ['https://dial8.ai', 'nativeintelligence.dev'],
  ['https://nativeintelligence.dev', 'dial8.ai'],
  ['https://staging.example.com', 'nativeintelligence.dev'],
])('with NEXT_PUBLIC_APP_URL=%s', (address, never) => {
  /** Everything below is read after the setting is in place: several modules keep the address in a constant. */
  async function handedOut(): Promise<Record<string, unknown>> {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', address)
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'test-only')
    vi.resetModules()
    const elsewhere = (path: string) => new Request(`https://preview-abc.vercel.app${path}`, { headers: { host: 'preview-abc.vercel.app' } })
    const { appUrl, appHost, isAppPageHost } = await import('@/lib/app-url')
    const { BASE_URL, getUnsubscribeUrl } = await import('@/lib/email')
    const { default: robots } = await import('@/app/robots')
    const { getSequenceUrl } = await import('@/lib/sequences/urls')
    const { safeCheckoutOrigin } = await import('@/lib/stripe')
    const { productionRelayOrigin } = await import('@/lib/cloud-browser/config')
    const { GET: resource } = await import('@/app/.well-known/oauth-protected-resource/api/mcp/route')
    const { GET: server } = await import('@/app/.well-known/oauth-authorization-server/route')
    return {
      appUrl: appUrl(),
      appHost: appHost(),
      emailBase: BASE_URL,
      unsubscribe: getUnsubscribeUrl('person@example.com'),
      robots: robots(),
      sequence: getSequenceUrl('seq-1'),
      checkoutReturn: safeCheckoutOrigin(null),
      checkoutFromElsewhere: safeCheckoutOrigin('https://attacker.example'),
      // The cloud browser's relay sits beside the address when that is one of the hosted domains
      // (an address on neither keeps the hosted relay: cloud-browser/__tests__/relay-host.test.ts).
      ...(isAppPageHost(new URL(address).host) ? { relay: productionRelayOrigin() } : {}),
      mcpResource: await (await resource(elsewhere('/.well-known/oauth-protected-resource/api/mcp'))).json(),
      mcpServer: await (await server(elsewhere('/.well-known/oauth-authorization-server'))).json(),
    }
  }

  it('every address the app hands out is on the setting, and none is on another domain', async () => {
    const out = await handedOut()
    const text = JSON.stringify(out)
    expect(text).not.toContain(never)
    expect(out).toMatchObject({
      appUrl: address,
      emailBase: address,
      sequence: expect.stringContaining(`${address}/account`),
      checkoutReturn: address,
      checkoutFromElsewhere: address,
      mcpResource: { resource: `${address}/api/mcp`, authorization_servers: [address] },
      mcpServer: { issuer: address, token_endpoint: `${address}/api/mcp/oauth/token` },
    })
    expect(String(out.unsubscribe).startsWith(`${address}/api/email/unsubscribe?`)).toBe(true)
    if ('relay' in out) expect(out.relay).toBe(`https://browser-relay.${new URL(address).host}`)
    expect(out.robots).toMatchObject({ sitemap: `${address}/sitemap.xml`, host: address })
  })
})

describe('the hosted domain is written in one place', () => {
  const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/
  const SKIP_DIRS = new Set(['node_modules', '__tests__', 'fixtures', '.output', '.eve', 'test'])

  function* sourceFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(path)
      } else if (SOURCE.test(entry.name) && !/\.test\./.test(entry.name)) {
        yield path
      }
    }
  }

  /** The lines of a file that are code: comments say where the app lives, and may. */
  function codeLines(text: string): string[] {
    const lines: string[] = []
    let inBlock = false
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (inBlock) {
        if (line.includes('*/')) inBlock = false
        continue
      }
      if (line.startsWith('/*') || line.startsWith('{/*')) {
        if (!line.includes('*/')) inBlock = true
        continue
      }
      if (line.startsWith('//') || line.startsWith('*')) continue
      lines.push(raw.replace(/\s\/\/.*$/, ''))
    }
    return lines
  }

  it('src/lib/app-url.ts, and nowhere else in src/ or agents/', () => {
    const root = process.cwd()
    const named: string[] = []
    for (const dir of ['src', 'agents']) {
      for (const file of sourceFiles(join(root, dir))) {
        if (codeLines(readFileSync(file, 'utf8')).some((line) => line.includes('nativeintelligence.dev'))) named.push(file.slice(root.length + 1))
      }
    }
    expect(named).toEqual(['src/lib/app-url.ts'])
  })
})
