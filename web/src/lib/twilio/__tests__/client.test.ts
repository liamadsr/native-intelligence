/**
 * sendSms's senders (client.ts): through Native Intelligence's messaging service a text is
 * pinned (its pool holds every agent number), to the person's agent number
 * with a status callback when there is one, else to the Native Intelligence number; a
 * sender the service doesn't hold, or an agent number carriers refuse
 * outright as unregistered, falls back.
 */
import { describe, expect, it, vi } from 'vitest'
import { sendSms } from '../client'

const NI = '+19287698774'
const AGENT = '+16465550104'
const config = { accountSid: 'AC1', authToken: 't', fromNumber: NI, messagingServiceSid: 'MG1' }

/** Twilio answering each send in turn (a code is a refusal). */
function twilio(...answers: Array<number | null>) {
  return vi.fn(async (_url: string, _init: RequestInit) => {
    const code = answers.shift() ?? null
    return code === null ? new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 }) : new Response(JSON.stringify({ code }), { status: 400 })
  })
}
const forms = (fetch: ReturnType<typeof twilio>) => fetch.mock.calls.map((c) => Object.fromEntries(new URLSearchParams(String(c[1].body))))

describe('sendSms through the messaging service', () => {
  it('pins the Native Intelligence number, so Twilio never picks someone’s agent number', async () => {
    const fetch = twilio()
    expect(await sendSms('+14155551234', 'hi', { fetch: fetch as never, config })).toEqual({ ok: true, sid: 'SM1' })
    expect(forms(fetch)).toEqual([{ To: '+14155551234', Body: 'hi', MessagingServiceSid: 'MG1', From: NI }])
  })

  it('from the agent number when named, with a status callback', async () => {
    const fetch = twilio()
    await sendSms('+14155551234', 'hi', { fetch: fetch as never, config, sender: AGENT })
    expect(forms(fetch)).toEqual([{ To: '+14155551234', Body: 'hi', MessagingServiceSid: 'MG1', From: AGENT, StatusCallback: 'https://nativeintelligence.dev/api/twilio/sms/status' }])
  })

  it('a sender the service doesn’t hold (21711): the Native Intelligence number, then the service’s own pick', async () => {
    const fetch = twilio(21711, 21711)
    expect(await sendSms('+14155551234', 'hi', { fetch: fetch as never, config, sender: AGENT })).toEqual({ ok: true, sid: 'SM1' })
    expect(forms(fetch).map((f) => [f.From ?? null, f.MessagingServiceSid, f.StatusCallback ?? null])).toEqual([
      [AGENT, 'MG1', 'https://nativeintelligence.dev/api/twilio/sms/status'],
      [NI, 'MG1', null],
      [null, 'MG1', null],
    ])
  })

  it('an agent number refused outright as unregistered (30035): the Native Intelligence number', async () => {
    const fetch = twilio(30035)
    expect(await sendSms('+14155551234', 'hi', { fetch: fetch as never, config, sender: AGENT })).toEqual({ ok: true, sid: 'SM1' })
    expect(forms(fetch).map((f) => f.From)).toEqual([AGENT, NI])
  })

  it('any other refusal is the answer, never a second send', async () => {
    const fetch = twilio(21610)
    expect(await sendSms('+14155551234', 'hi', { fetch: fetch as never, config, sender: AGENT })).toEqual({ ok: false, reason: 'unsubscribed', code: 21610, status: 400 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('the Native Intelligence number refused as unregistered is not retried: there is nothing behind it', async () => {
    const fetch = twilio(30035)
    expect(await sendSms('+14155551234', 'hi', { fetch: fetch as never, config })).toMatchObject({ ok: false, code: 30035 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('sendSms without a messaging service', () => {
  it('From the Native Intelligence number, an agent number aside (there is no pool)', async () => {
    const fetch = twilio()
    await sendSms('+14155551234', 'hi', { fetch: fetch as never, config: { ...config, messagingServiceSid: null }, sender: AGENT })
    expect(forms(fetch)).toEqual([{ To: '+14155551234', Body: 'hi', From: NI }])
  })
})
