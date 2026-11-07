import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Tests for GET /api/cron/linear-sync — the Linear read-back freshness driver.
 *
 * Invariants locked in:
 *  - Cron auth gate: 503 without CRON_SECRET, 401 on a bad/missing bearer, and
 *    neither dispatches anything.
 *  - EXACTLY ONE event per connected sync state — deliberately half the Jira
 *    tick. Jira also fires `tasks/jira-ensure-webhook` because a dynamic Jira
 *    webhook expires 30 days after its last refresh; Linear's webhooks are
 *    app-level (one URL + one signing secret in the OAuth app console,
 *    auto-provisioned per authorizing organization), so there is no registration
 *    to converge or keep alive and no such function exists. The last test in
 *    this file is the tripwire for anyone who "restores the missing half".
 *  - A failing send for one workspace never stops the fleet.
 *  - JSON summary shape.
 */

const hoisted = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ids: ['e'] })),
  listLinearSyncStates: vi.fn(),
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))
vi.mock('@/lib/tasks/linear-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, listLinearSyncStates: hoisted.listLinearSyncStates }
})

const { GET } = await import('@/app/api/cron/linear-sync/route')

const reconcileEvent = (id: string) => ({
  name: 'tasks/linear-reconcile',
  data: { syncStateId: id },
})

function request(bearer?: string): NextRequest {
  return new NextRequest('https://dial8.ai/api/cron/linear-sync', {
    headers: bearer !== undefined ? { authorization: bearer } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.send.mockResolvedValue({ ids: ['e'] })
  hoisted.listLinearSyncStates.mockResolvedValue([])
  vi.stubEnv('CRON_SECRET', 'test-secret')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/cron/linear-sync — cron auth gate', () => {
  it('returns 503 when CRON_SECRET is unset (no dispatch)', async () => {
    vi.stubEnv('CRON_SECRET', '')
    const res = await GET(request('Bearer whatever'))
    expect(res.status).toBe(503)
    expect(hoisted.send).not.toHaveBeenCalled()
    expect(hoisted.listLinearSyncStates).not.toHaveBeenCalled()
  })

  it('returns 401 with a missing bearer', async () => {
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('returns 401 with a wrong bearer', async () => {
    const res = await GET(request('Bearer nope'))
    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
  })
})

describe('GET /api/cron/linear-sync — dispatch', () => {
  it('fires the reconcile event for each connected sync state', async () => {
    hoisted.listLinearSyncStates.mockResolvedValue([{ id: 'tss-1', workspaceId: 'ws-1' }])
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, sync_states: 1, reconcile_triggered: 1 })
    expect(hoisted.send).toHaveBeenCalledWith(reconcileEvent('tss-1'))
  })

  it('dispatches across the whole fleet', async () => {
    hoisted.listLinearSyncStates.mockResolvedValue([
      { id: 'tss-1', workspaceId: 'ws-1' },
      { id: 'tss-2', workspaceId: 'ws-2' },
    ])
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()

    expect(body).toMatchObject({ sync_states: 2, reconcile_triggered: 2 })
    expect(hoisted.send).toHaveBeenCalledTimes(2)
  })

  it('is a clean no-op when nobody has Linear connected', async () => {
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ sync_states: 0 })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('keeps going when one dispatch fails', async () => {
    hoisted.listLinearSyncStates.mockResolvedValue([
      { id: 'tss-1', workspaceId: 'ws-1' },
      { id: 'tss-2', workspaceId: 'ws-2' },
    ])
    hoisted.send.mockRejectedValueOnce(new Error('inngest down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ sync_states: 2, reconcile_triggered: 1 })
    expect(hoisted.send).toHaveBeenCalledTimes(2)
    errSpy.mockRestore()
  })

  it('returns 500 when the sync-state listing fails', async () => {
    hoisted.listLinearSyncStates.mockRejectedValue(new Error('db down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET(request('Bearer test-secret'))
    expect(res.status).toBe(500)
    expect(hoisted.send).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('fires NOTHING resembling an ensure-webhook event', async () => {
    // The tripwire. Linear has no per-account webhook registration — adding a
    // convergence dispatch here would send an event nothing subscribes to, and
    // the JSON summary would start reporting work that never happens.
    hoisted.listLinearSyncStates.mockResolvedValue([{ id: 'tss-1', workspaceId: 'ws-1' }])
    await GET(request('Bearer test-secret'))

    const names = (hoisted.send.mock.calls as unknown as Array<[{ name: string }]>).map(
      (c) => c[0].name,
    )
    expect(names).toEqual(['tasks/linear-reconcile'])
  })
})
