/**
 * The daily notification purge (src/app/api/cron/notification-purge/route.ts):
 * the cron secret is required, it calls cleanup_old_notifications() once and
 * reports the count, and a failed call is a 500 that deletes nothing. The
 * same run prunes presence rows untouched for 30 days (migration 454); that
 * prune failing is logged and reported, never a failed run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const hoisted = vi.hoisted(() => ({
  rpc: vi.fn(async (_name: string) => ({ data: 3 as unknown, error: null as { message: string } | null })),
  denied: null as Response | null,
  service: { rpc: null as unknown },
  prune: vi.fn(async (_service: unknown): Promise<number> => 2),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.service }))
vi.mock('@/lib/presence/store', () => ({ prunePresence: hoisted.prune }))
vi.mock('@/lib/api-auth', () => ({ requireCronSecret: () => hoisted.denied }))

const { GET } = await import('../route')

const request = () => new NextRequest('http://localhost/api/cron/notification-purge')

beforeEach(() => {
  hoisted.rpc.mockClear()
  hoisted.prune.mockReset()
  hoisted.prune.mockResolvedValue(2)
  hoisted.service.rpc = hoisted.rpc
  hoisted.denied = null
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('GET /api/cron/notification-purge', () => {
  it('calls the purge once and reports what it deleted', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deleted: 3, presencePruned: 2 })
    expect(hoisted.rpc).toHaveBeenCalledWith('cleanup_old_notifications')
    expect(hoisted.prune).toHaveBeenCalledTimes(1)
    expect(hoisted.prune).toHaveBeenCalledWith(hoisted.service)
  })

  it('refuses without the cron secret, and calls nothing', async () => {
    hoisted.denied = new Response('no', { status: 401 })
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(hoisted.rpc).not.toHaveBeenCalled()
    expect(hoisted.prune).not.toHaveBeenCalled()
  })

  it('a failed presence prune is reported, and the notification purge still runs', async () => {
    hoisted.prune.mockRejectedValueOnce(new Error('relation "user_presence" does not exist'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deleted: 3, presencePruned: null })
    expect(hoisted.rpc).toHaveBeenCalledWith('cleanup_old_notifications')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a failed call is a 500', async () => {
    hoisted.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET(request())
    err.mockRestore()
    expect(res.status).toBe(500)
  })
})
