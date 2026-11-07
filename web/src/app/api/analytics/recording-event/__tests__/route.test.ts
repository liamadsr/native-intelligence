import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/analytics/recording-event — the recording-lifecycle
 * telemetry sink.
 *
 * The route is an allowlist choke-point: only the recording-lifecycle subset of
 * ProductEvent may be forwarded to PostHog, so a compromised/buggy client can't
 * fire arbitrary product events through it. These tests pin the allowlist (an
 * event silently dropped here is invisible in PostHog — the exact bug that hid
 * `transcript_save_degraded` before it was added) and the fail-soft contract
 * (401 unauth, 400 unknown event, scalar-only property scrubbing).
 */

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  trackServerEvent: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: hoisted.getUser } }),
}))

vi.mock('@/lib/posthog', () => ({
  trackServerEvent: hoisted.trackServerEvent,
}))

const { POST } = await import('@/app/api/analytics/recording-event/route')

function req(body: unknown): Request {
  return new Request('https://dial8.ai/api/analytics/recording-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  hoisted.getUser.mockReset()
  hoisted.trackServerEvent.mockReset()
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.co' } } })
})

// The full set the route accepts. Kept explicit (not imported) so a mistaken
// deletion from the route's ALLOWED set fails a test here.
const ALLOWED = [
  'recording_resumed',
  'recovery_prompted',
  'recovery_declined',
  'recovery_skipped',
  'resume_failed',
  'transcription_connected',
  'transcription_source_stalled',
  'transcript_save_degraded',
  'final_transcript_save_failed',
  'system_audio_permission_status',
  'system_audio_permission_requested',
  'local_transcription_completed',
  'local_transcription_fallback',
] as const

describe('POST /api/analytics/recording-event — allowlist', () => {
  it('returns 401 and never tracks when unauthenticated', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    const res = await POST(req({ event: 'recording_resumed' }) as never)
    expect(res.status).toBe(401)
    expect(hoisted.trackServerEvent).not.toHaveBeenCalled()
  })

  it.each(ALLOWED)('forwards allowed event %s to PostHog', async (event) => {
    const res = await POST(req({ event }) as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tracked: true })
    expect(hoisted.trackServerEvent).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ userId: 'u1' }),
      expect.any(Object),
    )
  })

  it('forwards the new permission events with their scalar properties intact', async () => {
    await POST(
      req({
        event: 'system_audio_permission_status',
        properties: { capture_id: 'c1', system_audio_status: 'permissionDenied', app_version: '0.22.4' },
      }) as never,
    )
    expect(hoisted.trackServerEvent).toHaveBeenCalledWith(
      'system_audio_permission_status',
      expect.objectContaining({ userId: 'u1' }),
      { capture_id: 'c1', system_audio_status: 'permissionDenied', app_version: '0.22.4' },
    )
  })

  it('passes a null app_version through (getAppVersion may return null)', async () => {
    await POST(
      req({
        event: 'system_audio_permission_requested',
        properties: { source: 'settings', result: 'granted', app_version: null },
      }) as never,
    )
    expect(hoisted.trackServerEvent).toHaveBeenCalledWith(
      'system_audio_permission_requested',
      expect.objectContaining({ userId: 'u1' }),
      { source: 'settings', result: 'granted', app_version: null },
    )
  })

  it('returns 400 and never tracks for an event outside the allowlist', async () => {
    const res = await POST(req({ event: 'user_signed_up' }) as never)
    expect(res.status).toBe(400)
    expect(hoisted.trackServerEvent).not.toHaveBeenCalled()
  })

  it('returns 400 when the event is missing', async () => {
    const res = await POST(req({ properties: { a: 1 } }) as never)
    expect(res.status).toBe(400)
    expect(hoisted.trackServerEvent).not.toHaveBeenCalled()
  })

  it('drops non-scalar properties so a client cannot smuggle large payloads', async () => {
    await POST(
      req({
        event: 'system_audio_permission_status',
        properties: { app_version: '1.0.0', nested: { big: 'object' }, arr: [1, 2, 3] },
      }) as never,
    )
    expect(hoisted.trackServerEvent).toHaveBeenCalledWith(
      'system_audio_permission_status',
      expect.any(Object),
      { app_version: '1.0.0' },
    )
  })
})
