/**
 * A team call's ring on the person's phones (src/lib/team-calls/
 * ring-push.ts). A ring that is ringing is pushed once to their fresh VoIP
 * installs, as Apple wants a VoIP push (against a local HTTP/2 server that
 * stands in for Apple): the .voip topic, priority 10, alive until the ring
 * stops, the ids and the caller's name, never a LiveKit token. A ring that
 * left ringing gets one cancel (now or never), never to the phone that
 * answered. A busy ring, a ring the claim refuses, a person with no fresh
 * VoIP install, and the APNs settings unset send nothing (and, unset, read
 * nothing).
 */
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2'
import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApnsSender, type ApnsConfig, type ApnsSender } from '@/lib/push/apns'
import type { PushDeps, PushTokenRow } from '@/lib/push/send'
import { cancelPush, cancelRingPushes, pushRings, ringPush, voipTokenOf, type CancelledRing, type ClaimedRing, type RingPushDeps } from '../ring-push'

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const CONFIG: ApnsConfig = { keyId: 'KEY1234567', teamId: 'TEAM123456', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), bundleId: 'com.example.app' }
const NOW = Date.parse('2026-11-11T20:00:00.000Z')
const USER = '22222222-2222-4222-8222-222222222222'
const RING = '99999999-9999-4999-8999-999999999999'
const CALL = '77777777-7777-4777-8777-777777777777'
const PHONE = 'ab'.repeat(32)
const IPAD = 'cd'.repeat(32)

const claimed: ClaimedRing = {
  ring_id: RING,
  call_id: CALL,
  workspace_id: '11111111-1111-4111-8111-111111111111',
  channel_id: '66666666-6666-4666-8666-666666666666',
  user_id: USER,
  caller_name: 'Ana Ruiz',
  channel_kind: 'dm',
  channel_name: null,
  expires_at: new Date(NOW + 38_000).toISOString(),
}

