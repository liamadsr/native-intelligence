/**
 * The Mac's web_fetch through eve's REAL fetch (not mocked): a public-looking
 * hostname whose DNS answer is a private address is never connected to. The
 * lookup is swapped under eve's own `import { lookup } from 'node:dns'`
 * (syncBuiltinESMExports), so no network is needed. Redirects run each hop
 * through the same lookup and checks (eve's requestPublicUrl); they need a
 * live server, so they aren't driven here.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ai/auth', () => ({ logUsage: vi.fn() }))

import { __resetMacWebCaps, createMacWebTools } from '../web-tools'

const require = createRequire(import.meta.url)
const dns = require('node:dns') as typeof import('node:dns')
const realLookup = dns.lookup
const asked: string[] = []

type Callback = (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void

function answer(address: string) {
  return ((host: string, options: unknown, callback?: Callback) => {
    const cb = (typeof options === 'function' ? options : callback) as Callback
    const opts = (typeof options === 'object' && options ? options : {}) as { all?: boolean }
    asked.push(host)
    const family = address.includes(':') ? 6 : 4
    if (opts.all) cb(null, [{ address, family }])
    else cb(null, address, family)
  }) as unknown as typeof dns.lookup
}

const ctx = { sessionId: 'ssrf', userId: 'u1', workspaceId: 'w1', defer: () => undefined }
const fetchUrl = (url: string) => createMacWebTools(ctx).web_fetch.execute!({ url } as never, {} as never) as Promise<Record<string, unknown>>

beforeEach(() => {
  __resetMacWebCaps()
  asked.length = 0
})
afterEach(() => {
  dns.lookup = realLookup
  syncBuiltinESMExports()
})

describe('web_fetch: a hostname that resolves to a private address', () => {
  for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '192.168.0.10', '::1', 'fd00::1']) {
    it(`is refused when it resolves to ${address}`, async () => {
      dns.lookup = answer(address)
      syncBuiltinESMExports()
      const out = await fetchUrl('https://public-looking.example.com/page')
      expect(asked).toContain('public-looking.example.com')
      expect(out).toMatchObject({ success: false })
      expect(String(out.error)).toMatch(/localhost, private, link-local, or reserved/)
    })
  }
})
