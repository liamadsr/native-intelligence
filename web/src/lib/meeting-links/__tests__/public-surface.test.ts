/**
 * The public meeting surface, as the app serves it: only the meeting's own
 * path is reached without a session (the proxy leaves /m/<token> and the
 * guest's routes under it alone, and still holds /account and the members'
 * meeting routes under /api/account to a signed-in person); the old domain's
 * forward never moves it (its cookie is the domain's own); its pages are
 * out of the index, send no referrer and may use the camera and microphone.
 * And the limiter in memory.
 */
import { vi } from 'vitest'

vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  ;(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage
})
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
}))
vi.mock('server-only', () => ({}))

import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { describe, expect, it } from 'vitest'
import { config, proxy } from '@/proxy'
import { routeRule } from '@/lib/old-domain-forward'
import { headers as nextHeaders } from '../../../../next.config.mjs'
import { MemoryLimiter } from '../limits'

const TOKEN = 'Ab3_dEf-ghIJklMNopQRstUVwxYZ0123'
const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url, headers: { host: new URL(url).host } })

describe('who reaches what without a session', () => {
  it('a meeting link and its guest’s routes: the proxy never runs on them', () => {
    for (const p of ['', '/join', '/lobby', '/token', '/notice', '/leave']) expect(matches(`https://nativeintelligence.dev/m/${TOKEN}${p}`), p).toBe(false)
  })

  it('the members’ meeting routes and the app stay behind a session (401 / sign-in)', async () => {
    for (const url of ['https://nativeintelligence.dev/api/account/meeting-links', 'https://nativeintelligence.dev/api/account/meeting-links/guests/x', 'https://nativeintelligence.dev/account?meeting=x']) {
      expect(matches(url), url).toBe(true)
    }
    const api = await proxy(new NextRequest('https://nativeintelligence.dev/api/account/meeting-links', { method: 'POST' }))
    expect(api.status).toBe(401)
    const page = await proxy(new NextRequest('https://nativeintelligence.dev/account?meeting=x'))
    expect(new URL(page.headers.get('location') ?? 'https://x/').pathname).toBe('/login')
  })

  it('the old domain’s forward never moves a meeting link (a flow: its cookie is that domain’s)', () => {
    expect(routeRule(`/m/${TOKEN}`)?.kind).toBe('flow')
    expect(routeRule(`/m/${TOKEN}/lobby`)?.kind).toBe('flow')
    expect(routeRule('/meetings')).toBeNull()
  })
})

describe('the meeting page’s headers', () => {
  it('out of the index, no referrer, never cached, the camera and microphone allowed', async () => {
    const rules = (await nextHeaders()) as Array<{ source: string; headers: Array<{ key: string; value: string }> }>
    const m = rules.find((r) => r.source === '/m/:path*')
    expect(m).toBeTruthy()
    const of = (key: string) => m!.headers.find((x) => x.key === key)?.value
    expect(of('X-Robots-Tag')).toBe('noindex, nofollow')
    expect(of('Referrer-Policy')).toBe('no-referrer')
    expect(of('Cache-Control')).toBe('private, no-store')
    expect(of('Permissions-Policy')).toContain('camera=(self)')
    expect(of('Permissions-Policy')).toContain('microphone=(self)')
    // Later rules win: the meeting's come after the app-wide one.
    expect(rules.indexOf(m!)).toBeGreaterThan(rules.findIndex((r) => r.source === '/(.*)'))
  })
})

describe('the limiter in memory', () => {
  it('counts per bucket and key within a window, then starts again', () => {
    const l = new MemoryLimiter()
    const limit = { bucket: 't', max: 2, windowSeconds: 60 }
    expect([l.hit(limit, 'a', 0), l.hit(limit, 'a', 1), l.hit(limit, 'a', 2), l.hit(limit, 'b', 2)]).toEqual([true, true, false, true])
    expect(l.hit(limit, 'a', 60_000)).toBe(true)
  })

  it('stays bounded in size', () => {
    const l = new MemoryLimiter(100)
    for (let i = 0; i < 1000; i++) l.hit({ bucket: 't', max: 1, windowSeconds: 60 }, `k${i}`, i)
    expect(l.size).toBeLessThanOrEqual(100)
  })
})
