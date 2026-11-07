// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Tests for the client-side fetch interceptor's auth behavior:
 *   - attaches Bearer + x-workspace-id on same-origin /api/ requests
 *   - never overwrites a caller-supplied Authorization header
 *   - refreshes-and-retries once on 401, sharing one refresh across concurrent failures
 *   - bounces to login when refresh fails, without looping
 *   - leaves non-/api/ and cross-origin requests untouched
 *   - sends x-workspace-id (and ONLY that) to the same-origin /eve/ mounts
 *
 * The module auto-calls patchFetch() on import, capturing whatever
 * window.fetch is at that moment as `originalFetch`. So each test stubs
 * window.fetch with a mock FIRST, then imports the module fresh
 * (vi.resetModules) so the mock becomes the underlying fetch.
 */

// Controllable Supabase client mock.
const getSession = vi.fn()
const refreshSession = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession, refreshSession } }),
}))

// Avoid the usage-limit side effects firing in tests.
vi.mock('../usage-limit-store', () => ({
  openUsageLimit: vi.fn(),
  parseUsageLimitResponse: vi.fn().mockResolvedValue(null),
}))

const WS_ID = '11111111-2222-3333-4444-555555555555'

// One test below replaces window.location with a stub to intercept the
// expiry redirect. jsdom's real location is captured here, at module load,
// so later tests can restore it — patchFetch() reads window.location.origin
// at patch time, and a stub without `origin` would silently make every
// absolute-URL same-origin check compare against the string "undefined".
const REAL_LOCATION = window.location
const ORIGIN = REAL_LOCATION.origin

/** Stub window.fetch, then import the module fresh so it patches our stub. */
async function loadWithFetch(underlying: typeof fetch) {
  vi.resetModules()
  vi.stubGlobal('fetch', underlying)
  // window.fetch and the global fetch are the same ref in jsdom.
  ;(window as unknown as { fetch: typeof fetch }).fetch = underlying
  const mod = await import('../workspace-fetch')
  mod.setClientWorkspaceId(WS_ID)
  return mod
}

function jsonResponse(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: REAL_LOCATION })
  getSession.mockReset()
  refreshSession.mockReset()
  getSession.mockResolvedValue({ data: { session: { access_token: 'tok-1' } } })
  refreshSession.mockResolvedValue({ data: { session: { access_token: 'tok-2' } }, error: null })
})

describe('patchFetch auth headers', () => {
  it('attaches Bearer token and x-workspace-id on same-origin /api/ requests', async () => {
    const underlying = vi.fn().mockResolvedValue(jsonResponse(200))
    await loadWithFetch(underlying as unknown as typeof fetch)

    await window.fetch('/api/account/views')

    expect(underlying).toHaveBeenCalledTimes(1)
    const [, init] = underlying.mock.calls[0]
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer tok-1')
    expect(headers.get('x-workspace-id')).toBe(WS_ID)
  })

  it('does not overwrite a caller-supplied Authorization header', async () => {
    const underlying = vi.fn().mockResolvedValue(jsonResponse(200))
    await loadWithFetch(underlying as unknown as typeof fetch)

    await window.fetch('/api/deepgram-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer caller-owned' },
    })

    const [, init] = underlying.mock.calls[0]
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer caller-owned')
    // We must not have read the session token when the caller owns auth.
    expect(getSession).not.toHaveBeenCalled()
  })

  it('leaves non-/api/ requests untouched', async () => {
    const underlying = vi.fn().mockResolvedValue(jsonResponse(200))
    await loadWithFetch(underlying as unknown as typeof fetch)

    await window.fetch('/dashboard')

    const [, init] = underlying.mock.calls[0]
    // No headers were synthesized.
    expect(init?.headers).toBeUndefined()
    expect(getSession).not.toHaveBeenCalled()
  })
})

describe('patchFetch 401 refresh-and-retry', () => {
  it('refreshes the session and retries once on 401, succeeding', async () => {
    const underlying = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    await loadWithFetch(underlying as unknown as typeof fetch)

    const res = await window.fetch('/api/account/views')

    expect(res.status).toBe(200)
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(underlying).toHaveBeenCalledTimes(2)
    // The retry carried the refreshed token.
    const [, retryInit] = underlying.mock.calls[1]
    expect(new Headers(retryInit.headers).get('authorization')).toBe('Bearer tok-2')
  })

  it('shares a single refresh across concurrent 401s', async () => {
    const underlying = vi.fn().mockImplementation((_input, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization')
      // First attempts (stale token) 401; retries (refreshed token) succeed.
      return Promise.resolve(auth === 'Bearer tok-2' ? jsonResponse(200) : jsonResponse(401))
    })
    await loadWithFetch(underlying as unknown as typeof fetch)

    const results = await Promise.all([
      window.fetch('/api/account/views'),
      window.fetch('/api/account/captures'),
      window.fetch('/api/account/actions'),
    ])

    expect(results.every((r) => r.status === 200)).toBe(true)
    // Three requests 401'd concurrently but only ONE refresh ran.
    expect(refreshSession).toHaveBeenCalledTimes(1)
  })

  it('does not retry when refresh fails, and surfaces session-expired once', async () => {
    refreshSession.mockResolvedValue({ data: { session: null }, error: { message: 'refresh failed' } })
    const underlying = vi.fn().mockResolvedValue(jsonResponse(401))
    await loadWithFetch(underlying as unknown as typeof fetch)

    // Stub location so the expiry redirect doesn't trigger jsdom navigation.
    const hrefSetter = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/account', search: '', set href(v: string) { hrefSetter(v) } },
    })

    const expired = vi.fn()
    window.addEventListener('dial8:session-expired', expired)

    const res = await window.fetch('/api/account/views')

    expect(res.status).toBe(401)
    // One initial attempt + no successful retry (refresh failed → no second send).
    expect(underlying).toHaveBeenCalledTimes(1)
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(hrefSetter).toHaveBeenCalledWith('/login?next=%2Faccount')
  })

  it('does not retry a 401 when the caller owns the Authorization header', async () => {
    const underlying = vi.fn().mockResolvedValue(jsonResponse(401))
    await loadWithFetch(underlying as unknown as typeof fetch)

    const res = await window.fetch('/api/deepgram-token', {
      headers: { Authorization: 'Bearer caller-owned' },
    })

    expect(res.status).toBe(401)
    expect(refreshSession).not.toHaveBeenCalled()
    expect(underlying).toHaveBeenCalledTimes(1)
  })
})

