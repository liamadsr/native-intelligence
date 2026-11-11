/**
 * Meeting guests' consent and housekeeping (server side, phase 7):
 *   - notes or a recording coming on mid-call holds only the connected guests
 *     who have not said go to what is on now (src/lib/meeting-links/consent.ts);
 *   - a meeting's call left to guests past the grace is ended and its room
 *     closed (src/lib/meeting-links/sweep.ts);
 *   - the daily prune drops old limit windows and done guests' address keys,
 *     and clears old names without deleting a published row (store.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

const h = vi.hoisted(() => ({
  held: [] as string[],
  holdFails: new Set<string>(),
  ended: [] as string[],
  missed: 0,
  endFails: new Set<string>(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/team-calls/livekit', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/livekit')>()),
  holdGuestPublish: async (_c: unknown, room: string, guestId: string) => {
    if (h.holdFails.has(guestId)) throw new Error('participant not found')
    h.held.push(`${room}:${guestId}`)
  },
}))
vi.mock('@/lib/team-calls/store', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/store')>()),
  endCall: async (_svc: unknown, callId: string) => {
    if (h.endFails.has(callId)) throw new Error('boom')
    h.ended.push(callId)
    return [{ ring_id: 'r1' }]
  },
  requestMissedNotices: async (missed: unknown[]) => void (h.missed += missed.length),
}))

import { holdGuestsForNotice } from '../consent'
import { endGuestOnlyCalls, MEETING_GUEST_ONLY_GRACE_SECONDS } from '../sweep'
import { pruneMeetingGuests } from '../store'

const CALL = '44444444-4444-4444-8444-444444444444'
const CONFIG = { url: 'ws://127.0.0.1:7880', apiUrl: 'http://127.0.0.1:7880', apiKey: 'k', apiSecret: 's'.repeat(32) }
const g = (id: string, over: Record<string, unknown> = {}) => ({ id, call_id: CALL, state: 'admitted', in_call: true, notes_ack_round: 0, recording_ack_at: null, ...over })

beforeEach(() => {
  h.held = []
  h.holdFails = new Set()
  h.ended = []
  h.missed = 0
  h.endFails = new Set()
})

describe('notes or a recording coming on with guests connected', () => {
  it('holds every connected guest who has not said go to this notes round; never one who has, nor one not in the call', async () => {
    const tables = {
      team_call: [{ id: CALL, room: 'tc-r', status: 'live', notes: true, notes_round: 2, recording: 'off', recording_started_at: null }],
      meeting_guest: [
        g('g-new'), // never said go
        g('g-old', { notes_ack_round: 1 }), // said go to the last round, not this one
        g('g-ok', { notes_ack_round: 2 }), // said go to this round
        g('g-out', { in_call: false }), // let in, not connected
        g('g-wait', { state: 'waiting', in_call: false }),
      ],
    }
    const n = await holdGuestsForNotice(memoryDb(tables) as unknown as SupabaseClient, CONFIG, CALL)
    expect(n).toBe(2)
    expect(h.held.sort()).toEqual(['tc-r:g-new', 'tc-r:g-old'])
  })

  it('a recording starting holds guests who said go to the notes only', async () => {
    const tables = {
      team_call: [{ id: CALL, room: 'tc-r', status: 'live', notes: true, notes_round: 1, recording: 'starting', recording_started_at: '2026-11-11T12:05:00.000Z' }],
      meeting_guest: [g('g-notes', { notes_ack_round: 1 }), g('g-both', { notes_ack_round: 1, recording_ack_at: '2026-11-11T12:06:00.000Z' })],
    }
    await holdGuestsForNotice(memoryDb(tables) as unknown as SupabaseClient, CONFIG, CALL)
    expect(h.held).toEqual(['tc-r:g-notes'])
  })

  it('a guest LiveKit no longer has, an ended call, or a broken read: nothing thrown (their notes file is refused by the database anyway)', async () => {
    h.holdFails.add('g-gone')
    const live = { team_call: [{ id: CALL, room: 'tc-r', status: 'live', notes: true, notes_round: 1, recording: 'off', recording_started_at: null }], meeting_guest: [g('g-gone'), g('g-here')] }
    expect(await holdGuestsForNotice(memoryDb(live) as unknown as SupabaseClient, CONFIG, CALL)).toBe(1)
    const ended = { team_call: [{ ...live.team_call[0], status: 'ended' }], meeting_guest: [g('g-x')] }
    expect(await holdGuestsForNotice(memoryDb(ended) as unknown as SupabaseClient, CONFIG, CALL)).toBe(0)
    const broken = { from: () => { throw new Error('down') } } as unknown as SupabaseClient
    expect(await holdGuestsForNotice(broken, CONFIG, CALL)).toBe(0)
  })
})

describe('a meeting’s call left to guests', () => {
  const svcWith = (rows: Array<{ call_id: string; room: string }>, calls: Array<Record<string, unknown>>) =>
    Object.assign(memoryDb({}), {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, ...args })
        return { data: rows, error: null }
      },
    }) as unknown as SupabaseClient

  it('past the three-minute grace: each such call ended (its rings missed as any call’s) and its room closed', async () => {
    const calls: Array<Record<string, unknown>> = []
    const closed: string[] = []
    const n = await endGuestOnlyCalls(svcWith([{ call_id: 'c1', room: 'tc-1' }, { call_id: 'c2', room: 'tc-2' }], calls), { closeRoom: async (r) => void closed.push(r) })
    expect(MEETING_GUEST_ONLY_GRACE_SECONDS).toBe(180)
    expect(calls).toEqual([{ name: 'meeting_guest_only_calls', grace_seconds: 180 }])
    expect(n).toBe(2)
    expect(h.ended).toEqual(['c1', 'c2'])
    expect(h.missed).toBe(2)
    expect(closed).toEqual(['tc-1', 'tc-2'])
  })

  it('one that fails does not stop the others', async () => {
    h.endFails.add('c1')
    const closed: string[] = []
    const n = await endGuestOnlyCalls(svcWith([{ call_id: 'c1', room: 'tc-1' }, { call_id: 'c2', room: 'tc-2' }], []), { closeRoom: async (r) => void closed.push(r) })
    expect(n).toBe(1)
    expect(closed).toEqual(['tc-2'])
  })
})

describe('the daily prune', () => {
  const now = new Date('2026-11-11T04:17:00.000Z')
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const H = 3_600_000
  const D = 24 * H

  it('old limit windows and done guests’ keys go; a guest done 30 days keeps no name; nothing published is deleted', async () => {
    const tables = {
      meeting_rate: [
        { bucket: 'old', key: 'k', window_start: ago(2 * D) },
        { bucket: 'new', key: 'k', window_start: ago(H) },
      ],
      meeting_guest: [
        { id: 'g-left-old', state: 'left', name: 'Dana', requested_at: ago(40 * D), session_sid: 'PA_1' },
        { id: 'g-removed', state: 'removed', name: 'Lee', requested_at: ago(2 * D), session_sid: null },
        { id: 'g-waiting', state: 'waiting', name: 'Kai', requested_at: ago(2 * D), session_sid: null },
        { id: 'g-left-new', state: 'left', name: 'Mo', requested_at: ago(H), session_sid: null },
        { id: 'g-in', state: 'admitted', name: 'Noor', requested_at: ago(40 * D), session_sid: 'PA_2' },
      ],
      meeting_guest_key: [
        { guest_id: 'g-left-old', rate_key: 'a' },
        { guest_id: 'g-removed', rate_key: 'b' },
        { guest_id: 'g-waiting', rate_key: 'c' },
        { guest_id: 'g-left-new', rate_key: 'd' },
      ],
    }
    const out = await pruneMeetingGuests(memoryDb(tables) as unknown as SupabaseClient, now)
    expect(out).toEqual({ rates: 1, keys: 2, names: 1 })
    expect(tables.meeting_rate.map((r) => r.bucket)).toEqual(['new'])
    expect(tables.meeting_guest_key.map((k) => k.guest_id).sort()).toEqual(['g-left-new', 'g-waiting'])
    expect(tables.meeting_guest).toHaveLength(5)
    expect(tables.meeting_guest.find((x) => x.id === 'g-left-old')).toMatchObject({ name: 'Guest', session_sid: null })
    expect(tables.meeting_guest.find((x) => x.id === 'g-in')?.name).toBe('Noor')
  })
})
