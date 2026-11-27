import { describe, expect, it, vi } from 'vitest'
import { claimsMeetingLeg, dialMeeting, hashJoinToken, meetingStatusCallbackUrl, meetingTokenOfSipHeaders, meetingTwiml, newJoinToken } from '@/lib/meeting-agent/dial-out'

const SECRET = 'ab'.repeat(32)
const SIP = 'sip:proj_test@sip.api.openai.com;transport=tls'

describe('the one-time join token', () => {
  it('is 64 hex characters, fresh each time, and only its sha256 is kept', () => {
    const a = newJoinToken()
    const b = newJoinToken()
    expect(a.token).toMatch(/^[0-9a-f]{64}$/)
    expect(a.token).not.toBe(b.token)
    expect(a.hash).toBe(hashJoinToken(a.token))
    expect(a.hash).not.toBe(a.token)
  })
  it('is read from the incoming SIP headers only when well formed', () => {
    const { token } = newJoinToken()
    expect(meetingTokenOfSipHeaders([{ name: 'x-ni-meeting', value: token }])).toBe(token)
    expect(meetingTokenOfSipHeaders([{ name: 'X-NI-Meeting', value: 'not-a-token' }])).toBeNull()
    expect(meetingTokenOfSipHeaders([{ name: 'From', value: '<sip:+15555550100@x>' }])).toBeNull()
    expect(claimsMeetingLeg([{ name: 'X-NI-Meeting', value: 'junk' }])).toBe(true)
    expect(claimsMeetingLeg([{ name: 'From', value: 'x' }])).toBe(false)
  })
})

describe("the call's TwiML", () => {
  it('keys in the PIN, then bridges to OpenAI with the trunk secret and the token, capped', () => {
    const { token } = newJoinToken()
    const xml = meetingTwiml({ digits: 'wwwwww123456789#', sipUri: SIP, trunkSecret: SECRET, token, timeLimitSeconds: 1800 })
    expect(xml).toContain('<Play digits="wwwwww123456789#"/>')
    expect(xml).toContain('<Dial timeLimit="1800">')
    expect(xml).toContain(`<Sip>${SIP}?X-NI-Trunk=${SECRET}&amp;X-NI-Meeting=${token}</Sip>`)
    expect(xml.indexOf('<Play')).toBeLessThan(xml.indexOf('<Dial'))
  })
  it('refuses anything it would write unchecked', () => {
    const { token } = newJoinToken()
    const base = { digits: 'wwww1#', sipUri: SIP, trunkSecret: SECRET, token, timeLimitSeconds: 60 }
    expect(() => meetingTwiml({ ...base, digits: '1"/><Hangup/>' })).toThrow(/digits/)
    expect(() => meetingTwiml({ ...base, trunkSecret: 'not hex!' })).toThrow(/hex/)
    expect(() => meetingTwiml({ ...base, token: 'short' })).toThrow(/token/)
  })
  it("posts status changes to its own signed URL", () => {
    expect(meetingStatusCallbackUrl('a-1', 'https://app.example.com/')).toBe('https://app.example.com/api/calls/meeting/status?attendance=a-1')
  })
})

describe('the Twilio call', () => {
  const config = { accountSid: 'AC123', authToken: 'tok' }
  it('POSTs the call with its TwiML inline, the ring timeout, the cap and the status callback', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: 'CA1' }), { status: 201 }))
    const r = await dialMeeting(config, { from: '+15555550100', to: '+15555550142', twiml: '<Response/>', timeLimitSeconds: 1800, statusCallback: 'https://app.example.com/s' }, { fetch: fetchMock as never })
    expect(r).toEqual({ ok: true, callSid: 'CA1' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json')
    const form = new URLSearchParams(String(init.body))
    expect(form.get('To')).toBe('+15555550142')
    expect(form.get('From')).toBe('+15555550100')
    expect(form.get('Twiml')).toBe('<Response/>')
    expect(form.get('TimeLimit')).toBe('1800')
    expect(form.get('StatusCallback')).toBe('https://app.example.com/s')
  })
  it('a refusal or a network failure is a result, never a throw', async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ code: 21215 }), { status: 400 }))
    expect(await dialMeeting(config, { from: '+1', to: '+1', twiml: '', timeLimitSeconds: 60, statusCallback: '' }, { fetch: refused as never })).toEqual({ ok: false, status: 400, code: '21215' })
    const down = vi.fn(async () => {
      throw new Error('down')
    })
    expect(await dialMeeting(config, { from: '+1', to: '+1', twiml: '', timeLimitSeconds: 60, statusCallback: '' }, { fetch: down as never })).toEqual({ ok: false, status: 0, code: 'network' })
  })
})
