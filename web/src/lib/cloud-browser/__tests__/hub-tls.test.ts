/**
 * The edge's question before a certificate for a hub's name (Caddy's
 * on-demand TLS `ask`): src/lib/cloud-browser/hub-tls.ts and its route,
 * GET /api/internal/cloud-browser/tls-ask?domain=. Yes only for exactly one
 * label under CLOUD_BROWSER_HUB_DOMAIN, on the runtime backend, naming the
 * sandbox of a browser whose row is starting or running; a 403 with no body
 * for everything else, never a 500. Answered from the database alone: the
 * runtime's client is not even loadable here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ live: new Set<string>(['abc123']), asked: [] as string[], fail: false }))
vi.mock('@/lib/cloud-browser/store', () => ({
  hubSessionLive: async (id: string) => {
    db.asked.push(id)
    if (db.fail) throw new Error('db down')
    return db.live.has(id)
  },
}))
// No runtime client at all: any attempt to load one fails the test.
vi.mock('@/lib/cloud-browser/runtime-client', () => ({ loadRuntimeBrowserClient: () => { throw new Error('tls-ask must never ask the runtime') } }))
vi.mock('e2b', () => { throw new Error('tls-ask must never load the runtime client') })

import { clearHubTlsCache, hubLabel, hubTlsAllowed } from '../hub-tls'
import { GET } from '@/app/api/internal/cloud-browser/tls-ask/route'

const env = { CLOUD_BROWSER_BACKEND: 'runtime', CLOUD_BROWSER_HUB_DOMAIN: 'hub.example.test' }
const ask = (domain: string) => GET(new Request(`http://web:3000/api/internal/cloud-browser/tls-ask?domain=${encodeURIComponent(domain)}`))

beforeEach(() => {
  clearHubTlsCache()
  db.live = new Set(['abc123'])
  db.asked = []
  db.fail = false
  vi.unstubAllEnvs()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  // Not even its settings: nothing here may need them.
  for (const k of ['SANDBOX_RUNTIME_API_URL', 'SANDBOX_RUNTIME_TRAFFIC_URL', 'SANDBOX_RUNTIME_KEY']) vi.stubEnv(k, '')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('hubLabel', () => {
  it('is the one label under the domain, or nothing', () => {
    expect(hubLabel('abc123.hub.example.test', 'hub.example.test')).toBe('abc123')
    expect(hubLabel('ABC123.Hub.Example.Test.', 'hub.example.test')).toBe('abc123')
    for (const bad of ['hub.example.test', '.hub.example.test', 'a.b.hub.example.test', 'abc-123.hub.example.test', 'abc123.hub.example.test.evil',
      'abc123hub.example.test', 'abc123.other.test', 'abc_1.hub.example.test', 'ab%.hub.example.test', `${'a'.repeat(64)}.hub.example.test`, '', 'x'.repeat(300)]) {
      expect(hubLabel(bad, 'hub.example.test')).toBeNull()
    }
    expect(hubLabel(null, 'hub.example.test')).toBeNull()
  })
})

describe('the tls-ask route', () => {
  it('says yes to a live browser’s hub name, with no body, from the database alone', async () => {
    const res = await ask('abc123.hub.example.test')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(db.asked).toEqual(['abc123'])
  })

  it('says no, with no detail, to any other name, a stopped browser, or a lookup that fails', async () => {
    for (const domain of ['zzz999.hub.example.test', 'a.abc123.hub.example.test', 'abc123.hub.example.test.evil.test', 'hub.example.test', 'abc123', '%00', '']) {
      const res = await ask(domain)
      expect(res.status).toBe(403)
      expect(await res.text()).toBe('')
    }
    db.fail = true
    expect((await ask('fff000.hub.example.test')).status).toBe(403)
    expect((await GET(new Request('http://web:3000/api/internal/cloud-browser/tls-ask'))).status).toBe(403)
  })

  it('never looks up a name without the shape', async () => {
    await ask('a.b.hub.example.test')
    await ask('abc123.elsewhere.test')
    await ask('ab_%.hub.example.test')
    expect(db.asked).toEqual([])
  })

  it('says no on the hosted backend, without a hub domain, or with an unknown backend', async () => {
    vi.stubEnv('CLOUD_BROWSER_BACKEND', '')
    expect((await ask('abc123.hub.example.test')).status).toBe(403)
    vi.stubEnv('CLOUD_BROWSER_BACKEND', 'nonsense')
    expect((await ask('abc123.hub.example.test')).status).toBe(403)
    vi.stubEnv('CLOUD_BROWSER_BACKEND', 'runtime')
    vi.stubEnv('CLOUD_BROWSER_HUB_DOMAIN', '')
    expect((await ask('abc123.hub.example.test')).status).toBe(403)
    expect(db.asked).toEqual([])
  })
})

describe('hubTlsAllowed', () => {
  it('keeps a yes a minute and a no 10 s, but never a failed lookup', async () => {
    let now = 1_000_000
    const deps = { now: () => now }
    expect(await hubTlsAllowed('abc123.hub.example.test', deps)).toBe(true)
    expect(await hubTlsAllowed('abc123.hub.example.test', deps)).toBe(true)
    expect(db.asked).toEqual(['abc123'])
    expect(await hubTlsAllowed('def456.hub.example.test', deps)).toBe(false)
    expect(await hubTlsAllowed('def456.hub.example.test', deps)).toBe(false)
    expect(db.asked).toEqual(['abc123', 'def456'])
    now += 11_000
    expect(await hubTlsAllowed('def456.hub.example.test', deps)).toBe(false)
    expect(db.asked).toHaveLength(3)
    now += 50_000
    expect(await hubTlsAllowed('abc123.hub.example.test', deps)).toBe(true)
    expect(db.asked).toHaveLength(4)
    db.fail = true
    expect(await hubTlsAllowed('fff000.hub.example.test', deps)).toBe(false)
    expect(await hubTlsAllowed('fff000.hub.example.test', deps)).toBe(false)
    expect(db.asked).toHaveLength(6)
  })

  it('a flood of noes never pushes a yes out', async () => {
    const now = () => 5_000_000
    expect(await hubTlsAllowed('abc123.hub.example.test', { now })).toBe(true)
    for (let i = 0; i < 2_500; i++) await hubTlsAllowed(`n${i}.hub.example.test`, { now })
    const asked = db.asked.length
    expect(await hubTlsAllowed('abc123.hub.example.test', { now })).toBe(true)
    expect(db.asked.length).toBe(asked)
  })
})

describe('reached as the edge reaches it', () => {
  it('answers 200 itself on the stack’s own address, with no forwarding headers and no redirect', async () => {
    const res = await GET(new Request('http://ni-app-proxy:8080/api/internal/cloud-browser/tls-ask?domain=abc123.hub.example.test', { headers: { host: 'ni-app-proxy:8080' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })

  it('never runs the proxy (no sign-in check, no old-domain forward) on it, whatever the host', async () => {
    const { unstable_doesMiddlewareMatch } = await import('next/experimental/testing/server')
    const { config } = await import('@/proxy')
    for (const host of ['ni-app-proxy:8080', 'dial8.ai', 'www.dial8.ai', 'nativeintelligence.dev']) {
      for (const path of ['/api/internal/cloud-browser/tls-ask?domain=abc123.hub.example.test', '/api/internal/cloud-browser/tls-ask/?domain=x']) {
        expect(unstable_doesMiddlewareMatch({ config, url: `http://${host}${path}`, headers: { host } }), `${host}${path}`).toBe(false)
      }
    }
  })
})