let seen: Array<{ headers: IncomingHttpHeaders; body: string; token: string }> = []
let server: Http2Server
let origin = ''
let senders: ApnsSender[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => (body += c))
    req.on('end', () => {
      seen.push({ headers: req.headers, body, token: String(req.headers[':path'] ?? '').split('/').pop() ?? '' })
      res.writeHead(200, { 'apns-id': String(req.headers['apns-id'] ?? 'none') })
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => {
  for (const s of senders) s.close()
  senders = []
  seen = []
})

const install = (token: string, seenDaysAgo = 1): PushTokenRow => ({
  id: `t-${token.slice(0, 4)}`,
  token,
  environment: 'sandbox',
  last_seen_at: new Date(NOW - seenDaysAgo * 24 * 60 * 60_000).toISOString(),
})

/** Real APNs sending (to the stand-in) over fake installs and claims. */
function deps(over: { config?: ApnsConfig | null; installs?: PushTokenRow[]; claim?: ClaimedRing | null; cancelled?: CancelledRing[] } = {}) {
  const sender = createApnsSender({ config: CONFIG, origins: { sandbox: origin, production: origin }, now: () => NOW })
  senders.push(sender)
  const push: PushDeps = {
    config: over.config === undefined ? CONFIG : over.config,
    now: () => NOW,
    tokens: vi.fn(async () => over.installs ?? [install(PHONE), install(IPAD)]),
    disable: vi.fn(async () => {}),
    badge: vi.fn(async () => 0),
    send: vi.fn(async () => ({ ok: true as const, apnsId: null })),
    sendVoip: (_config, input) => sender.sendVoip(input),
  }
  const d: RingPushDeps = {
    push,
    now: () => NOW,
    claim: vi.fn(async () => (over.claim === undefined ? claimed : over.claim)),
    cancel: vi.fn(async () => over.cancelled ?? [{ ring_id: RING, call_id: CALL, user_id: USER, state: 'accepted' as const }]),
  }
  return d
}

describe('a ring made → its push', () => {
  it('goes to every fresh VoIP install as Apple wants a VoIP push: .voip, priority 10, alive until the ring stops', async () => {
    const d = deps()
    expect(await pushRings(d, [{ ringId: RING, state: 'ringing' }])).toBe(1)
    expect(d.claim).toHaveBeenCalledWith(RING)
    expect(d.push.tokens).toHaveBeenCalledWith(USER, 'com.example.app', 'voip')
    expect(seen.map((s) => s.token).sort()).toEqual([PHONE, IPAD].sort())
    for (const s of seen) {
      expect(s.headers['apns-push-type']).toBe('voip')
      expect(s.headers['apns-topic']).toBe('com.example.app.voip')
      expect(s.headers['apns-priority']).toBe('10')
      expect(s.headers['apns-expiration']).toBe(String(Math.floor((NOW + 38_000) / 1000)))
    }
  })

  it('says the ring, the call, the conversation, the workspace, who calls, no video, the time left; never a LiveKit token', async () => {
    await pushRings(deps(), [{ ringId: RING, state: 'ringing' }])
    const body = JSON.parse(seen[0].body)
    expect(body).toEqual({
      kind: 'team_call_ring',
      ring_id: RING,
      call_id: CALL,
      channel_id: claimed.channel_id,
      workspace_id: claimed.workspace_id,
      caller_name: 'Ana Ruiz',
      channel_kind: 'dm',
      channel_name: null,
      video: false,
      seconds_left: 38,
    })
    expect(seen[0].body).not.toMatch(/token|livekit|wss?:/i)
  })

  it('a busy ring (they are in another call) is a quiet notice: never claimed, never pushed', async () => {
    const d = deps()
    expect(await pushRings(d, [{ ringId: RING, state: 'busy' }])).toBe(0)
    expect(d.claim).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })

  it('a ring the claim refuses (pushed already, settled, past its time) sends nothing', async () => {
    const d = deps({ claim: null })
    expect(await pushRings(d, [{ ringId: RING, state: 'ringing' }])).toBe(0)
    expect(d.push.tokens).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })

  it('no fresh VoIP install: nothing sent (a phone not seen in 30 days is no target)', async () => {
    expect(await pushRings(deps({ installs: [] }), [{ ringId: RING, state: 'ringing' }])).toBe(0)
    expect(await pushRings(deps({ installs: [install(PHONE, 31)] }), [{ ringId: RING, state: 'ringing' }])).toBe(0)
    expect(seen).toHaveLength(0)
  })

  it('the APNs settings unset: nothing claimed, nothing read, nothing sent', async () => {
    const d = deps({ config: null })
    expect(await pushRings(d, [{ ringId: RING, state: 'ringing' }])).toBe(0)
    expect(d.claim).not.toHaveBeenCalled()
    expect(d.push.tokens).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })

  it('a failed claim is logged, never thrown', async () => {
    const d = deps()
    d.claim = vi.fn(async () => Promise.reject(new Error('down')))
    expect(await pushRings(d, [{ ringId: RING, state: 'ringing' }])).toBe(0)
  })
})

describe('a ring left ringing → its cancel', () => {
  it('goes now or never, saying the ring and how it was settled, to every phone but the one that answered', async () => {
    const d = deps()
    expect(await cancelRingPushes(d, { ringIds: [RING], exceptToken: PHONE })).toBe(1)
    expect(d.cancel).toHaveBeenCalledWith({ ringIds: [RING], exceptToken: PHONE })
    expect(seen.map((s) => s.token)).toEqual([IPAD])
    expect(seen[0].headers['apns-push-type']).toBe('voip')
    expect(seen[0].headers['apns-topic']).toBe('com.example.app.voip')
    expect(seen[0].headers['apns-expiration']).toBe('0')
    expect(JSON.parse(seen[0].body)).toEqual({ kind: 'team_call_cancel', ring_id: RING, call_id: CALL, state: 'accepted' })
  })

  it('declined on the web, or the caller gave up: every phone of theirs is stopped', async () => {
    const d = deps({ cancelled: [{ ring_id: RING, call_id: CALL, user_id: USER, state: 'missed' }] })
    expect(await cancelRingPushes(d, { ringIds: [RING] })).toBe(1)
    expect(seen.map((s) => s.token).sort()).toEqual([PHONE, IPAD].sort())
    expect(JSON.parse(seen[0].body).state).toBe('missed')
  })

  it('a join (LiveKit’s webhook) finds the member’s rings in the call', async () => {
    const d = deps()
    await cancelRingPushes(d, { callId: CALL, memberId: 'm1' })
    expect(d.cancel).toHaveBeenCalledWith({ callId: CALL, memberId: 'm1' })
  })

  it('nothing to cancel (never pushed, ran out, cancelled already): nothing sent', async () => {
    expect(await cancelRingPushes(deps({ cancelled: [] }), { ringIds: [RING] })).toBe(0)
    expect(seen).toHaveLength(0)
  })

  it('no ring named, or the settings unset: not even the claim runs', async () => {
    const none = deps()
    expect(await cancelRingPushes(none, { ringIds: [] })).toBe(0)
    expect(await cancelRingPushes(none, { callId: CALL })).toBe(0)
    expect(none.cancel).not.toHaveBeenCalled()
    const off = deps({ config: null })
    expect(await cancelRingPushes(off, { ringIds: [RING] })).toBe(0)
    expect(off.cancel).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })
})

describe('what a push says', () => {
  it('a ring’s time left is never negative; the place goes with a channel’s ring', () => {
    const late = ringPush({ ...claimed, channel_kind: 'channel', channel_name: 'launch', expires_at: new Date(NOW - 1000).toISOString() }, NOW)
    expect(late.data.seconds_left).toBe(0)
    expect(late.data.channel_name).toBe('launch')
    expect(cancelPush({ ring_id: RING, call_id: CALL, user_id: USER, state: 'declined' })).toEqual({
      data: { kind: 'team_call_cancel', ring_id: RING, call_id: CALL, state: 'declined' },
      expiresAtMs: 0,
    })
  })

  it('the answering phone’s VoIP token is hex or nothing', () => {
    expect(voipTokenOf(PHONE.toUpperCase())).toBe(PHONE)
    expect(voipTokenOf('not-a-token')).toBeNull()
    expect(voipTokenOf(42)).toBeNull()
  })
})
