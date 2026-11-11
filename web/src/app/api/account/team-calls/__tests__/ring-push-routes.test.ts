/**
 * Where the team call routes hand rings to the phones (src/lib/team-calls/
 * ring-push.ts): a DM's start and a ring request push the rings they made;
 * an answer (accepted or declined) sends the ring's cancel to every phone
 * but the one that answered (the iOS app names its VoIP token); a call's
 * end and LiveKit's join stop the phones too. What each of those
 * sends, and when nothing goes, is ring-push.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ME = '33333333-3333-4333-8333-333333333333'
const BEN = '44444444-4444-4444-8444-444444444444'
const DM = '66666666-6666-4666-8666-666666666666'
const CALL = '77777777-7777-4777-8777-777777777777'
const MSG = '88888888-8888-4888-8888-888888888888'
const RING = '99999999-9999-4999-8999-999999999999'
const PHONE = 'ab'.repeat(32)

const h = vi.hoisted(() => ({
  afters: [] as Array<() => unknown>,
  db: null as unknown as SupabaseClient,
  svcTables: {} as Record<string, Array<Record<string, unknown>>>,
  answers: 0,
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
  pushed: [] as unknown[],
  cancelled: [] as unknown[],
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => unknown) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/api-auth', () => ({
  requireUser: async () => ({ supabase: h.db, user: { id: USER, user_metadata: {} } }),
}))
vi.mock('@/lib/admin', async () => {
  const { memoryDb } = await import('@/test/memory-db')
  return { getServiceClient: () => memoryDb(h.svcTables) }
})
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: async () => ({ ids: [] }) } }))
vi.mock('@/lib/team-calls/livekit', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/livekit')>()),
  createTeamCallRoom: async () => undefined,
  openTeamCallRooms: async (_c: unknown, names: string[]) => new Set(names),
}))
vi.mock('@/lib/team-calls/ring-push', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/ring-push')>()),
  liveRingPushDeps: () => ({ live: true }),
  pushRings: async (_deps: unknown, rings: unknown) => {
    h.pushed.push(rings)
    return 1
  },
  cancelRingPushes: async (_deps: unknown, filter: unknown) => {
    h.cancelled.push(filter)
    return 1
  },
}))

import { POST as startCall } from '../route'
import { POST as ring } from '../[id]/ring/route'
import { POST as answer } from '../rings/[id]/route'
import { endCall, type MissedRing } from '@/lib/team-calls/store'
import { applyTeamCallWebhook } from '@/lib/team-calls/webhook'

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (url: string, body: unknown) => new NextRequest(url, { method: 'POST', body: JSON.stringify(body) })
const runAfters = async () => {
  for (const task of h.afters.splice(0)) await task()
}
let ringRows: Array<Record<string, unknown>> = []
let callRows: Array<Record<string, unknown>> = []
const madeRing = { ring_id: RING, member_id: BEN, user_id: '55555555-5555-4555-8555-555555555555', state: 'ringing', expires_at: new Date(Date.now() + 40_000).toISOString() }

beforeEach(() => {
  Object.assign(process.env, LIVEKIT_ENV)
  const tables = {
    member: [{ id: ME, user_id: USER, workspace_id: WS, display_name: 'Ana Ruiz' }],
    team_chat_channel: [{ id: DM, workspace_id: WS, kind: 'dm', name: null, dm_key: [ME, BEN].sort().join(':'), archived_at: null }],
    team_call: [{ id: CALL, workspace_id: WS, channel_id: DM, message_id: MSG, room: `tc-${CALL}`, status: 'live', started_at: new Date().toISOString(), ringing: [], declined: [] }],
    team_call_ring: [{ id: RING, state: 'ringing' }],
  }
  h.svcTables = { team_call_ring: [{ id: RING, state: 'accepted' }] }
  h.answers = 0
  h.db = Object.assign(memoryDb(tables), {
    rpc: async (name: string) => {
      if (name === 'team_call_answer') h.answers++
      return h.rpc[name] ?? { data: null, error: null }
    },
  }) as unknown as SupabaseClient
  ringRows = tables.team_call_ring
  callRows = tables.team_call
  h.afters = []
  h.pushed = []
  h.cancelled = []
  h.rpc = {
    team_call_start: { data: [{ call_id: CALL, room: `tc-${CALL}`, message_id: MSG, created: true }], error: null },
    team_call_ring_members: { data: [madeRing], error: null },
  }
})

afterEach(() => {
  for (const name of Object.keys(LIVEKIT_ENV)) delete process.env[name]
})

describe('a ring made → the phones', () => {
  it('a DM’s start pushes the ring it made', async () => {
    const res = await startCall(post('http://x/api/account/team-calls', { channelId: DM }))
    expect(res.status).toBe(200)
    await runAfters()
    expect(h.pushed).toEqual([[{ ringId: RING, memberId: BEN, userId: madeRing.user_id, state: 'ringing', expiresAt: madeRing.expires_at }]])
  })

  it('ringing people into a call pushes their rings', async () => {
    const res = await ring(post(`http://x/api/account/team-calls/${CALL}/ring`, { memberIds: [BEN] }), params(CALL))
    expect(res.status).toBe(200)
    await runAfters()
    expect(h.pushed).toHaveLength(1)
  })

  it('a second start (the call was live) rings nobody, so pushes nothing', async () => {
    h.rpc.team_call_start = { data: [{ call_id: CALL, room: `tc-${CALL}`, message_id: MSG, created: false }], error: null }
    await startCall(post('http://x/api/account/team-calls', { channelId: DM }))
    await runAfters()
    expect(h.pushed).toEqual([])
  })
})

describe('the phone answering a ring settled elsewhere', () => {
  it('accepted on the web first: the phone gets no join, and hears it was answered elsewhere', async () => {
    ringRows[0].state = 'accepted'
    const res = await answer(post(`http://x/api/account/team-calls/rings/${RING}`, { accept: true, voipToken: PHONE, onlyIfRinging: true }), params(RING))
    expect(await res.json()).toEqual({ state: 'accepted', elsewhere: true })
    expect(h.answers).toBe(0)
    await runAfters()
    expect(h.cancelled).toEqual([])
  })

  it('the web (no onlyIfRinging) keeps its behaviour: the answer goes to the server', async () => {
    ringRows[0].state = 'accepted'
    h.rpc.team_call_answer = { data: [{ call_id: CALL, state: 'declined' }], error: null }
    await answer(post(`http://x/api/account/team-calls/rings/${RING}`, { accept: false }), params(RING))
    expect(h.answers).toBe(1)
  })

  it('still ringing: the phone’s answer goes through as before', async () => {
    h.rpc.team_call_answer = { data: [{ call_id: CALL, state: 'declined' }], error: null }
    const res = await answer(post(`http://x/api/account/team-calls/rings/${RING}`, { accept: false, onlyIfRinging: true }), params(RING))
    expect(await res.json()).toEqual({ state: 'declined' })
    expect(h.answers).toBe(1)
  })
})

describe('an accept whose call is over', () => {
  it('ended: 409, and the ring this answer accepted is missed, not answered (no device hears "answered elsewhere")', async () => {
    callRows[0].status = 'ended'
    h.rpc.team_call_answer = { data: [{ call_id: CALL, state: 'accepted' }], error: null }
    const res = await answer(post(`http://x/api/account/team-calls/rings/${RING}`, { accept: true, onlyIfRinging: true }), params(RING))
    expect(res.status).toBe(409)
    expect(h.svcTables.team_call_ring[0].state).toBe('missed')
  })

  it('a ring accepted before this answer is left as it was', async () => {
    ringRows[0].state = 'accepted'
    callRows[0].status = 'ended'
    h.rpc.team_call_answer = { data: [{ call_id: CALL, state: 'accepted' }], error: null }
    const res = await answer(post(`http://x/api/account/team-calls/rings/${RING}`, { accept: true }), params(RING))
    expect(res.status).toBe(409)
    expect(h.svcTables.team_call_ring[0].state).toBe('accepted')
  })
})

describe('a ring left ringing → the phones stop', () => {
  it('declined (on the web): its cancel goes to every phone', async () => {
    h.rpc.team_call_answer = { data: [{ call_id: CALL, state: 'declined' }], error: null }
    const res = await answer(post(`http://x/api/account/team-calls/rings/${RING}`, { accept: false }), params(RING))
    expect(await res.json()).toEqual({ state: 'declined' })
    await runAfters()
    expect(h.cancelled).toEqual([{ ringIds: [RING], exceptToken: null }])
  })

  it('answered on a phone: its cancel goes to every phone but that one', async () => {
    h.rpc.team_call_answer = { data: [{ call_id: CALL, state: 'accepted' }], error: null }
    const res = await answer(post(`http://x/api/account/team-calls/rings/${RING}`, { accept: true, voipToken: PHONE.toUpperCase() }), params(RING))
    expect(res.status).toBe(200)
    await runAfters()
    expect(h.cancelled).toEqual([{ ringIds: [RING], exceptToken: PHONE }])
  })

  it('an answer that finds the ring ran out (missed): the claim decides (it sends none for that); a token that is not one is ignored', async () => {
    h.rpc.team_call_answer = { data: [{ call_id: CALL, state: 'missed' }], error: null }
    await answer(post(`http://x/api/account/team-calls/rings/${RING}`, { accept: true, voipToken: 'nope' }), params(RING))
    await runAfters()
    expect(h.cancelled).toEqual([{ ringIds: [RING], exceptToken: null }])
  })

  it('missed (the caller hung up, the call ended): its end stops the phones', async () => {
    const missed: MissedRing = {
      ring_id: RING, call_id: CALL, message_id: MSG, workspace_id: WS, channel_id: DM, channel_kind: 'dm', channel_name: null,
      member_id: BEN, user_id: madeRing.user_id, caller_member_id: ME, caller_name: 'Ana Ruiz',
    }
    const svc = { rpc: async () => ({ data: [missed], error: null }) } as unknown as SupabaseClient
    const stopped: string[][] = []
    expect(await endCall(svc, CALL, 'left', new Date(), async (ids) => void stopped.push(ids))).toEqual([missed])
    expect(stopped).toEqual([[RING]])
    const none = { rpc: async () => ({ data: [], error: null }) } as unknown as SupabaseClient
    await endCall(none, CALL, 'finished', new Date(), async (ids) => void stopped.push(ids))
    expect(stopped).toHaveLength(1)
  })

  it('a member joining (LiveKit’s webhook) stops their phones ringing for that call', async () => {
    const stopped: Array<[string, string]> = []
    const svc = Object.assign(memoryDb({ team_call_webhook_event: [] }), {
      rpc: async () => ({ data: 'joined', error: null }),
    }) as unknown as SupabaseClient
    const outcome = await applyTeamCallWebhook(
      svc,
      { id: 'EV_1', event: 'participant_joined', createdAt: 1, room: { name: `tc-${CALL}` }, participant: { identity: BEN, sid: 'PA_1', joinedAt: 1 } },
      { stopPhones: async (_s, callId, memberId) => void stopped.push([callId, memberId]) },
    )
    expect(outcome).toBe('joined')
    expect(stopped).toEqual([[CALL, BEN]])
  })

  it('a leave stops nothing', async () => {
    const stopped: unknown[] = []
    const svc = Object.assign(memoryDb({ team_call_webhook_event: [] }), {
      rpc: async () => ({ data: 'left', error: null }),
    }) as unknown as SupabaseClient
    await applyTeamCallWebhook(
      svc,
      { id: 'EV_2', event: 'participant_left', createdAt: 1, room: { name: `tc-${CALL}` }, participant: { identity: BEN, sid: 'PA_1', joinedAt: 1 } },
      { stopPhones: async () => void stopped.push(1) },
    )
    expect(stopped).toEqual([])
  })
})
