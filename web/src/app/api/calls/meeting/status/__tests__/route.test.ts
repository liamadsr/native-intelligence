import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<Record<string, string>> }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
vi.mock('@/lib/meeting-agent/call-status', () => ({
  handleMeetingCallStatus: async (_svc: unknown, args: Record<string, string>) => (h.calls.push(args), 'failed'),
}))

import { POST } from '../route'
import { computeTwilioSignature } from '@/lib/twilio/signature'

const ATT = '22222222-2222-4222-8222-222222222222'
const URL_ = `https://app.example.com/api/calls/meeting/status?attendance=${ATT}`

function post(params: Record<string, string>, opts: { token?: string; url?: string } = {}): Request {
  const url = opts.url ?? URL_
  const sig = computeTwilioSignature(url, params, opts.token ?? 'tok')
  return new Request(url, { method: 'POST', headers: { 'x-twilio-signature': sig, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() })
}

beforeEach(() => {
  h.calls = []
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok')
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/calls/meeting/status', () => {
  it("hands a signed status change to the attendance's handler", async () => {
    const res = await POST(post({ CallSid: 'CA1', CallStatus: 'busy' }))
    expect(res.status).toBe(204)
    expect(h.calls).toEqual([{ attendanceId: ATT, callSid: 'CA1', status: 'busy' }])
  })
  it('refuses an unsigned or wrongly signed one, and a missing attendance', async () => {
    expect((await POST(post({ CallSid: 'CA1', CallStatus: 'busy' }, { token: 'other' }))).status).toBe(403)
    expect((await POST(post({ CallSid: 'CA1' }, { url: 'https://app.example.com/api/calls/meeting/status?attendance=nope' }))).status).toBe(400)
    expect(h.calls).toEqual([])
  })
  it('is closed with no Twilio token', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', '')
    expect((await POST(post({ CallSid: 'CA1' }))).status).toBe(503)
  })
})
