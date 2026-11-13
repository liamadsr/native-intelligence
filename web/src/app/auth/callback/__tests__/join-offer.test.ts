import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * GET /auth/callback and join by email domain: when a workspace on the
 * person's verified domain is on offer, home is /join/team (once per
 * sign-in: the marker is written either way); an invite, share or MCP
 * redirect still wins.
 */

const m = vi.hoisted(() => ({
  exchange: vi.fn(),
  offer: vi.fn(async (_user: unknown) => false),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { exchangeCodeForSession: m.exchange } }) }))
vi.mock('@/lib/workspace-join/domain-offer', () => ({ hasDomainOfferAtSignIn: m.offer }))

const { GET } = await import('../route')

const USER = { id: 'user-riley', email: 'riley@acme.example', last_sign_in_at: '2026-11-13T10:00:00Z' }

function request(cookies: Record<string, string> = {}) {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
  return new NextRequest('https://app.example/auth/callback?code=abc', cookie ? { headers: { cookie } } : undefined)
}

beforeEach(() => {
  m.exchange.mockReset().mockResolvedValue({ data: { user: USER, session: {} }, error: null })
  m.offer.mockReset().mockResolvedValue(false)
})

describe('GET /auth/callback: join by email domain', () => {
  it('no offer: /account, and this sign-in is marked checked', async () => {
    const res = await GET(request())
    expect(res.headers.get('location')).toBe('https://app.example/account')
    expect(m.offer).toHaveBeenCalledWith(USER)
    expect(res.cookies.get('ni_join_checked')?.value).toBe(USER.last_sign_in_at)
  })

  it('an offer: /join/team instead of /account', async () => {
    m.offer.mockResolvedValue(true)
    const res = await GET(request())
    expect(res.headers.get('location')).toBe('https://app.example/join/team')
    expect(res.cookies.get('ni_join_checked')?.value).toBe(USER.last_sign_in_at)
  })

  it('an invite or join link being opened still wins', async () => {
    m.offer.mockResolvedValue(true)
    expect((await GET(request({ invite_redirect: '/invite/tok' }))).headers.get('location')).toBe('https://app.example/invite/tok')
  })
})
