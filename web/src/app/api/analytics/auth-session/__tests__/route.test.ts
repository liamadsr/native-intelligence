import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/analytics/auth-session seeds Triage at signup: inside the signup
 * window it runs seedSignupLoops for the user (every ping, idempotently), a
 * returning user's ping never touches it, and a seeding failure never breaks
 * the ping.
 */

const hoisted = vi.hoisted(() => ({
  user: null as null | { id: string; created_at: string; user_metadata: Record<string, unknown> },
  seedSignupLoops: vi.fn(async () => ({ workspaceIds: ['ws-1'] })),
  consumeSignupEdition: vi.fn(async () => ({ stamped: false, edition: null, shouldClear: false })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: hoisted.user } }),
      updateUser: () => Promise.resolve({}),
    },
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/flows/seed-signup-loops', () => ({ seedSignupLoops: hoisted.seedSignupLoops }))
vi.mock('@/lib/editions/attribution', () => ({
  SIGNUP_EDITION_COOKIE: 'd8_signup_edition',
  consumeSignupEdition: hoisted.consumeSignupEdition,
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceIdSafe: async () => 'ws-1' }))
vi.mock('@/lib/posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/posthog')>()),
  trackAuthSession: () => null,
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}))

import { POST } from '../route'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString()

beforeEach(() => {
  hoisted.seedSignupLoops.mockClear()
  hoisted.consumeSignupEdition.mockClear()
})

describe('POST /api/analytics/auth-session — Triage at signup', () => {
  it('seeds for a brand-new account', async () => {
    hoisted.user = { id: 'new-user', created_at: minutesAgo(1), user_metadata: {} }
    const res = await POST()
    expect(res.status).toBe(200)
    expect(hoisted.seedSignupLoops).toHaveBeenCalledWith({ service: true }, { userId: 'new-user' })
    // The same signup verdict reaches attribution, so the two never disagree.
    expect(hoisted.consumeSignupEdition).toHaveBeenCalledWith(undefined, 'ws-1', 'new-user', { isNewSignup: true })
  })

  it("never runs for a returning user's ping", async () => {
    hoisted.user = { id: 'old-user', created_at: '2026-01-01T00:00:00.000Z', user_metadata: {} }
    await POST()
    expect(hoisted.seedSignupLoops).not.toHaveBeenCalled()
  })

  it('a seeding failure never breaks the ping', async () => {
    hoisted.user = { id: 'new-user', created_at: minutesAgo(1), user_metadata: {} }
    hoisted.seedSignupLoops.mockRejectedValueOnce(new Error('db down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST()
    expect(res.status).toBe(200)
    expect(errorSpy).toHaveBeenCalledWith('[auth-session] seed-signup-loops failed', { error: 'db down' })
    errorSpy.mockRestore()
  })

  it('does nothing when unauthenticated', async () => {
    hoisted.user = null
    const res = await POST()
    expect(res.status).toBe(401)
    expect(hoisted.seedSignupLoops).not.toHaveBeenCalled()
  })
})
