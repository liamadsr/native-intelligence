/**
 * POST /api/twilio/sms/status: signed as the inbound webhook is (over
 * TWILIO_WEBHOOK_URL + "/status" when a proxy rewrites the host, the URL the
 * callback itself names), and nothing is read before the signature; a signed
 * outcome reaches handleSmsStatus with its code as a number.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeTwilioSignature } from '@/lib/twilio/signature'

const h = vi.hoisted(() => ({ inputs: [] as Array<Record<string, unknown>>, fail: false }))

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/sms/status', () => ({
  handleSmsStatus: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    if (h.fail) throw new Error('db down')
    h.inputs.push(input)
    return 'resent'
  }),
}))

import { POST } from '../route'

const TOKEN = 'test-auth-token'
const FIELDS = { MessageSid: 'SM1', MessageStatus: 'failed', ErrorCode: '30035', From: '+16465550104', To: '+14155551234' }

function post(url: string, fields: Record<string, string>, signedOver: string | null = url): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signedOver ? { 'x-twilio-signature': computeTwilioSignature(signedOver, fields, TOKEN) } : {}) },
    body: new URLSearchParams(fields).toString(),
  })
}

beforeEach(() => {
  h.inputs.length = 0
  h.fail = false
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN)
  vi.stubEnv('TWILIO_WEBHOOK_URL', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/twilio/sms/status', () => {
  it('a signed outcome reaches the handler, its code a number', async () => {
    const res = await POST(post('https://nativeintelligence.dev/api/twilio/sms/status', FIELDS))
    expect(res.status).toBe(204)
    expect(h.inputs).toEqual([{ sid: 'SM1', status: 'failed', errorCode: 30035, from: '+16465550104', to: '+14155551234' }])
  })

  it('no code is null, not NaN', async () => {
    const fields = { MessageSid: 'SM1', MessageStatus: 'delivered', From: '+16465550104', To: '+14155551234' }
    await POST(post('https://nativeintelligence.dev/api/twilio/sms/status', fields))
    expect(h.inputs[0].errorCode).toBeNull()
  })

  it('unsigned, or signed over another URL: 403, nothing handled', async () => {
    expect((await POST(post('https://nativeintelligence.dev/api/twilio/sms/status', FIELDS, null))).status).toBe(403)
    expect((await POST(post('https://nativeintelligence.dev/api/twilio/sms/status', FIELDS, 'https://nativeintelligence.dev/api/twilio/sms'))).status).toBe(403)
    expect(h.inputs).toHaveLength(0)
  })

  it('behind a proxy: checked over TWILIO_WEBHOOK_URL + "/status", the URL the callback names', async () => {
    vi.stubEnv('TWILIO_WEBHOOK_URL', 'https://tunnel.example.com/api/twilio/sms')
    const res = await POST(post('http://localhost:3000/api/twilio/sms/status', FIELDS, 'https://tunnel.example.com/api/twilio/sms/status'))
    expect(res.status).toBe(204)
    expect(h.inputs).toHaveLength(1)
  })

  it('no auth token: 503, nothing read', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', '')
    expect((await POST(post('https://nativeintelligence.dev/api/twilio/sms/status', FIELDS))).status).toBe(503)
  })

  it('a failed write is a 500, said loudly', async () => {
    h.fail = true
    expect((await POST(post('https://nativeintelligence.dev/api/twilio/sms/status', FIELDS))).status).toBe(500)
  })
})
