import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Tests for GET /api/cron/asana-sync — the Asana read-back freshness driver.
 *
 * Invariants locked in:
 *  - Cron auth gate: 503 without CRON_SECRET, 401 on a bad/missing bearer, and
 *    neither dispatches anything.
 *  - BOTH events fire per connected sync state (registration self-heal +
 *    reconciliation); each function owns its own gate, so the cron stays dumb.
 *  - A failing send for one workspace never stops the fleet.
 *  - JSON summary shape.
 */

const hoisted = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ids: ['e'] })),
  listAsanaSyncStates: vi.fn(),
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, listAsanaSyncStates: hoisted.listAsanaSyncStates }
})

const { GET } = await import('@/app/api/cron/asana-sync/route')

const ensureEvent = (id: string) => ({
  name: 'tasks/asana-ensure-webhook',
  data: { syncStateId: id },
})
const reconcileEvent = (id: string) => ({
  name: 'tasks/asana-reconcile',
  data: { syncStateId: id },
})

function request(bearer?: string): NextRequest {
  return new NextRequest('https://dial8.ai/api/cron/asana-sync', {
    headers: bearer !== undefined ? { authorization: bearer } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.send.mockResolvedValue({ ids: ['e'] })
  hoisted.listAsanaSyncStates.mockResolvedValue([])
  vi.stubEnv('CRON_SECRET', 'test-secret')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/cron/asana-sync — cron auth gate', () => {
  it('returns 503 when CRON_SECRET is unset (no dispatch)', async () => {
    vi.stubEnv('CRON_SECRET', '')
    const res = await GET(request('Bearer whatever'))
    expect(res.status).toBe(503)
    expect(hoisted.send).not.toHaveBeenCalled()
    expect(hoisted.listAsanaSyncStates).not.toHaveBeenCalled()
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

describe('GET /api/cron/asana-sync — dispatch', () => {
  it('fires BOTH events for each connected sync state', async () => {
    hoisted.listAsanaSyncStates.mockResolvedValue([{ id: 'tss-1', workspaceId: 'ws-1' }])
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      sync_states: 1,
      ensure_webhook_triggered: 1,
      reconcile_triggered: 1,
    })
    expect(hoisted.send).toHaveBeenCalledWith(ensureEvent('tss-1'))
    expect(hoisted.send).toHaveBeenCalledWith(reconcileEvent('tss-1'))
  })

  it('dispatches across the whole fleet', async () => {
    hoisted.listAsanaSyncStates.mockResolvedValue([
      { id: 'tss-1', workspaceId: 'ws-1' },
      { id: 'tss-2', workspaceId: 'ws-2' },
    ])
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()

    expect(body).toMatchObject({
      sync_states: 2,
      ensure_webhook_triggered: 2,
      reconcile_triggered: 2,
    })
    expect(hoisted.send).toHaveBeenCalledTimes(4)
  })

  it('is a clean no-op when nobody has Asana connected', async () => {
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ sync_states: 0 })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('keeps going when one dispatch fails', async () => {
    hoisted.listAsanaSyncStates.mockResolvedValue([
      { id: 'tss-1', workspaceId: 'ws-1' },
      { id: 'tss-2', workspaceId: 'ws-2' },
    ])
    // First send (tss-1 ensure) throws; everything else must still fire.
    hoisted.send.mockRejectedValueOnce(new Error('inngest down'))

    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ensure_webhook_triggered: 1, reconcile_triggered: 2 })
    expect(hoisted.send).toHaveBeenCalledTimes(4)
  })

  it('returns 500 when the sync-state listing fails', async () => {
    hoisted.listAsanaSyncStates.mockRejectedValue(new Error('db down'))
    const res = await GET(request('Bearer test-secret'))
    expect(res.status).toBe(500)
    expect(hoisted.send).not.toHaveBeenCalled()
  })
})
