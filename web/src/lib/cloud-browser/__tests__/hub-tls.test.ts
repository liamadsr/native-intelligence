/**
 * The edge's question before a certificate for a hub's name (Caddy's
 * on-demand TLS `ask`): src/lib/cloud-browser/hub-tls.ts and its route,
 * GET /api/internal/cloud-browser/tls-ask?domain=. Yes only for exactly one
 * label under CLOUD_BROWSER_HUB_DOMAIN, on the runtime backend, naming a
 * browser sandbox of this database; a 403 with no body for everything else,
 * never a 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rt = vi.hoisted(() => ({ isBrowserSandbox: vi.fn(async (id: string) => id === 'abc123') }))
vi.mock('@/lib/cloud-browser/backend-runtime', () => ({ createRuntimeBackend: () => ({ isBrowserSandbox: rt.isBrowserSandbox }) }))

import { clearHubTlsCache, hubLabel, hubTlsAllowed } from '../hub-tls'
import { GET } from '@/app/api/internal/cloud-browser/tls-ask/route'

const env = { CLOUD_BROWSER_BACKEND: 'runtime', CLOUD_BROWSER_HUB_DOMAIN: 'hub.example.test' }
const ask = (domain: string) => GET(new Request(`http://web:3000/api/internal/cloud-browser/tls-ask?domain=${encodeURIComponent(domain)}`))

beforeEach(() => {
  clearHubTlsCache()
  rt.isBrowserSandbox.mockReset().mockImplementation(async (id: string) => id === 'abc123')
  vi.unstubAllEnvs()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('hubLabel', () => {
  it('is the one label under the domain, or nothing', () => {
    expect(hubLabel('abc123.hub.example.test', 'hub.example.test')).toBe('abc123')
    expect(hubLabel('ABC123.Hub.Example.Test.', 'hub.example.test')).toBe('abc123')
    for (const bad of ['hub.example.test', '.hub.example.test', 'a.b.hub.example.test', 'abc-123.hub.example.test', 'abc123.hub.example.test.evil',
      'abc123hub.example.test', 'abc123.other.test', 'abc_1.hub.example.test', `${'a'.repeat(64)}.hub.example.test`, '', 'x'.repeat(300)]) {
      expect(hubLabel(bad, 'hub.example.test')).toBeNull()
    }
    expect(hubLabel(null, 'hub.example.test')).toBeNull()
  })
})

describe('the tls-ask route', () => {
  it('says yes to a browser sandbox’s hub name, with no body', async () => {
    const res = await ask('abc123.hub.example.test')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(rt.isBrowserSandbox).toHaveBeenCalledWith('abc123')
  })

  it('says no, with no detail, to any other name, sandbox, or a lookup that fails', async () => {
    for (const domain of ['zzz999.hub.example.test', 'a.abc123.hub.example.test', 'abc123.hub.example.test.evil.test', 'hub.example.test', 'abc123', '%00', '']) {
      const res = await ask(domain)
      expect(res.status).toBe(403)
      expect(await res.text()).toBe('')
    }
    rt.isBrowserSandbox.mockRejectedValueOnce(new Error('runtime down'))
    expect((await ask('fff000.hub.example.test')).status).toBe(403)
    expect((await GET(new Request('http://web:3000/api/internal/cloud-browser/tls-ask'))).status).toBe(403)
  })

  it('never asks the runtime about a name without the shape', async () => {
    await ask('a.b.hub.example.test')
    await ask('abc123.elsewhere.test')
    expect(rt.isBrowserSandbox).not.toHaveBeenCalled()
  })

  it('says no on the hosted backend, without a hub domain, or with an unknown backend', async () => {
    vi.stubEnv('CLOUD_BROWSER_BACKEND', '')
    expect((await ask('abc123.hub.example.test')).status).toBe(403)
    vi.stubEnv('CLOUD_BROWSER_BACKEND', 'nonsense')
    expect((await ask('abc123.hub.example.test')).status).toBe(403)
    vi.stubEnv('CLOUD_BROWSER_BACKEND', 'runtime')
    vi.stubEnv('CLOUD_BROWSER_HUB_DOMAIN', '')
    expect((await ask('abc123.hub.example.test')).status).toBe(403)
    expect(rt.isBrowserSandbox).not.toHaveBeenCalled()
  })
})

describe('hubTlsAllowed', () => {
  it('keeps an answer for a while, but never a failed lookup', async () => {
    let now = 1_000_000
    const deps = { now: () => now }
    expect(await hubTlsAllowed('abc123.hub.example.test', deps)).toBe(true)
    expect(await hubTlsAllowed('abc123.hub.example.test', deps)).toBe(true)
    expect(rt.isBrowserSandbox).toHaveBeenCalledTimes(1)
    now += 61_000
    expect(await hubTlsAllowed('abc123.hub.example.test', deps)).toBe(true)
    expect(rt.isBrowserSandbox).toHaveBeenCalledTimes(2)
    rt.isBrowserSandbox.mockRejectedValueOnce(new Error('down'))
    expect(await hubTlsAllowed('def456.hub.example.test', deps)).toBe(false)
    expect(await hubTlsAllowed('def456.hub.example.test', deps)).toBe(false)
    expect(rt.isBrowserSandbox).toHaveBeenCalledTimes(4)
  })
})
