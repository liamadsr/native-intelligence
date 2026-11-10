import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for /api/cron/mcp-cleanup — the cron-auth gate.
 *
 * Vercel's cron scheduler ALWAYS issues GET, so the handler must be exported
 * as GET (a POST-only export returns 405 before the body runs — the bug this
 * route regressed on). The `Authorization: Bearer ${CRON_SECRET}` check must
 * still reject anything without the right bearer. POST is aliased to GET so
 * manual curl-triggering keeps working.
 */

const hoisted = vi.hoisted(() => ({
  deleteResult: vi.fn(() => ({ count: 0 })),
}))

// Chainable stub: `.from(t).delete({count}).lt(col, val)` resolves to a count.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      delete: () => ({
        lt: async () => hoisted.deleteResult(),
      }),
    }),
  }),
}))

const { GET, POST } = await import('@/app/api/cron/mcp-cleanup/route')

function req(bearer?: string): Request {
  const headers: Record<string, string> = {}
  if (bearer !== undefined) headers.authorization = bearer
  return new Request('https://nativeintelligence.dev/api/cron/mcp-cleanup', { method: 'GET', headers })
}

beforeEach(() => {
  hoisted.deleteResult.mockReset().mockReturnValue({ count: 0 })
  process.env.CRON_SECRET = 'test-secret'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
})

describe('GET /api/cron/mcp-cleanup — cron auth gate', () => {
  it('returns 401 with a missing bearer (never touches the DB)', async () => {
    const res = await GET(req() as never)
    expect(res.status).toBe(401)
    expect(hoisted.deleteResult).not.toHaveBeenCalled()
  })

  it('returns 401 with a wrong bearer', async () => {
    const res = await GET(req('Bearer nope') as never)
    expect(res.status).toBe(401)
    expect(hoisted.deleteResult).not.toHaveBeenCalled()
  })

  it('returns 200 with the correct bearer and runs all three sweeps', async () => {
    hoisted.deleteResult
      .mockReturnValueOnce({ count: 3 }) // auth codes
      .mockReturnValueOnce({ count: 5 }) // expired tokens
      .mockReturnValueOnce({ count: 2 }) // external oauth states
    const res = await GET(req('Bearer test-secret') as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      success: true,
      auth_codes_deleted: 3,
      expired_tokens_deleted: 5,
      external_oauth_states_deleted: 2,
    })
    expect(hoisted.deleteResult).toHaveBeenCalledTimes(3)
  })

  it('exports POST as an alias of GET so manual curl-triggering works', () => {
    expect(POST).toBe(GET)
  })
})
