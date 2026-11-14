import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * POST /api/analytics/auth-session and join by email domain, for sign-ins
 * that finish in the browser (password, desktop): checked once per sign-in on
 * its own marker (not the analytics cookie, which lasts an hour and needs
 * PostHog), answering `joinOffer: true` when there is something to offer.
 */

const hoisted = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  cookies: {} as Record<string, string>,
  offer: vi.fn(async (_user: unknown) => false),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: hoisted.user } }), updateUser: () => Promise.resolve({}) },
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/flows/seed-signup-loops', () => ({ seedSignupLoops: vi.fn(async () => ({})) }))
vi.mock('@/lib/editions/attribution', () => ({
  SIGNUP_EDITION_COOKIE: 'd8_signup_edition',
  consumeSignupEdition: vi.fn(async () => ({ shouldClear: false })),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceIdSafe: async () => 'ws-1' }))
vi.mock('@/lib/posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/posthog')>()),
  // PostHog unconfigured: no analytics cookie, which must not matter here.
  trackAuthSession: () => null,
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name in hoisted.cookies ? { value: hoisted.cookies[name] } : undefined) }),
}))
vi.mock('@/lib/workspace-join/domain-offer', () => ({ hasDomainOfferAtSignIn: hoisted.offer }))

import { POST } from '../route'

const SIGNED_IN = '2026-11-13T10:00:00Z'

beforeEach(() => {
  hoisted.user = { id: 'user-riley', created_at: '2026-01-01T00:00:00Z', last_sign_in_at: SIGNED_IN, user_metadata: {} }
  hoisted.cookies = {}
  hoisted.offer.mockReset().mockResolvedValue(false)
})

describe('POST /api/analytics/auth-session: join by email domain', () => {
  it('first ping of a sign-in: checks, answers joinOffer, and marks the sign-in', async () => {
    hoisted.offer.mockResolvedValue(true)
    const res = await POST()
    expect(await res.json()).toEqual({ tracked: false, joinOffer: true })
    expect(res.cookies.get('ni_join_checked')?.value).toBe(SIGNED_IN)
  })

  it('the same sign-in is never checked twice, even without the analytics cookie', async () => {
    hoisted.cookies = { ni_join_checked: SIGNED_IN }
    hoisted.offer.mockResolvedValue(true)
    const res = await POST()
    expect(await res.json()).toEqual({ tracked: false })
    expect(hoisted.offer).not.toHaveBeenCalled()
  })

  it('a new sign-in checks again', async () => {
    hoisted.cookies = { ni_join_checked: '2026-11-12T09:00:00Z' }
    await POST()
    expect(hoisted.offer).toHaveBeenCalledTimes(1)
  })
})
