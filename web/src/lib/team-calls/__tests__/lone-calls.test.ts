/**
 * A two-person call is never left unheard because a join webhook was lost
 * (src/lib/team-calls/recorder.ts reconcileLoneCalls): a live call with notes
 * on whose counter says fewer than two were ever in it has its room's people
 * counted from LiveKit (teamCallRoomPeople), and two or more raise the counter
 * (589's team_call_people_seen), so the next work answer offers it. Bounded:
 * calls older than the webhook's own time, each at most every 15 s, at most a
 * few per request; LiveKit failing never fails the work answer. And a room's
 * people are members and guests only: never the recorder, never Egress.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { LIVEKIT_ENV } from './signing'

const listed = vi.hoisted(() => ({ byRoom: {} as Record<string, Array<{ identity: string }> | 'gone'> }))
vi.mock('livekit-server-sdk', async (orig) => ({
  ...(await orig<typeof import('livekit-server-sdk')>()),
  RoomServiceClient: class {
    async listParticipants(room: string) {
      const list = listed.byRoom[room]
      if (list === 'gone') throw Object.assign(new Error('requested room does not exist'), { status: 404 })
      return list ?? []
    }
  },
}))

import { LONE_CALL_LOOKS_PER_ASK, LONE_CALL_LOOK_EVERY_MS, __forgetLoneCallLooks, reconcileLoneCalls } from '../recorder'
import { teamCallRoomPeople, teamCallsConfig } from '../livekit'

const NOW = Date.parse('2026-11-12T10:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let tables: Record<string, Array<Record<string, unknown>>>
let seen: Array<{ target_call: string; people: number }>
let svc: SupabaseClient

function call(n: number, over: Record<string, unknown> = {}) {
  return { id: id(n), room: `tc-${id(n)}`, status: 'live', notes: true, peak_participants: 1, started_at: ago(60_000), ...over }
}

beforeEach(() => {
  __forgetLoneCallLooks()
  seen = []
  tables = { team_call: [] }
  svc = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: { target_call: string; people: number }) => {
      if (name !== 'team_call_people_seen') return { data: null, error: { message: `no ${name}` } }
      seen.push(args)
      const row = tables.team_call.find((c) => c.id === args.target_call)!
      row.peak_participants = Math.max(Number(row.peak_participants), args.people)
      return { data: row.peak_participants, error: null }
    },
  }) as unknown as SupabaseClient
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('reconcileLoneCalls', () => {
  it('two people in a lone call’s room (its join webhook lost): the counter raised, so the call is heard', async () => {
    tables.team_call.push(
      call(1),
      call(2, { peak_participants: 2 }), // heard already: never looked at again
      call(3, { started_at: ago(2_000) }), // too young: its webhook is still on the way
      call(4, { status: 'ended' }),
      call(5, { notes: false }),
    )
    const looked: string[] = []
    const raised = await reconcileLoneCalls(svc, async (room) => (looked.push(room), room === `tc-${id(1)}` ? 2 : 1), NOW)
    expect(raised).toBe(1)
    expect(looked).toEqual([`tc-${id(1)}`])
    expect(seen).toEqual([{ target_call: id(1), people: 2 }])
    expect(tables.team_call[0].peak_participants).toBe(2)
  })

  it('one person waiting: nothing raised; looked at again only after its interval', async () => {
    tables.team_call.push(call(1))
    const looked: number[] = []
    const people = async () => (looked.push(1), 1)
    await reconcileLoneCalls(svc, people, NOW)
    await reconcileLoneCalls(svc, people, NOW + 5_000)
    expect(looked).toHaveLength(1)
    await reconcileLoneCalls(svc, people, NOW + LONE_CALL_LOOK_EVERY_MS)
    expect(looked).toHaveLength(2)
    expect(seen).toEqual([])
  })

  it('bounded: a few rooms per request, the rest at the next ones', async () => {
    for (let n = 1; n <= 12; n++) tables.team_call.push(call(n))
    const looked: string[] = []
    await reconcileLoneCalls(svc, async (room) => (looked.push(room), 0), NOW)
    expect(looked).toHaveLength(LONE_CALL_LOOKS_PER_ASK)
    await reconcileLoneCalls(svc, async (room) => (looked.push(room), 0), NOW + 3_000)
    expect(looked).toHaveLength(2 * LONE_CALL_LOOKS_PER_ASK)
    expect(new Set(looked).size).toBe(looked.length)
  })

  it('LiveKit failing, or the database: nothing raised, never a throw', async () => {
    tables.team_call.push(call(1))
    expect(await reconcileLoneCalls(svc, async () => Promise.reject(new Error('connect ECONNREFUSED')), NOW)).toBe(0)
    const broken = { from: () => ({ select: () => { throw new Error('db down') } }) } as unknown as SupabaseClient
    expect(await reconcileLoneCalls(broken, async () => 2, NOW)).toBe(0)
  })
})

describe('teamCallRoomPeople', () => {
  it('members and guests only: never the recorder or Egress; a room gone has nobody', async () => {
    const config = teamCallsConfig(LIVEKIT_ENV as unknown as NodeJS.ProcessEnv)!
    listed.byRoom['tc-a'] = [
      { identity: id(1) },
      { identity: `guest-${id(2)}` },
      { identity: 'notes-recorder-recorder' },
      { identity: 'EG_abc123' },
    ]
    listed.byRoom['tc-gone'] = 'gone'
    expect(await teamCallRoomPeople(config, 'tc-a')).toBe(2)
    expect(await teamCallRoomPeople(config, 'tc-gone')).toBe(0)
  })
})
