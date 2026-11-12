/**
 * LiveKit's webhook (src/app/api/calls/livekit/webhook/route.ts): no
 * session, our signature over the raw body or a 401 that changes nothing;
 * an event id applied once (a repeat is answered and skipped); participant
 * events go to 565's ordering function with the member id, the session and
 * the time; room_finished ends its call once and tells whoever was still
 * rung; a room of no call of ours, and any other event, are answered and
 * ignored; a failed write is a 500 so LiveKit sends it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { LIVEKIT_ENV, signWebhook } from '@/lib/team-calls/__tests__/signing'

const CALL = '77777777-7777-4777-8777-777777777777'
const MEMBER = '33333333-3333-4333-8333-333333333333'
const ROOM = `tc-${CALL}`

const h = vi.hoisted(() => ({
  db: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
  events: [] as Array<{ name: string; id?: string; data: unknown }>,
  removed: [] as Array<[string, string]>,
  openRooms: new Set<string>(),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.db }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: async (events: unknown) => {
      for (const e of (Array.isArray(events) ? events : [events]) as Array<{ name: string; id?: string; data: unknown }>) h.events.push(e)
      return { ids: [] }
    },
  },
}))
vi.mock('@/lib/team-calls/livekit', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/livekit')>()),
  openTeamCallRooms: async (_c: unknown, names: string[]) => new Set(names.filter((n) => h.openRooms.has(n))),
  removeFromTeamCallRoom: async (_c: unknown, room: string, identity: string) => {
    h.removed.push([room, identity])
  },
  closeTeamCallRoom: async () => {},
}))

import { POST } from '../route'

let tables: Record<string, Array<Record<string, unknown>>>
beforeEach(() => {
  Object.assign(process.env, LIVEKIT_ENV)
  tables = {
    team_call: [{ id: CALL, room: ROOM, status: 'live' }],
    team_call_webhook_event: [],
    team_call_eject: [],
    notification: [],
  }
  h.db = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcs.push([name, args])
      return h.rpc[name] ?? { data: null, error: null }
    },
  }) as unknown as SupabaseClient
  h.rpcs = []
  h.events = []
  h.removed = []
  h.openRooms = new Set()
  h.rpc = { team_call_participant_event: { data: 'joined', error: null }, team_call_end: { data: [], error: null } }
})
afterEach(() => {
  for (const name of Object.keys(LIVEKIT_ENV)) delete process.env[name]
})

async function deliver(event: Record<string, unknown>, opts: { sign?: boolean; tamper?: boolean } = {}) {
  const body = JSON.stringify(event)
  const auth = opts.sign === false ? null : await signWebhook(opts.tamper ? body.replace(ROOM, 'tc-other') : body)
  return POST(
    new NextRequest('http://localhost/api/calls/livekit/webhook', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/webhook+json', ...(auth ? { authorization: auth } : {}) },
    }),
  )
}

const joined = (id: string, sid: string, at: number) => ({
  id,
  event: 'participant_joined',
  createdAt: String(at),
  room: { name: ROOM },
  participant: { identity: MEMBER, sid, joinedAt: String(at - 1), joinedAtMs: String((at - 1) * 1000 + 250) },
})
/** A leave carries the session's join time too (LiveKit's participant info). */
const left = (id: string, sid: string, at: number, joinedSec = at - 60) => ({
  id,
  event: 'participant_left',
  createdAt: String(at),
  room: { name: ROOM },
  participant: { identity: MEMBER, sid, joinedAt: String(joinedSec), joinedAtMs: String(joinedSec * 1000 + 250) },
})

