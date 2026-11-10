import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/analytics/hud-event — the live HUD's telemetry sink.
 *
 * Same contract as recording-event: an allowlist choke-point (only the HUD's
 * subset of ProductEvent reaches PostHog; an event dropped here is invisible,
 * which is the failure this telemetry exists to end), 401 unauth, 400 unknown
 * event, scalar-only properties. Plus what's its own: auth through
 * requireUser (so the HUD window's Bearer counts), strings and the number of
 * properties capped, keys that could overwrite the server's own refused, and
 * the workspace from the body (null included) or the x-workspace-id header,
 * only as a UUID.
 */

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  trackServerEvent: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireUser: async () => {
    const { data } = await hoisted.getUser()
    return data.user ? { supabase: {}, user: data.user } : Response.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
  },
}))

vi.mock('@/lib/posthog', () => ({
  trackServerEvent: hoisted.trackServerEvent,
}))

const { POST } = await import('@/app/api/analytics/hud-event/route')

const WS = '61db7809-ef27-4559-929b-b985dd63cd4f'

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://nativeintelligence.dev/api/analytics/hud-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  hoisted.getUser.mockReset()
  hoisted.trackServerEvent.mockReset()
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.co' } } })
})

// Kept explicit (not imported) so a mistaken deletion from the route's set fails here.
const ALLOWED = [
  'live_hud_open_requested',
  'live_hud_close_requested',
  'live_hud_nudge_received',
  'live_hud_loaded',
  'live_hud_shown',
  'live_hud_hidden',
  'live_hud_nudge_arrived',
  'live_hud_nudge_displayed',
  'live_hud_ensured',
] as const

describe('POST /api/analytics/hud-event', () => {
  it('returns 401 and never tracks when unauthenticated', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    const res = await POST(req({ event: 'live_hud_loaded' }) as never)
    expect(res.status).toBe(401)
    expect(hoisted.trackServerEvent).not.toHaveBeenCalled()
  })

  it.each(ALLOWED)('forwards allowed event %s to PostHog', async (event) => {
    const res = await POST(req({ event }) as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tracked: true })
    expect(hoisted.trackServerEvent).toHaveBeenCalledWith(event, expect.objectContaining({ userId: 'u1', email: 'a@b.co' }), expect.any(Object))
  })

  it('returns 400 for an event outside the allowlist, a missing event, or a body that is not JSON', async () => {
    for (const body of [{ event: 'user_signed_up' }, { event: 'recording_resumed' }, { properties: {} }, 'not json']) {
      const res = await POST(req(body) as never)
      expect(res.status).toBe(400)
    }
    expect(hoisted.trackServerEvent).not.toHaveBeenCalled()
  })

  it('keeps scalar properties, drops the rest, and caps strings', async () => {
    await POST(
      req({
        event: 'live_hud_nudge_displayed',
        properties: {
          nudge_id: 'n1',
          window_visible: false,
          latency_ms: 420,
          capture_id: null,
          nested: { big: 'object' },
          arr: [1],
          nan: Number.NaN,
          long: 'x'.repeat(5000),
        },
      }) as never,
    )
    const props = hoisted.trackServerEvent.mock.calls[0][2]
    expect(props).toEqual({ nudge_id: 'n1', window_visible: false, latency_ms: 420, capture_id: null, nan: null, long: 'x'.repeat(200) })
  })

  it("refuses keys that could overwrite the server's own, or aren't plain snake_case", async () => {
    await POST(
      req({
        event: 'live_hud_loaded',
        properties: { host: 'window', workspace_id: 'other', platform: 'desktop', environment: 'production', $set: 'x', $process_person_profile: false, 'Bad Key': 1 },
      }) as never,
    )
    expect(hoisted.trackServerEvent.mock.calls[0][2]).toEqual({ host: 'window' })
  })

  it('caps how many properties one event carries', async () => {
    const properties = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, i]))
    await POST(req({ event: 'live_hud_loaded', properties }) as never)
    expect(Object.keys(hoisted.trackServerEvent.mock.calls[0][2])).toHaveLength(24)
  })

  it("takes the workspace from the body (null included), else workspace-fetch's header, and only as a UUID", async () => {
    const other = '00000000-0000-4000-8000-000000000000'
    await POST(req({ event: 'live_hud_loaded', workspaceId: WS }, { 'x-workspace-id': other }) as never)
    // The HUD window says null until it knows its call's: another window's header must not stand in.
    await POST(req({ event: 'live_hud_loaded', workspaceId: null }, { 'x-workspace-id': other }) as never)
    await POST(req({ event: 'live_hud_loaded' }, { 'x-workspace-id': WS }) as never)
    await POST(req({ event: 'live_hud_loaded' }, { 'x-workspace-id': 'not-a-uuid' }) as never)
    await POST(req({ event: 'live_hud_loaded' }) as never)
    const workspaces = hoisted.trackServerEvent.mock.calls.map((c) => c[1].workspaceId)
    expect(workspaces).toEqual([WS, null, WS, null, null])
  })
})