describe('patchFetch eve agent mounts', () => {
  const EVE_PATH = '/eve/chat-agent/v1/session/wrun_ABC/stream'

  it('attaches x-workspace-id on a relative /eve/ request', async () => {
    const underlying = vi.fn().mockResolvedValue(jsonResponse(200))
    await loadWithFetch(underlying as unknown as typeof fetch)

    await window.fetch(EVE_PATH)

    const [, init] = underlying.mock.calls[0]
    expect(new Headers(init.headers).get('x-workspace-id')).toBe(WS_ID)
  })

  it('attaches x-workspace-id on an absolute same-origin /eve/ URL', async () => {
    const underlying = vi.fn().mockResolvedValue(jsonResponse(200))
    await loadWithFetch(underlying as unknown as typeof fetch)

    await window.fetch(`${ORIGIN}${EVE_PATH}`)

    const [, init] = underlying.mock.calls[0]
    expect(new Headers(init.headers).get('x-workspace-id')).toBe(WS_ID)
  })

  it('does not overwrite a caller-supplied x-workspace-id', async () => {
    const underlying = vi.fn().mockResolvedValue(jsonResponse(200))
    await loadWithFetch(underlying as unknown as typeof fetch)

    await window.fetch(EVE_PATH, { headers: { 'x-workspace-id': 'caller-owned' } })

    const [, init] = underlying.mock.calls[0]
    expect(new Headers(init.headers).get('x-workspace-id')).toBe('caller-owned')
  })

  it('never injects Authorization, and does NOT refresh-and-retry a 401', async () => {
    const underlying = vi.fn().mockResolvedValue(jsonResponse(401))
    await loadWithFetch(underlying as unknown as typeof fetch)

    const res = await window.fetch(EVE_PATH)

    expect(res.status).toBe(401)
    const [, init] = underlying.mock.calls[0]
    expect(new Headers(init.headers).has('authorization')).toBe(false)
    // The eve client owns its own auth: no session read, no refresh, no retry.
    expect(getSession).not.toHaveBeenCalled()
    expect(refreshSession).not.toHaveBeenCalled()
    expect(underlying).toHaveBeenCalledTimes(1)
  })

  it('leaves a cross-origin URL containing /eve/ untouched', async () => {
    const underlying = vi.fn().mockResolvedValue(jsonResponse(200))
    await loadWithFetch(underlying as unknown as typeof fetch)

    await window.fetch('https://other.example.com/eve/chat-agent/v1/session')

    const [, init] = underlying.mock.calls[0]
    // No headers were synthesized.
    expect(init?.headers).toBeUndefined()
  })

  it('sends no workspace header when there is no active workspace id', async () => {
    const underlying = vi.fn().mockResolvedValue(jsonResponse(200))
    const mod = await loadWithFetch(underlying as unknown as typeof fetch)
    mod.setClientWorkspaceId(null)

    await window.fetch(EVE_PATH)

    const [, init] = underlying.mock.calls[0]
    expect(new Headers(init.headers).has('x-workspace-id')).toBe(false)
  })

  it('attaches the header when the input is a Request object', async () => {
    const underlying = vi.fn().mockResolvedValue(jsonResponse(200))
    await loadWithFetch(underlying as unknown as typeof fetch)

    await window.fetch(new Request(`${ORIGIN}${EVE_PATH}`))

    const [, init] = underlying.mock.calls[0]
    expect(new Headers(init.headers).get('x-workspace-id')).toBe(WS_ID)
  })
})

// The live agent's HUD shares storage with the app's windows but is not a
// workspace window: it sets the recording window's workspace for its own
// requests without rewriting the one the app reloads into.
describe('setClientWorkspaceId persist: false', () => {
  it('sends the workspace but leaves the stored one alone', async () => {
    const OTHER = '99999999-8888-7777-6666-555555555555'
    const underlying = vi.fn().mockResolvedValue(jsonResponse(200))
    const mod = await loadWithFetch(underlying as unknown as typeof fetch)
    expect(localStorage.getItem('dial8-workspace-id')).toBe(WS_ID)

    mod.setClientWorkspaceId(OTHER, { persist: false })
    await window.fetch('/api/account/contacts?search=a')

    const [, init] = underlying.mock.calls[0]
    expect(new Headers(init.headers).get('x-workspace-id')).toBe(OTHER)
    expect(mod.getClientWorkspaceId()).toBe(OTHER)
    expect(localStorage.getItem('dial8-workspace-id')).toBe(WS_ID)
  })
})
