import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LIVE_WEBHOOK_TOLERANCE_S, parseLiveIncomingCall, verifyLiveWebhook } from '../live-webhook'

const KEY = Buffer.from('a test signing key, 32 bytes long')
const SECRET = `whsec_${KEY.toString('base64')}`
const NOW = 1_750_287_078

function sign(id: string, ts: number, body: string, key: Buffer = KEY): string {
  return `v1,${createHmac('sha256', new Uint8Array(key)).update(`${id}.${ts}.${body}`).digest('base64')}`
}

const body = JSON.stringify({ id: 'evt_1', type: 'live.transport.incoming', data: { type: 'sip', session_id: 'live_1', sip_headers: [] } })

describe('verifyLiveWebhook (Standard Webhooks)', () => {
  it('accepts a delivery signed with the secret', () => {
    expect(verifyLiveWebhook({ body, id: 'wh_1', timestamp: String(NOW), signature: sign('wh_1', NOW, body), secret: SECRET, nowS: NOW })).toEqual({ ok: true })
  })

  it('accepts when any of several space-separated signatures matches (a rotated secret)', () => {
    const other = sign('wh_1', NOW, body, Buffer.from('an older signing key'))
    expect(verifyLiveWebhook({ body, id: 'wh_1', timestamp: String(NOW), signature: `${other} ${sign('wh_1', NOW, body)}`, secret: SECRET, nowS: NOW }).ok).toBe(true)
  })

  it('refuses a changed body, id or timestamp', () => {
    const signature = sign('wh_1', NOW, body)
    expect(verifyLiveWebhook({ body: `${body} `, id: 'wh_1', timestamp: String(NOW), signature, secret: SECRET, nowS: NOW })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyLiveWebhook({ body, id: 'wh_2', timestamp: String(NOW), signature, secret: SECRET, nowS: NOW })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyLiveWebhook({ body, id: 'wh_1', timestamp: String(NOW + 1), signature, secret: SECRET, nowS: NOW })).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('refuses a timestamp outside the tolerance (a replay)', () => {
    const old = NOW - LIVE_WEBHOOK_TOLERANCE_S - 1
    expect(verifyLiveWebhook({ body, id: 'wh_1', timestamp: String(old), signature: sign('wh_1', old, body), secret: SECRET, nowS: NOW })).toEqual({ ok: false, reason: 'stale' })
  })

  it('refuses without a secret, or without its headers', () => {
    expect(verifyLiveWebhook({ body, id: 'wh_1', timestamp: String(NOW), signature: sign('wh_1', NOW, body), secret: undefined, nowS: NOW })).toEqual({ ok: false, reason: 'no_secret' })
    expect(verifyLiveWebhook({ body, id: null, timestamp: String(NOW), signature: sign('wh_1', NOW, body), secret: SECRET, nowS: NOW })).toEqual({ ok: false, reason: 'missing_headers' })
    expect(verifyLiveWebhook({ body, id: 'wh_1', timestamp: String(NOW), signature: null, secret: SECRET, nowS: NOW })).toEqual({ ok: false, reason: 'missing_headers' })
  })

  it('ignores entries of another version', () => {
    const v2 = sign('wh_1', NOW, body).replace(/^v1,/, 'v2,')
    expect(verifyLiveWebhook({ body, id: 'wh_1', timestamp: String(NOW), signature: v2, secret: SECRET, nowS: NOW })).toEqual({ ok: false, reason: 'bad_signature' })
  })
})

describe('parseLiveIncomingCall', () => {
  it('reads the session and its SIP headers (the docs’ example)', () => {
    const event = {
      id: 'evt_abc123',
      type: 'live.transport.incoming',
      created_at: 1719168000,
      data: {
        type: 'sip',
        session_id: 'live_u0_479a',
        sip_media_security: 'srtp',
        sip_headers: [
          { name: 'From', value: '<sip:+14155550100@example.com>;tag=abc123' },
          { name: 'To', value: '<sip:recipient@example.com>' },
          { name: 'Bad', value: 7 },
        ],
      },
    }
    expect(parseLiveIncomingCall(event)).toEqual({
      sessionId: 'live_u0_479a',
      sipHeaders: [
        { name: 'From', value: '<sip:+14155550100@example.com>;tag=abc123' },
        { name: 'To', value: '<sip:recipient@example.com>' },
      ],
    })
  })

  it('is null for any other event, transport or shape', () => {
    expect(parseLiveIncomingCall({ type: 'realtime.call.incoming', data: { type: 'sip', session_id: 'x' } })).toBeNull()
    expect(parseLiveIncomingCall({ type: 'live.transport.incoming', data: { type: 'webrtc', session_id: 'x' } })).toBeNull()
    expect(parseLiveIncomingCall({ type: 'live.transport.incoming', data: { type: 'sip' } })).toBeNull()
    expect(parseLiveIncomingCall(null)).toBeNull()
  })
})
