import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture calls made to the PostHog node client without emitting anything.
const captureMock = vi.fn()

vi.mock('posthog-node', () => ({
  PostHog: vi.fn().mockImplementation(() => ({
    capture: captureMock,
  })),
}))

// trackAuthSession only fires when the client is configured, so give it a key.
const ORIGINAL_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY

// Import AFTER the mock is registered.
import { trackAuthSession } from '../posthog'

type AuthUser = Parameters<typeof trackAuthSession>[0]

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-123',
    email: 'new@example.com',
    created_at: new Date('2026-06-16T00:00:00Z').toISOString(),
    app_metadata: { provider: 'email' },
    user_metadata: { full_name: 'Ada Lovelace' },
    ...overrides,
  }
}

describe('trackAuthSession', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test'
    captureMock.mockClear()
  })

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY
    else process.env.NEXT_PUBLIC_POSTHOG_KEY = ORIGINAL_KEY
  })

  it('fires user_signed_up when the account was created seconds ago', () => {
    const now = new Date('2026-06-16T00:00:30Z').getTime() // 30s after created_at
    const result = trackAuthSession(user(), { alreadyTracked: false, nowMs: now })

    expect(result).toEqual({ cookieValue: '1' })
    expect(captureMock).toHaveBeenCalledTimes(1)
    const arg = captureMock.mock.calls[0][0]
    expect(arg.event).toBe('user_signed_up')
    expect(arg.distinctId).toBe('user-123')
    expect(arg.properties.method).toBe('email')
    expect(arg.properties.$set.email).toBe('new@example.com')
    expect(arg.properties.$set.name).toBe('Ada Lovelace')
  })

  it('fires user_logged_in when the account is old', () => {
    const now = new Date('2026-06-16T00:10:00Z').getTime() // 10min later
    trackAuthSession(user(), { alreadyTracked: false, nowMs: now })

    expect(captureMock).toHaveBeenCalledTimes(1)
    expect(captureMock.mock.calls[0][0].event).toBe('user_logged_in')
  })

  it('normalizes the Google provider to the oauth method', () => {
    const now = new Date('2026-06-16T01:00:00Z').getTime()
    trackAuthSession(user({ app_metadata: { provider: 'google' } }), {
      alreadyTracked: false,
      nowMs: now,
    })

    const props = captureMock.mock.calls[0][0].properties
    expect(props.method).toBe('oauth')
    expect(props.auth_provider).toBe('google')
  })

  it('is a no-op (no event, no cookie) when already tracked this session', () => {
    const result = trackAuthSession(user(), { alreadyTracked: true })
    expect(result).toBeNull()
    expect(captureMock).not.toHaveBeenCalled()
  })

  it('treats a missing created_at as a returning login, not a signup', () => {
    const now = new Date('2026-06-16T00:00:30Z').getTime()
    trackAuthSession(user({ created_at: undefined }), {
      alreadyTracked: false,
      nowMs: now,
    })
    expect(captureMock.mock.calls[0][0].event).toBe('user_logged_in')
  })
})
