/**
 * The daily local-agent transcript purge (src/app/api/cron/local-agent-purge/route.ts):
 * the cron secret is required before anything runs, it runs the purge once and
 * reports what it did, and a failed purge is a 500. The rule itself is pinned
 * in src/lib/local-agent/__tests__/retention.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const result = { ok: true, cutoff: 'c', scanned: 4, sessionsPurged: 1, sessionsKept: 0, eventsDeleted: 4, truncated: false }
const hoisted = vi.hoisted(() => ({
  purge: vi.fn(async (_svc: unknown) => ({}) as Record<string, unknown>),
  denied: null as Response | null,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ svc: true }) }))
vi.mock('@/lib/api-auth', () => ({ requireCronSecret: () => hoisted.denied }))
vi.mock('@/lib/local-agent/retention', () => ({ purgeOldEvents: hoisted.purge }))

const { GET } = await import('../route')

const request = () => new NextRequest('http://localhost/api/cron/local-agent-purge')

beforeEach(() => {
  hoisted.purge.mockReset()
  hoisted.purge.mockResolvedValue(result)
  hoisted.denied = null
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('GET /api/cron/local-agent-purge', () => {
  it('runs the purge once and reports it', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(result)
    expect(hoisted.purge).toHaveBeenCalledTimes(1)
  })

  it('refuses without the cron secret, and runs nothing', async () => {
    hoisted.denied = new Response('no', { status: 401 })
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(hoisted.purge).not.toHaveBeenCalled()
  })

  it('a failed purge is a 500', async () => {
    hoisted.purge.mockResolvedValueOnce({ ...result, ok: false })
    const res = await GET(request())
    expect(res.status).toBe(500)
  })
})