describe('POST /api/calls/livekit/webhook', () => {
  it('no signature: 401, nothing read or written', async () => {
    const res = await deliver(joined('EV_1', 'PA_1', 1762850000), { sign: false })
    expect(res.status).toBe(401)
    expect(h.rpcs).toEqual([])
    expect(tables.team_call_webhook_event).toEqual([])
  })

  it('a signature over another body: 401, nothing changes', async () => {
    const res = await deliver(joined('EV_1', 'PA_1', 1762850000), { tamper: true })
    expect(res.status).toBe(401)
    expect(h.rpcs).toEqual([])
  })

  it('a join: the member, their session and the time they joined (to the millisecond), then remembered', async () => {
    const res = await deliver(joined('EV_1', 'PA_1', 1762850000))
    expect(await res.json()).toEqual({ ok: true, outcome: 'joined' })
    const joinedAt = new Date(1762849999 * 1000 + 250).toISOString()
    expect(h.rpcs).toEqual([
      ['team_call_participant_event', { room_name: ROOM, member_ref: MEMBER, session_ref: 'PA_1', is_join: true, event_at: joinedAt, session_joined_at: joinedAt }],
    ])
    expect(tables.team_call_webhook_event.map((r) => r.id)).toEqual(['EV_1'])
  })

  it('the same event again (LiveKit repeats): answered, skipped', async () => {
    await deliver(joined('EV_1', 'PA_1', 1762850000))
    const again = await deliver(joined('EV_1', 'PA_1', 1762850000))
    expect(await again.json()).toEqual({ ok: true, outcome: 'repeat' })
    expect(h.rpcs).toHaveLength(1)
  })

  it('out of order (a leave before its join): each goes to the ordering function with its time and its session’s join time', async () => {
    h.rpc.team_call_participant_event = { data: 'left', error: null }
    await deliver(left('EV_2', 'PA_1', 1762850100, 1762849999))
    h.rpc.team_call_participant_event = { data: 'stale', error: null }
    const late = await deliver(joined('EV_1', 'PA_1', 1762850000))
    expect(await late.json()).toEqual({ ok: true, outcome: 'stale' })
    const sessionJoined = new Date(1762849999 * 1000 + 250).toISOString()
    expect(h.rpcs.map(([, a]) => [a.is_join, a.event_at, a.session_joined_at])).toEqual([
      [false, new Date(1762850100 * 1000).toISOString(), sessionJoined],
      [true, sessionJoined, sessionJoined],
    ])
  })

  it('a reconnect: the old session’s leave carries its own (older) join time, so the database can tell it from the new one', async () => {
    await deliver(joined('EV_5', 'PA_new', 1762850500))
    await deliver(left('EV_6', 'PA_old', 1762850499, 1762850000))
    const [join, leave] = h.rpcs.map(([, a]) => a)
    // The leave lands in the same second the new session joined; only the join times tell them apart.
    expect(String(leave.event_at).slice(0, 19)).toBe(String(join.event_at).slice(0, 19))
    expect(Date.parse(String(leave.session_joined_at))).toBeLessThan(Date.parse(String(join.session_joined_at)))
  })

  it('a dropped connection counts as a leave', async () => {
    await deliver({ ...left('EV_3', 'PA_1', 1762850200), event: 'participant_connection_aborted' })
    expect(h.rpcs[0][1].is_join).toBe(false)
  })

  it('room_finished ends the call once; the people still being rung are told through an event per ring, never inline', async () => {
    h.rpc.team_call_end = {
      data: [
        {
          ring_id: 'r1', call_id: CALL, message_id: 'm1', workspace_id: 'w1', channel_id: 'c1', channel_kind: 'channel', channel_name: 'launch',
          member_id: 'mem-b', user_id: 'u-b', caller_member_id: MEMBER, caller_name: 'Ana Ruiz',
        },
      ],
      error: null,
    }
    const res = await deliver({ id: 'EV_9', event: 'room_finished', createdAt: '1762851000', room: { name: ROOM } })
    expect(await res.json()).toEqual({ ok: true, outcome: 'ended' })
    expect(h.rpcs).toEqual([['team_call_end', { target_call: CALL, end_reason: 'finished', end_at: new Date(1762851000 * 1000).toISOString() }]])
    expect(tables.notification).toEqual([])
    // The missed ring's notice, and the drain of the eject outbox where 589 put the ended call's room
    // (gone already here: the drain finds it so; for an end anywhere else, it closes the room).
    expect(h.events).toEqual(
      expect.arrayContaining([
        { name: 'team-calls/missed.requested', id: 'team-call-missed-r1', data: { ringId: 'r1' } },
        { name: 'team-calls/eject.requested', data: {} },
      ]),
    )
    expect(h.events).toHaveLength(2)
  })

  it('room_finished for a room made again since (the live call joined after it closed): not the call\u2019s end', async () => {
    h.openRooms.add(ROOM)
    const res = await deliver({ id: 'EV_11', event: 'room_finished', createdAt: '1762851000', room: { name: ROOM } })
    expect(await res.json()).toEqual({ ok: true, outcome: 'reopened' })
    expect(h.rpcs).toEqual([])
  })

  it('a join by someone who may no longer read the conversation: refused by the database, and taken out of the room at once', async () => {
    h.rpc.team_call_participant_event = { data: 'ejected', error: null }
    tables.team_call_eject.push({ id: 'ej1', room: ROOM, identity: MEMBER, attempts: 0, done_at: null, created_at: '2026-11-11T10:00:00Z' })
    const res = await deliver(joined('EV_40', 'PA_9', 1762850000))
    expect(await res.json()).toEqual({ ok: true, outcome: 'ejected' })
    expect(h.removed).toEqual([[ROOM, MEMBER]])
    expect(tables.team_call_eject[0].done_at).toBeTruthy()
  })

  it('room_finished for a call already ended (the hang-up got there first): nothing to do', async () => {
    tables.team_call[0].status = 'ended'
    const res = await deliver({ id: 'EV_10', event: 'room_finished', createdAt: '1762851000', room: { name: ROOM } })
    expect(await res.json()).toEqual({ ok: true, outcome: 'already_ended' })
    expect(h.rpcs).toEqual([])
  })

  it('a room that is no call of ours, an identity that is no member id, another event: answered, ignored', async () => {
    for (const ev of [
      { ...joined('EV_20', 'PA_1', 1762850000), room: { name: 'some-other-app-room' } },
      { ...joined('EV_21', 'PA_1', 1762850000), participant: { identity: 'egress-bot', sid: 'PA_x' } },
      { id: 'EV_22', event: 'track_published', createdAt: '1762850000', room: { name: ROOM } },
    ]) {
      expect((await (await deliver(ev)).json()).outcome).toBe('ignored')
    }
    expect(h.rpcs).toEqual([])
  })

  it('a failed write is a 500 (LiveKit sends it again), and the event is not remembered as applied', async () => {
    h.rpc.team_call_participant_event = { data: null, error: { message: 'deadlock' } }
    const res = await deliver(joined('EV_30', 'PA_1', 1762850000))
    expect(res.status).toBe(500)
    expect(tables.team_call_webhook_event).toEqual([])
  })

  it('with calling off: 404', async () => {
    for (const name of Object.keys(LIVEKIT_ENV)) delete process.env[name]
    expect((await deliver(joined('EV_1', 'PA_1', 1762850000))).status).toBe(404)
  })
})
