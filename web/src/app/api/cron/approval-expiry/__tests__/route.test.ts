/**
 * GET /api/cron/approval-expiry: the hourly backstop that expires held tool
 * calls whose 24 h wait is over (and their cards), behind the cron secret.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))
const h = vi.hoisted(() => ({ expire: vi.fn(async (): Promise<number> => 3) }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/safety/approvals', () => ({ expireLapsedApprovals: h.expire, EXPIRE_SWEEP_MAX: 100 }))
// F4: the parked-run sweep rides the same cron.
const parked = vi.hoisted(() => ({ sweep: vi.fn(async () => ({ retold: 1, ended: 0, purged: 2 })) }))
vi.mock('@/lib/flows/flow-step-resume', () => ({ sweepParkedRuns: parked.sweep }))

import { GET } from '../route'

const req = (bearer?: string) =>
  new NextRequest('http://localhost/api/cron/approval-expiry', { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} })

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'test-secret')
  h.expire.mockClear()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/cron/approval-expiry', () => {
  it('refuses a call without the cron secret, and expires nothing', async () => {
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req('wrong-secret'))).status).toBe(401)
    expect(h.expire).not.toHaveBeenCalled()
  })

  it('expires the lapsed approvals on the service client and says how many', async () => {
    const res = await GET(req('test-secret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, expired: 3, parked: { retold: 1, ended: 0, purged: 2 } })
    expect(h.expire).toHaveBeenCalledWith({ service: true })
    expect(parked.sweep).toHaveBeenCalledWith({ service: true })
  })

  it('sweeps again while a batch comes back full (100), up to ten batches', async () => {
    h.expire.mockResolvedValueOnce(100).mockResolvedValueOnce(100).mockResolvedValueOnce(7)
    expect(await (await GET(req('test-secret'))).json()).toEqual({ ok: true, expired: 207, parked: { retold: 1, ended: 0, purged: 2 } })
    expect(h.expire).toHaveBeenCalledTimes(3)
    h.expire.mockClear()
    h.expire.mockResolvedValue(100)
    expect(await (await GET(req('test-secret'))).json()).toEqual({ ok: true, expired: 1000, parked: { retold: 1, ended: 0, purged: 2 } })
    expect(h.expire).toHaveBeenCalledTimes(10)
    h.expire.mockResolvedValue(3)
  })

  it('a failed sweep answers 500 so the run shows as failed', async () => {
    h.expire.mockRejectedValueOnce(new Error('expire lapsed approvals: down'))
    const res = await GET(req('test-secret'))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/down/) })
  })
})
