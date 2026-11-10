/**
 * The nightly memory cron: behind the cron secret. Learning is on by default
 * (2026-10-17): it runs the Mail tone pass (live reads, no copy kept, bounded
 * by a deadline) and queues the capture catch-up, bounded, side by side; one
 * failing never fails the other, and it answers with counts only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const hoisted = vi.hoisted(() => ({ run: vi.fn(), catchup: vi.fn(), send: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))
vi.mock('@/lib/memory/capture-catchup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/memory/capture-catchup')>()),
  runCaptureCatchup: hoisted.catchup,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/packs/memory-learning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/packs/memory-learning')>()),
  runMemoryLearningPass: hoisted.run,
}))

import { GET } from '../route'

const call = (auth?: string) =>
  GET(new NextRequest('https://nativeintelligence.dev/api/cron/memory-learning', { headers: auth ? { authorization: auth } : {} }))

describe('GET /api/cron/memory-learning', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'cron-secret')
    hoisted.run.mockReset()
    hoisted.run.mockResolvedValue({ candidates: 5, considered: 4, calls: 3, learned: 2, stoppedBy: 'done', outcomes: [{ workspaceId: 'w', userId: 'u', outcome: 'learned', learned: 2 }] })
    hoisted.catchup.mockReset()
    hoisted.catchup.mockResolvedValue({ candidates: 4, considered: 3, queued: 2, stoppedBy: 'done', outcomes: [{ sessionId: 's', outcome: 'queued' }] })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('refuses a call without the cron secret', async () => {
    expect((await call()).status).toBe(401)
    expect((await call('Bearer wrong-secret')).status).toBe(401)
    expect(hoisted.run).not.toHaveBeenCalled()
    expect(hoisted.catchup).not.toHaveBeenCalled()
  })

  it('runs the Mail tone pass for everyone, under a deadline, and answers with counts only', async () => {
    const res = await call('Bearer cron-secret')
    expect(hoisted.run).toHaveBeenCalledWith({ service: true }, expect.objectContaining({ deadlineMs: expect.any(Number) }))
    const deadline = (hoisted.run.mock.calls[0][1] as { deadlineMs: number }).deadlineMs
    // Room for the last person's reads and call (60s) inside maxDuration (300s).
    expect(deadline).toBeLessThanOrEqual(200_000)
    expect(await res.json()).toEqual({
      ok: true,
      mailPass: { candidates: 5, considered: 4, calls: 3, learned: 2, stoppedBy: 'done' },
      captureCatchup: { candidates: 4, considered: 3, queued: 2, stoppedBy: 'done' },
    })
  })

  it('a failed Mail tone pass never fails the run or the catch-up', async () => {
    hoisted.run.mockRejectedValueOnce(new Error('db down'))
    const res = await call('Bearer cron-secret')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mailPass: { failed: true }, captureCatchup: { queued: 2 } })
  })

  it('queues the capture catch-up, bounded, sending through Inngest; its failure never fails the run', async () => {
    await call('Bearer cron-secret')
    expect(hoisted.catchup).toHaveBeenCalledWith({ service: true }, expect.any(Function), expect.objectContaining({ maxSessions: expect.any(Number), deadlineMs: expect.any(Number) }))
    const send = hoisted.catchup.mock.calls[0][1] as (e: unknown) => Promise<unknown>
    await send({ id: 'x', name: 'chat/memory.capture', data: {} })
    expect(hoisted.send).toHaveBeenCalledWith({ id: 'x', name: 'chat/memory.capture', data: {} })

    hoisted.catchup.mockRejectedValueOnce(new Error('db down'))
    const res = await call('Bearer cron-secret')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { captureCatchup: unknown }).captureCatchup).toEqual({ failed: true })
  })
})
