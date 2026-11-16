import { describe, expect, it, vi } from 'vitest'

/**
 * GET /api/cron/page-watch: refused without the cron secret (before any
 * read), and with it runs one pass on the service client and answers its
 * counts.
 */
const { pass, denied } = vi.hoisted(() => ({
  pass: vi.fn(async (_supabase: unknown, _now: Date) => ({ due: 2, told: 1, baselines: 1 })),
  denied: { value: null as Response | null },
}))

vi.mock('@/lib/flows/page-watch/tick', () => ({ runPageWatchPass: pass }))
vi.mock('@/lib/api-auth', () => ({ requireCronSecret: () => denied.value }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))

import { GET } from '../route'

const request = () => new Request('http://localhost/api/cron/page-watch') as never

describe('GET /api/cron/page-watch', () => {
  it('without the secret: refused, and nothing runs', async () => {
    denied.value = new Response('no', { status: 401 })
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(pass).not.toHaveBeenCalled()
  })

  it('with it: one pass on the service client, its counts answered', async () => {
    denied.value = null
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, due: 2, told: 1, baselines: 1 })
    expect(pass).toHaveBeenCalledTimes(1)
    expect(pass.mock.calls[0][0]).toEqual({ service: true })
    expect(pass.mock.calls[0][1]).toBeInstanceOf(Date)
  })
})
