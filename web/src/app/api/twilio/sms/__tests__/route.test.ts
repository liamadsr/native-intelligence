/**
 * POST /api/twilio/sms hands the texted number on (roadmap A and B): the
 * `To` Twilio posts reaches handleInboundSms as `to`, with `from` and `body`.
 * `InboundSms.to` is optional, so a merge that dropped the line would still
 * typecheck while every text lost its line (a business's number would read
 * as the Native Intelligence one). The signature is checked before anything is read.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  inputs: [] as Array<Record<string, unknown>>,
  signatureOk: true,
  authToken: 'test-auth-token' as string | null,
}))

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/sms/inbound', () => ({
  handleInboundSms: vi.fn(async (input: Record<string, unknown>) => {
    h.inputs.push(input)
    return { outcome: 'queued', reply: null }
  }),
  supabaseInboundDeps: vi.fn(() => ({})),
}))
vi.mock('@/lib/sms/deliver', () => ({ deliverTextToHomeThread: vi.fn() }))
vi.mock('@/lib/sms/phone-verification', () => ({ codeKey: () => 'key' }))
vi.mock('@/lib/sms/signup', () => ({ handleSignupText: vi.fn(), supabaseSignupDeps: vi.fn() }))
vi.mock('@/lib/twilio/config', () => ({ appOrigin: () => 'https://dial8.ai', twilioAuthToken: () => h.authToken }))
vi.mock('@/lib/twilio/signature', () => ({
  TWILIO_SIGNATURE_HEADER: 'x-twilio-signature',
  twilioRequestUrl: (request: Request) => request.url,
  validateTwilioSignature: () => h.signatureOk,
}))

import { POST } from '../route'

function twilioPost(fields: Record<string, string>): Request {
  return new Request('https://dial8.ai/api/twilio/sms', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'sig' },
    body: new URLSearchParams(fields).toString(),
  })
}

beforeEach(() => {
  h.inputs.length = 0
  h.signatureOk = true
  h.authToken = 'test-auth-token'
})

describe('POST /api/twilio/sms', () => {
  it('hands the texted number on as `to`, with `from` and `body`', async () => {
    const res = await POST(twilioPost({ From: '+12125550199', To: '+16465550173', Body: 'How much for an 8x10?', MessageSid: 'SM1', NumMedia: '0' }))
    expect(res.status).toBe(200)
    expect(h.inputs).toEqual([{ from: '+12125550199', to: '+16465550173', body: 'How much for an 8x10?', sid: 'SM1', numMedia: 0, media: [], optOutType: null }])
  })

  it('hands on the attached files (a texted contacts file, roadmap track G1)', async () => {
    await POST(twilioPost({ From: '+12125550199', Body: '', MessageSid: 'SM4', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/SM4/Media/ME1', MediaContentType0: 'text/csv' }))
    expect(h.inputs[0]).toMatchObject({ numMedia: 1, media: [{ url: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/SM4/Media/ME1', contentType: 'text/csv' }] })
  })

  it('a post with no To hands on `to: null` (the Native Intelligence line)', async () => {
    await POST(twilioPost({ From: '+12125550199', Body: 'hi', MessageSid: 'SM2' }))
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]).toMatchObject({ from: '+12125550199', to: null, body: 'hi' })
  })

  it('a bad signature is refused before anything is handled', async () => {
    h.signatureOk = false
    const res = await POST(twilioPost({ From: '+12125550199', To: '+16465550173', Body: 'hi', MessageSid: 'SM3' }))
    expect(res.status).toBe(403)
    expect(h.inputs).toHaveLength(0)
  })

  it('with no auth token, texting is off and nothing is handled', async () => {
    h.authToken = null
    expect((await POST(twilioPost({ From: '+12125550199', To: '+16465550173', Body: 'hi' }))).status).toBe(503)
    expect(h.inputs).toHaveLength(0)
  })

  it('the call carries exactly one `to` (two tracks each added it once; a merge kept both)', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/api/twilio/sms/route.ts'), 'utf8')
    expect(source.match(/^\s*to: params\.To \?\? null,$/gm)).toHaveLength(1)
  })
})
