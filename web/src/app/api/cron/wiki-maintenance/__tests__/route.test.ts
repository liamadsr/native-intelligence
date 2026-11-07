import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for /api/cron/wiki-maintenance — the cron-auth gate.
 *
 * Vercel's cron scheduler ALWAYS issues GET, so the handler must be exported
 * as GET (a POST-only export returns 405 before the body runs — the bug this
 * route regressed on). The `Authorization: Bearer ${CRON_SECRET}` check must
 * still reject anything without the right bearer. POST is aliased to GET so
 * manual curl-triggering keeps working.
 *
 * The happy-path assertion uses the zero-workspace early return so the test
 * doesn't have to fake the full per-workspace query chain — reaching that
 * branch already proves the bearer passed and the handler ran.
 */

const hoisted = vi.hoisted(() => ({
  workspaceSelect: vi.fn(async () => ({ data: [] as Array<{ id: string }> })),
}))

// Only `.from('workspace').select('id')` is exercised on the zero-workspace path.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => hoisted.workspaceSelect(),
    }),
  }),
}))

const { GET, POST } = await import('@/app/api/cron/wiki-maintenance/route')

function req(bearer?: string): Request {
  const headers: Record<string, string> = {}
  if (bearer !== undefined) headers.authorization = bearer
  return new Request('https://dial8.ai/api/cron/wiki-maintenance', { method: 'GET', headers })
}

beforeEach(() => {
  hoisted.workspaceSelect.mockReset().mockResolvedValue({ data: [] })
  process.env.CRON_SECRET = 'test-secret'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
})

describe('GET /api/cron/wiki-maintenance — cron auth gate', () => {
  it('returns 401 with a missing bearer (never touches the DB)', async () => {
    const res = await GET(req() as never)
    expect(res.status).toBe(401)
    expect(hoisted.workspaceSelect).not.toHaveBeenCalled()
  })

  it('returns 401 with a wrong bearer', async () => {
    const res = await GET(req('Bearer nope') as never)
    expect(res.status).toBe(401)
    expect(hoisted.workspaceSelect).not.toHaveBeenCalled()
  })

  it('returns 200 with the correct bearer', async () => {
    const res = await GET(req('Bearer test-secret') as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ workspaces: [], total: 0 })
    expect(hoisted.workspaceSelect).toHaveBeenCalledTimes(1)
  })

  it('exports POST as an alias of GET so manual curl-triggering works', () => {
    expect(POST).toBe(GET)
  })
})
