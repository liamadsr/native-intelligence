import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { computeTwilioSignature, twilioRequestUrl, validateTwilioSignature } from '../signature'

/**
 * Twilio's webhook signature: HMAC-SHA1 (auth token) over the exact URL Twilio
 * requested followed by every POST param's name and value, sorted by name,
 * base64. Fails closed on anything missing or different.
 */

const TOKEN = '12345'
const URL_ = 'https://mycompany.com/myapp.php?foo=1&bar=2'
const PARAMS = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' }

/** The spec, spelled out by hand (not through the code under test). */
const byHand = createHmac('sha1', TOKEN)
  .update('https://mycompany.com/myapp.php?foo=1&bar=2CallSidCA1234567890ABCDECaller+12349013030Digits1234From+12349013030To+18005551212')
  .digest('base64')

describe('validateTwilioSignature', () => {
  it('matches the spec: the URL, then each param name+value sorted by name, HMAC-SHA1, base64', () => {
    expect(computeTwilioSignature(URL_, PARAMS, TOKEN)).toBe(byHand)
    // Insertion order of the params never matters.
    const shuffled = { To: PARAMS.To, Digits: PARAMS.Digits, CallSid: PARAMS.CallSid, From: PARAMS.From, Caller: PARAMS.Caller }
    expect(validateTwilioSignature(URL_, shuffled, byHand, TOKEN)).toBe(true)
  })

  it('refuses a wrong token, a tampered param, an added param, another URL, or a missing signature/token', () => {
    expect(validateTwilioSignature(URL_, PARAMS, byHand, 'other-token')).toBe(false)
    expect(validateTwilioSignature(URL_, { ...PARAMS, Digits: '9999' }, byHand, TOKEN)).toBe(false)
    expect(validateTwilioSignature(URL_, { ...PARAMS, Body: 'STOP' }, byHand, TOKEN)).toBe(false)
    expect(validateTwilioSignature('https://mycompany.com/myapp.php?foo=1&bar=3', PARAMS, byHand, TOKEN)).toBe(false)
    expect(validateTwilioSignature(URL_, PARAMS, null, TOKEN)).toBe(false)
    expect(validateTwilioSignature(URL_, PARAMS, '', TOKEN)).toBe(false)
    expect(validateTwilioSignature(URL_, PARAMS, byHand, null)).toBe(false)
    expect(validateTwilioSignature(URL_, PARAMS, byHand.slice(0, -2), TOKEN)).toBe(false)
  })
})

describe('twilioRequestUrl', () => {
  it('uses TWILIO_WEBHOOK_URL when set (a proxy or tunnel in front)', () => {
    const req = new Request('http://localhost:3000/api/twilio/sms', { method: 'POST' })
    expect(twilioRequestUrl(req, 'https://abc.ngrok.app/api/twilio/sms')).toBe('https://abc.ngrok.app/api/twilio/sms')
  })

  it('else the request URL with the forwarded scheme and host, query kept', () => {
    const req = new Request('http://internal:8080/api/twilio/sms?x=1', {
      method: 'POST',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'dial8.ai' },
    })
    expect(twilioRequestUrl(req, null)).toBe('https://dial8.ai/api/twilio/sms?x=1')
    expect(twilioRequestUrl(new Request('https://dial8.ai/api/twilio/sms'), null)).toBe('https://dial8.ai/api/twilio/sms')
  })
})
