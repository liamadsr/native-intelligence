/**
 * POST /api/calls/live, the meeting branch (roadmap #12): a call we started to
 * a meeting's dial-in, carrying X-NI-Meeting. Never a caller: matched by the
 * token's hash, accepted with the meeting's own session, bridged as a meeting.
 */
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  accepts: [] as Array<{ sessionId: string; session: { instructions: string } }>,
  rejects: [] as Array<{ sessionId: string; statusCode: number }>,
  hangups: [] as string[],
  lookups: 0,
  claims: [] as Array<{ hash: string; sessionId: string }>,
  claimed: null as null | Record<string, unknown>,
  meetingBridges: [] as string[],
  callBridges: [] as string[],
  moves: [] as Array<{ id: string; to: string }>,
  bridgeFails: false,
}))

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (task: () => Promise<unknown>) => void h.afters.push(task) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
vi.mock('@/lib/calls/caller', async (orig) => ({
  ...(await orig<typeof import('@/lib/calls/caller')>()),
  resolveCallCaller: async () => {
    h.lookups++
    return null
  },
}))
vi.mock('@/lib/calls/live-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/calls/live-api')>()),
  acceptLiveCall: async (sessionId: string, session: never) => (h.accepts.push({ sessionId, session }), { ok: true }),
  rejectLiveCall: async (sessionId: string, statusCode: number) => (h.rejects.push({ sessionId, statusCode }), { ok: true }),
  hangUpLiveCall: async (sessionId: string) => (h.hangups.push(sessionId), { ok: true }),
}))
vi.mock('@/lib/calls/live-bridge', () => ({ runLiveCall: async (a: { sessionId: string }) => void h.callBridges.push(a.sessionId) }))
vi.mock('@/lib/meeting-agent/store', async (orig) => ({
  ...(await orig<typeof import('@/lib/meeting-agent/store')>()),
  claimByJoinToken: async (_svc: unknown, hash: string, sessionId: string) => (h.claims.push({ hash, sessionId }), h.claimed),
  moveAttendance: async (_svc: unknown, id: string, _from: unknown, to: string) => (h.moves.push({ id, to }), null),
}))
vi.mock('@/lib/meeting-agent/bridge', () => ({
  runMeetingCall: async (a: { sessionId: string }) => {
    if (h.bridgeFails) throw new Error('attach refused (403)')
    h.meetingBridges.push(a.sessionId)
  },
}))

import { POST } from '../route'
import { hashJoinToken, newJoinToken } from '@/lib/meeting-agent/dial-out'

const KEY = Buffer.from('route test signing key')
const SECRET = `whsec_${KEY.toString('base64')}`
const TRUNK = 'trunk-secret-for-tests'

function delivery(event: unknown): Request {
  const body = JSON.stringify(event)
  const ts = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', new Uint8Array(KEY)).update(`wh_1.${ts}.${body}`).digest('base64')
  return new Request('https://nativeintelligence.test/api/calls/live', { method: 'POST', headers: { 'webhook-id': 'wh_1', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` }, body })
}

const leg = (token: string | null, trunk: string | null = TRUNK) => ({
  id: 'evt_1',
  type: 'live.transport.incoming',
  created_at: 1,
  data: {
    type: 'sip',
    session_id: 'live_meet',
    sip_headers: [
      // Our own number: never a verified caller, and no attestation needed.
      { name: 'From', value: '<sip:+15555550100@sip.twilio.com>;tag=1' },
      ...(trunk ? [{ name: 'X-NI-Trunk', value: trunk }] : []),
      ...(token !== null ? [{ name: 'X-NI-Meeting', value: token }] : []),
    ],
  },
})

const ATTENDANCE = { id: 'att-1', ownerFirstName: 'Sam', title: 'Pilot review', userId: 'u1', workspaceId: 'w1' }

beforeEach(() => {
  Object.assign(h, { afters: [], accepts: [], rejects: [], hangups: [], lookups: 0, claims: [], claimed: ATTENDANCE, meetingBridges: [], callBridges: [], moves: [], bridgeFails: false })
  vi.stubEnv('GPT_LIVE_WEBHOOK_SECRET', SECRET)
  vi.stubEnv('GPT_LIVE_API_KEY', 'sk-live-test')
  vi.stubEnv('GPT_LIVE_TRUNK_SECRET', TRUNK)
  vi.stubEnv('MEETING_AGENT', 'on')
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/calls/live: a meeting leg', () => {
  it("is matched by its token's hash, accepted as the person's assistant, and bridged as a meeting (never a caller)", async () => {
    const { token } = newJoinToken()
    const res = await POST(delivery(leg(token)))
    expect(await res.json()).toEqual({ ok: true, outcome: 'accepted' })
    expect(h.claims).toEqual([{ hash: hashJoinToken(token), sessionId: 'live_meet' }])
    expect(h.lookups).toBe(0)
    expect(h.accepts[0].session.instructions).toContain("You are Sam's AI assistant, attending a meeting")
    await h.afters[0]()
    expect(h.meetingBridges).toEqual(['live_meet'])
    expect(h.callBridges).toEqual([])
  })

  it('still needs our trunk secret first', async () => {
    const { token } = newJoinToken()
    await POST(delivery(leg(token, 'forged')))
    expect(h.rejects).toEqual([{ sessionId: 'live_meet', statusCode: 603 }])
    expect(h.claims).toEqual([])
  })

  it('is declined with the meeting agent off, a malformed token, or a token that matches nothing', async () => {
    const { token } = newJoinToken()
    vi.stubEnv('MEETING_AGENT', '')
    expect(await (await POST(delivery(leg(token)))).json()).toEqual({ ok: true, outcome: 'declined' })
    vi.stubEnv('MEETING_AGENT', 'on')
    expect(await (await POST(delivery(leg('junk')))).json()).toEqual({ ok: true, outcome: 'declined' })
    h.claimed = null
    expect(await (await POST(delivery(leg(token)))).json()).toEqual({ ok: true, outcome: 'declined' })
    expect(h.rejects).toHaveLength(3)
    expect(h.accepts).toEqual([])
    expect(h.lookups).toBe(0)
  })

  it('a bridge that fails to attach hangs up and fails the attendance', async () => {
    h.bridgeFails = true
    const { token } = newJoinToken()
    await POST(delivery(leg(token)))
    await h.afters[0]()
    expect(h.hangups).toEqual(['live_meet'])
    expect(h.moves).toEqual([{ id: 'att-1', to: 'failed' }])
  })
})
