/**
 * Tests for POST /api/account/knowledge/reweave — the manual "regenerate
 * briefs now" lever (plan item 18).
 *
 * Branches locked in:
 *   - 401 when the caller isn't authed (requireWorkspaceMember returns a Response)
 *   - 202 on the happy path AND inngest.send fired with knowledge/weave.requested
 *   - 429 when the same workspace re-requests inside the cooldown window
 *   - 500 (still short-circuits the cooldown) when inngest.send throws
 *
 * The route keeps a module-scope per-workspace cooldown Map, so tests that must
 * start from a clean cooldown re-import the route via vi.resetModules().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  inngestSend: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.inngestSend },
}))

function authContext(workspaceId = 'workspace-1') {
  return {
    supabase: {},
    user: { id: 'user-1' },
    workspaceId,
    member: { id: 'member-1', role: 'owner' },
  }
}

const UNAUTHED_RESPONSE = new Response(JSON.stringify({ error: 'Unauthorized' }), {
  status: 401,
  headers: { 'Content-Type': 'application/json' },
})

/**
 * Re-import the route so its module-scope cooldown Map starts empty. Needed
 * for any test that asserts a *first* (non-rate-limited) request.
 */
async function freshRoute() {
  vi.resetModules()
  return import('@/app/api/account/knowledge/reweave/route')
}

beforeEach(() => {
  hoisted.requireWorkspaceMember.mockReset()
  hoisted.inngestSend.mockReset()
  hoisted.requireWorkspaceMember.mockResolvedValue(authContext())
  hoisted.inngestSend.mockResolvedValue(undefined)
})

describe('POST /api/account/knowledge/reweave', () => {
  it('returns 401 when the caller is not a workspace member', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(UNAUTHED_RESPONSE)
    const { POST } = await freshRoute()
    const res = await POST()
    expect(res.status).toBe(401)
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('returns 202 and fires knowledge/weave.requested on the happy path', async () => {
    const { POST } = await freshRoute()
    const res = await POST()
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, queued: 'knowledge/weave.requested' })
    expect(hoisted.inngestSend).toHaveBeenCalledWith({ name: 'knowledge/weave.requested' })
    expect(hoisted.inngestSend).toHaveBeenCalledTimes(1)
  })

  it('rate-limits a second request from the same workspace within the cooldown', async () => {
    const { POST } = await freshRoute()

    const first = await POST()
    expect(first.status).toBe(202)
    expect(hoisted.inngestSend).toHaveBeenCalledTimes(1)

    const second = await POST()
    expect(second.status).toBe(429)
    expect(second.headers.get('Retry-After')).toBeTruthy()
    // The cooldown short-circuits before the event is fired a second time.
    expect(hoisted.inngestSend).toHaveBeenCalledTimes(1)
  })

  it('does not arm the cooldown when inngest.send throws (returns 500)', async () => {
    hoisted.inngestSend.mockRejectedValueOnce(new Error('inngest down'))
    const { POST } = await freshRoute()

    const failed = await POST()
    expect(failed.status).toBe(500)

    // Because the first attempt never armed the cooldown, a retry is allowed
    // through (and this time succeeds).
    const retry = await POST()
    expect(retry.status).toBe(202)
    expect(hoisted.inngestSend).toHaveBeenCalledTimes(2)
  })
})
