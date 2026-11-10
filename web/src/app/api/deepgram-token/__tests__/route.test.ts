import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/deepgram-token — the usage gate (P1-1).
 *
 * The token this route hands out lets the client stream audio directly to
 * Deepgram, so an over-limit user MUST be blocked BEFORE the key is minted.
 * checkUsageLimits throws a raw 429/503 Response; the route must return it
 * verbatim rather than letting its own try/catch rewrap it as a 500.
 */

const hoisted = vi.hoisted(() => ({
  cookieGetUser: vi.fn(),
  checkUsageLimits: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: hoisted.cookieGetUser } }),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: vi.fn() } }),
}))

vi.mock('@/lib/device-tokens', () => ({
  isDeviceToken: () => false,
  resolveDeviceToken: vi.fn(),
}))

vi.mock('@/lib/ai/auth', () => ({
  checkUsageLimits: hoisted.checkUsageLimits,
}))

const { POST } = await import('@/app/api/deepgram-token/route')

function req(): Request {
  return new Request('https://nativeintelligence.dev/api/deepgram-token', { method: 'POST' })
}

beforeEach(() => {
  hoisted.cookieGetUser.mockReset()
  hoisted.checkUsageLimits.mockReset()
  hoisted.fetch.mockReset()
  vi.stubGlobal('fetch', hoisted.fetch)
  process.env.DEEPGRAM_API_KEY = 'dg-test-key'
})

describe('POST /api/deepgram-token — usage gate', () => {
  it('returns 401 when unauthenticated (never reaches the gate)', async () => {
    hoisted.cookieGetUser.mockResolvedValueOnce({ data: { user: null } })
    const res = await POST(req() as never)
    expect(res.status).toBe(401)
    expect(hoisted.checkUsageLimits).not.toHaveBeenCalled()
  })

  it('returns the 429 from checkUsageLimits without minting a Deepgram key', async () => {
    hoisted.cookieGetUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.checkUsageLimits.mockRejectedValueOnce(
      new Response(JSON.stringify({ error: 'Usage limit exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await POST(req() as never)
    expect(res.status).toBe(429)
    // Gate blocked before any Deepgram API call.
    expect(hoisted.fetch).not.toHaveBeenCalled()
  })

  it('returns the 503 from a fail-closed billing outage', async () => {
    hoisted.cookieGetUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.checkUsageLimits.mockRejectedValueOnce(
      new Response(JSON.stringify({ code: 'BILLING_UNAVAILABLE' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await POST(req() as never)
    expect(res.status).toBe(503)
    expect(hoisted.fetch).not.toHaveBeenCalled()
  })

  it('proceeds to mint a key when the gate passes', async () => {
    hoisted.cookieGetUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.checkUsageLimits.mockResolvedValueOnce(undefined)
    // 1st fetch → projects list; 2nd → create key
    hoisted.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ projects: [{ project_id: 'proj-1' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ key: 'dg-temp-key' }),
      })
    const res = await POST(req() as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token).toBe('dg-temp-key')
    expect(body.expiresIn).toBe(60)
    expect(hoisted.checkUsageLimits).toHaveBeenCalledWith('u1')
  })
})
