/**
 * The team call routes (migrations 564-565). A token only for a live call
 * the person may read (their client, under RLS: a call they may not read is
 * one they never see), for their own member id in the call's workspace,
 * with the room's grants and ten minutes; nothing at all, and every entry
 * point saying "not available", while the LiveKit settings are unset. A
 * start makes the room (or ends the call when it can't), rings a DM's other
 * person, and joins a live call rather than making a second; a ring answered
 * mints a join only when accepted; a DM's hang-up ends its call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TokenVerifier } from 'livekit-server-sdk'
import { memoryDb } from '@/test/memory-db'
import { KEY, LIVEKIT_ENV, SECRET } from '@/lib/team-calls/__tests__/signing'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ME = '33333333-3333-4333-8333-333333333333'
const BEN = '44444444-4444-4444-8444-444444444444'
const CH = '55555555-5555-4555-8555-555555555555'
const DM = '66666666-6666-4666-8666-666666666666'
const CALL = '77777777-7777-4777-8777-777777777777'
const MSG = '88888888-8888-4888-8888-888888888888'
const RING = '99999999-9999-4999-8999-999999999999'
const HIDDEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  db: null as unknown as SupabaseClient,
  svc: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  svcRpcs: [] as Array<[string, Record<string, unknown>]>,
  rpc: {} as Record<string, { data: unknown; error: unknown } | Array<{ data: unknown; error: unknown }>>,
  events: [] as Array<{ name: string; data: unknown }>,
  rooms: { made: [] as string[], closed: [] as string[], open: new Set<string>(), failMake: false },
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/api-auth', () => ({
  requireUser: async () => ({ supabase: h.db, user: { id: USER, user_metadata: {} } }),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.svc }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: async (events: { name: string; data: unknown } | Array<{ name: string; data: unknown }>) => {
      for (const e of Array.isArray(events) ? events : [events]) h.events.push({ name: e.name, data: e.data })
      return { ids: [] }
    },
  },
}))
vi.mock('@/lib/team-calls/livekit', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/livekit')>()),
  createTeamCallRoom: async (_c: unknown, room: string) => {
    if (h.rooms.failMake) throw new Error('connect ECONNREFUSED')
    h.rooms.made.push(room)
    h.rooms.open.add(room)
  },
  openTeamCallRooms: async (_c: unknown, names: string[]) => new Set(names.filter((n) => h.rooms.open.has(n))),
  closeTeamCallRoom: async (_c: unknown, room: string) => {
    h.rooms.closed.push(room)
  },
}))

import { GET as getCalls, POST as startCall } from '../route'
import { POST as token } from '../[id]/token/route'
import { POST as ring } from '../[id]/ring/route'
import { POST as leave } from '../[id]/leave/route'
import { POST as answer } from '../rings/[id]/route'

function rpcAnswer(name: string) {
  const a = h.rpc[name]
  if (Array.isArray(a)) return a.shift() ?? { data: null, error: null }
  return a ?? { data: null, error: null }
}

let tables: Record<string, Array<Record<string, unknown>>>
let svcTables: Record<string, Array<Record<string, unknown>>>
const call = (over: Record<string, unknown> = {}) => ({
  id: CALL,
  workspace_id: WS,
  channel_id: CH,
  message_id: MSG,
  started_by: BEN,
  room: `tc-${CALL}`,
  status: 'live',
  started_at: new Date().toISOString(),
  ended_at: null,
  ended_reason: null,
  duration_seconds: null,
  participant_count: 1,
  peak_participants: 1,
  ringing: [],
  declined: [],
  ...over,
})

beforeEach(() => {
  Object.assign(process.env, LIVEKIT_ENV)
  tables = {
    member: [{ id: ME, user_id: USER, workspace_id: WS, display_name: 'Ana Ruiz' }],
    team_chat_channel: [
      { id: CH, workspace_id: WS, kind: 'channel', name: 'launch', dm_key: null, archived_at: null },
      { id: DM, workspace_id: WS, kind: 'dm', name: null, dm_key: [ME, BEN].sort().join(':'), archived_at: null },
    ],
    team_call: [call()],
    team_call_ring: [],
  }
  svcTables = { notification: [] }
  h.db = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcs.push([name, args])
      return rpcAnswer(name)
    },
  }) as unknown as SupabaseClient
  h.svc = Object.assign(memoryDb(svcTables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.svcRpcs.push([name, args])
      return rpcAnswer(`svc:${name}`)
    },
  }) as unknown as SupabaseClient
  h.afters = []
  h.rpcs = []
  h.svcRpcs = []
  h.rpc = {}
  h.events = []
  h.rooms = { made: [], closed: [], open: new Set([`tc-${CALL}`]), failMake: false }
})

afterEach(() => {
  for (const name of Object.keys(LIVEKIT_ENV)) delete process.env[name]
})

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (url: string, body?: unknown) =>
  new NextRequest(url, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
const runAfters = async () => {
  for (const task of h.afters.splice(0)) await task()
}
async function claimsOf(jwt: string) {
  return new TokenVerifier(KEY, SECRET).verify(jwt)
}

describe('with the LiveKit settings unset', () => {
  beforeEach(() => {
    for (const name of Object.keys(LIVEKIT_ENV)) delete process.env[name]
  })

  it('GET says calling is off, and reads nothing', async () => {
    const res = await getCalls()
    expect(await res.json()).toEqual({ available: false })
    expect(h.rpcs).toEqual([])
  })

  it('every other entry point answers "not available" and does nothing', async () => {
    const answers = [
      await startCall(post('http://localhost/api/account/team-calls', { channelId: CH })),
      await token(post('http://localhost/x'), params(CALL)),
      await ring(post('http://localhost/x', { memberIds: [BEN] }), params(CALL)),
      await leave(post('http://localhost/x'), params(CALL)),
      await answer(post('http://localhost/x', { accept: true }), params(RING)),
    ]
    for (const res of answers) {
      expect(res.status).toBe(404)
      expect((await res.json()).code).toBe('CALLS_NOT_AVAILABLE')
    }
    expect(h.rpcs).toEqual([])
    expect(h.rooms.made).toEqual([])
  })

  it('only all three together turn it on', async () => {
    process.env.LIVEKIT_URL = LIVEKIT_ENV.LIVEKIT_URL
    process.env.LIVEKIT_API_KEY = LIVEKIT_ENV.LIVEKIT_API_KEY
    expect(await (await getCalls()).json()).toEqual({ available: false })
  })
})

describe('GET /api/account/team-calls', () => {
  it('says calling is on, with the person’s open rings', async () => {
    tables.team_call_ring.push(
      { id: RING, call_id: CALL, user_id: USER, state: 'ringing', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30_000).toISOString() },
      { id: HIDDEN, call_id: CALL, user_id: USER, state: 'declined', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30_000).toISOString() },
    )
    const json = await (await getCalls()).json()
    expect(json.available).toBe(true)
    expect(json.rings.map((r: { id: string }) => r.id)).toEqual([RING])
  })
})

describe('POST /api/account/team-calls/[id]/token', () => {
  it('mints a token for the person’s member id, one room, ten minutes', async () => {
    const res = await token(post('http://localhost/x'), params(CALL))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.join.url).toBe(LIVEKIT_ENV.LIVEKIT_URL)
    expect(json.join.room).toBe(`tc-${CALL}`)
    expect(JSON.stringify(json)).not.toContain(SECRET)
    const claims = await claimsOf(json.join.token)
    expect(claims.sub).toBe(ME)
    expect(claims.name).toBe('Ana Ruiz')
    expect(claims.video?.room).toBe(`tc-${CALL}`)
    expect(claims.video?.roomAdmin).toBe(false)
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(600)
  })

  it('a call the person may not read is not there for them (404), and nothing is minted', async () => {
    const res = await token(post('http://localhost/x'), params(HIDDEN))
    expect(res.status).toBe(404)
  })

  it('a call in a workspace the person is not in: 404', async () => {
    tables.team_call[0].workspace_id = '12121212-1212-4212-8212-121212121212'
    expect((await token(post('http://localhost/x'), params(CALL))).status).toBe(404)
  })

  it('an ended call: 409, no token', async () => {
    tables.team_call[0] = call({ status: 'ended', ended_at: new Date().toISOString(), ended_reason: 'finished' })
    const res = await token(post('http://localhost/x'), params(CALL))
    expect(res.status).toBe(409)
    expect((await res.json()).join).toBeUndefined()
  })

  it('a malformed id: 404', async () => {
    expect((await token(post('http://localhost/x'), params('nope'))).status).toBe(404)
  })
})

describe('POST /api/account/team-calls (start or join)', () => {
  it('a new call in a channel: makes its room, rings nobody, tells the channel as of any message, and joins', async () => {
    tables.team_call = []
    h.rpc.team_call_start = { data: [{ call_id: CALL, room: `tc-${CALL}`, message_id: MSG, created: true }], error: null }
    tables.team_call.push(call())
    const res = await startCall(post('http://localhost/api/account/team-calls', { channelId: CH }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.call).toMatchObject({ id: CALL, created: true, channelKind: 'channel' })
    expect(json.rings).toEqual([])
    expect(h.rooms.made).toEqual([`tc-${CALL}`])
    expect(h.rpcs.map(([n]) => n)).toEqual(['team_call_start'])
    expect((await claimsOf(json.join.token)).sub).toBe(ME)
    await runAfters()
    expect(h.events.map((e) => e.name)).toEqual(['team-chat/notify.requested'])
    expect(h.events[0].data).toEqual({ messageId: MSG })
  })

  it('a new call in a DM rings the other person, and its ring’s timer starts; no ordinary notice (the ring is it)', async () => {
    h.rpc.team_call_start = { data: [{ call_id: CALL, room: `tc-${CALL}`, message_id: MSG, created: true }], error: null }
    h.rpc.team_call_ring_members = { data: [{ ring_id: RING, member_id: BEN, user_id: 'u-ben', state: 'ringing', expires_at: '2026-11-11T10:00:40Z' }], error: null }
    const res = await startCall(post('http://localhost/api/account/team-calls', { channelId: DM }))
    const json = await res.json()
    expect(json.rings).toEqual([{ memberId: BEN, state: 'ringing' }])
    expect(h.rpcs).toContainEqual(['team_call_ring_members', { target_call: CALL, members: [BEN] }])
    await runAfters()
    expect(h.events).toEqual([{ name: 'team-calls/ring.started', data: { ringId: RING, expiresAt: '2026-11-11T10:00:40Z' } }])
  })

  it('a second start joins the live call: no room made, nobody rung, nobody told again', async () => {
    h.rpc.team_call_start = { data: [{ call_id: CALL, room: `tc-${CALL}`, message_id: MSG, created: false }], error: null }
    const res = await startCall(post('http://localhost/api/account/team-calls', { channelId: DM }))
    const json = await res.json()
    expect(json.call).toMatchObject({ id: CALL, created: false })
    expect(h.rooms.made).toEqual([])
    expect(h.rpcs.map(([n]) => n)).toEqual(['team_call_start'])
    await runAfters()
    expect(h.events).toEqual([])
  })

  it('a live call whose room is gone (its end was lost) is ended and a new one started', async () => {
    tables.team_call[0].started_at = new Date(Date.now() - 5 * 60_000).toISOString()
    h.rooms.open.clear()
    const NEW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    h.rpc.team_call_start = [
      { data: [{ call_id: CALL, room: `tc-${CALL}`, message_id: MSG, created: false }], error: null },
      { data: [{ call_id: NEW, room: `tc-${NEW}`, message_id: MSG, created: true }], error: null },
    ]
    const json = await (await startCall(post('http://localhost/api/account/team-calls', { channelId: CH }))).json()
    expect(h.svcRpcs).toContainEqual(['team_call_end', expect.objectContaining({ target_call: CALL, end_reason: 'swept' })])
    expect(json.call.id).toBe(NEW)
    expect(h.rooms.made).toEqual([`tc-${NEW}`])
  })

  it('a room the server can’t make: the call is ended (failed) and the answer says so', async () => {
    h.rooms.failMake = true
    h.rpc.team_call_start = { data: [{ call_id: CALL, room: `tc-${CALL}`, message_id: MSG, created: true }], error: null }
    const res = await startCall(post('http://localhost/api/account/team-calls', { channelId: CH }))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('CALLS_UNREACHABLE')
    expect(h.svcRpcs).toContainEqual(['team_call_end', expect.objectContaining({ target_call: CALL, end_reason: 'failed' })])
  })

  it('a conversation the person may not read: 404, nothing started', async () => {
    const res = await startCall(post('http://localhost/api/account/team-calls', { channelId: HIDDEN }))
    expect(res.status).toBe(404)
    expect(h.rpcs).toEqual([])
  })

  it('the database refusing (may not post): 403', async () => {
    h.rpc.team_call_start = { data: null, error: { code: '42501', message: 'no' } }
    expect((await startCall(post('http://localhost/api/account/team-calls', { channelId: CH }))).status).toBe(403)
  })

  it('a malformed body: 400', async () => {
    expect((await startCall(post('http://localhost/api/account/team-calls', { channelId: 'x' }))).status).toBe(400)
  })
})

describe('POST /api/account/team-calls/[id]/ring', () => {
  it('rings the people picked (deduped), and starts their timers after the answer', async () => {
    h.rpc.team_call_ring_members = { data: [{ ring_id: RING, member_id: BEN, user_id: 'u-ben', state: 'busy', expires_at: '2026-11-11T10:00:40Z' }], error: null }
    const res = await ring(post('http://localhost/x', { memberIds: [BEN, BEN, 'junk'] }), params(CALL))
    expect(await res.json()).toEqual({ rings: [{ memberId: BEN, state: 'busy' }] })
    expect(h.rpcs).toEqual([['team_call_ring_members', { target_call: CALL, members: [BEN] }]])
    await runAfters()
    expect(h.events.map((e) => e.name)).toEqual(['team-calls/ring.started'])
  })

  it('nobody, or too many: 400', async () => {
    expect((await ring(post('http://localhost/x', { memberIds: [] }), params(CALL))).status).toBe(400)
    const many = Array.from({ length: 21 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`)
    expect((await ring(post('http://localhost/x', { memberIds: many }), params(CALL))).status).toBe(400)
  })
})

describe('POST /api/account/team-calls/rings/[id] (answer)', () => {
  it('accepted: the join for the call’s room', async () => {
    h.rpc.team_call_answer = { data: [{ call_id: CALL, state: 'accepted' }], error: null }
    const json = await (await answer(post('http://localhost/x', { accept: true }), params(RING))).json()
    expect(json.state).toBe('accepted')
    expect((await claimsOf(json.join.token)).video?.room).toBe(`tc-${CALL}`)
    expect(h.rpcs[0]).toEqual(['team_call_answer', { target_ring: RING, accept: true }])
  })

  it('declined: no join', async () => {
    h.rpc.team_call_answer = { data: [{ call_id: CALL, state: 'declined' }], error: null }
    const json = await (await answer(post('http://localhost/x', { accept: false }), params(RING))).json()
    expect(json).toEqual({ state: 'declined' })
  })

  it('accepting a ring settled elsewhere (declined on another device): says so, no join', async () => {
    h.rpc.team_call_answer = { data: [{ call_id: CALL, state: 'declined' }], error: null }
    const json = await (await answer(post('http://localhost/x', { accept: true }), params(RING))).json()
    expect(json).toEqual({ state: 'declined' })
  })

  it('someone else’s ring: refused by the database (403)', async () => {
    h.rpc.team_call_answer = { data: null, error: { code: '42501', message: 'no such ring' } }
    expect((await answer(post('http://localhost/x', { accept: true }), params(RING))).status).toBe(403)
  })

  it('accept must be a yes or a no', async () => {
    expect((await answer(post('http://localhost/x', { accept: 'yes' }), params(RING))).status).toBe(400)
  })
})

describe('POST /api/account/team-calls/[id]/leave', () => {
  it('a DM’s hang-up ends the call at once, tells whoever was still being rung, and closes the room', async () => {
    tables.team_call[0].channel_id = DM
    svcTables.team_chat_message = [{ id: MSG, body: 'Missed call', attachments: [] }]
    h.rpc['svc:team_call_end'] = {
      data: [
        {
          ring_id: RING, call_id: CALL, message_id: MSG, workspace_id: WS, channel_id: DM, channel_kind: 'dm', channel_name: null,
          member_id: BEN, user_id: 'u-ben', caller_member_id: ME, caller_name: 'Ana Ruiz',
        },
      ],
      error: null,
    }
    const res = await leave(post('http://localhost/x'), params(CALL))
    expect(await res.json()).toEqual({ ended: true })
    expect(h.svcRpcs[0]).toEqual(['team_call_end', expect.objectContaining({ target_call: CALL, end_reason: 'left' })])
    await runAfters()
    expect(h.rooms.closed).toEqual([`tc-${CALL}`])
    expect(svcTables.notification).toHaveLength(1)
    expect(svcTables.notification[0]).toMatchObject({ recipient_id: BEN, type: 'team_chat_message', target_id: MSG, title: 'Missed call from Ana Ruiz' })
  })

  it('a channel’s call goes on: nothing ends', async () => {
    const res = await leave(post('http://localhost/x'), params(CALL))
    expect(await res.json()).toEqual({ ended: false })
    expect(h.svcRpcs).toEqual([])
  })

  it('a call the person may not read: 404', async () => {
    expect((await leave(post('http://localhost/x'), params(HIDDEN))).status).toBe(404)
  })
})
