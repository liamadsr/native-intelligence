/**
 * The sweeper (src/lib/team-calls/sweep.ts): a live call older than its
 * grace whose room is gone is ended ('swept'), a live call whose room is
 * open is left alone, nothing is ended when LiveKit can't be asked (or is
 * off), rings past their time are missed (and handed back, for the cron to
 * tell their people in a step of its own), and old webhook ids are forgotten.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { sweepTeamCalls, TEAM_CALL_SWEEP_GRACE_MS, TEAM_CALL_WEBHOOK_MEMORY_MS } from '../sweep'
import type { MissedRing } from '../store'

const NOW = new Date('2026-11-11T10:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

let tables: Record<string, Array<Record<string, unknown>>>
let rpcs: Array<[string, Record<string, unknown>]>
let rpc: Record<string, { data: unknown; error: unknown }>
let db: SupabaseClient

const missed = (id: string): MissedRing => ({
  ring_id: id, call_id: 'c', message_id: 'm', workspace_id: 'w', channel_id: 'ch', channel_kind: 'channel', channel_name: 'launch',
  member_id: 'mem', user_id: 'u', caller_member_id: 'ana', caller_name: 'Ana',
})

beforeEach(() => {
  tables = {
    team_call: [
      { id: 'gone', room: 'tc-gone', status: 'live', started_at: ago(TEAM_CALL_SWEEP_GRACE_MS + 60_000) },
      { id: 'open', room: 'tc-open', status: 'live', started_at: ago(TEAM_CALL_SWEEP_GRACE_MS + 60_000) },
      { id: 'young', room: 'tc-young', status: 'live', started_at: ago(10_000) },
      { id: 'over', room: 'tc-over', status: 'ended', started_at: ago(60 * 60_000) },
    ],
    team_call_webhook_event: [
      { id: 'old', received_at: ago(TEAM_CALL_WEBHOOK_MEMORY_MS + 1000) },
      { id: 'new', received_at: ago(60_000) },
    ],
  }
  rpcs = []
  rpc = { team_call_end: { data: [missed('r-end')], error: null }, team_call_expire_rings: { data: [missed('r-late')], error: null } }
  db = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args])
      return rpc[name] ?? { data: null, error: null }
    },
  }) as unknown as SupabaseClient
})

describe('sweepTeamCalls', () => {
  it('ends a call whose room is gone, leaves an open one and a young one, misses late rings, forgets old ids', async () => {
    const asked: string[][] = []
    const result = await sweepTeamCalls(db, {
      openRooms: async (names) => {
        asked.push([...names])
        return new Set(['tc-open'])
      },
      now: () => NOW,
    })
    expect(asked).toEqual([['tc-gone', 'tc-open']])
    expect(rpcs.filter(([n]) => n === 'team_call_end')).toEqual([['team_call_end', { target_call: 'gone', end_reason: 'swept', end_at: NOW.toISOString() }]])
    expect(rpcs).toContainEqual(['team_call_expire_rings', { only_ring: null }])
    expect(result).toMatchObject({ checked: 2, ended: 1, missed: 2, unreachable: false })
    expect(result.missedRings.map((r) => r.ring_id)).toEqual(['r-end', 'r-late'])
    expect(tables.team_call_webhook_event.map((r) => r.id)).toEqual(['new'])
  })

  it('LiveKit can’t be asked: no call is ended on a guess (rings still run out)', async () => {
    const result = await sweepTeamCalls(db, {
      openRooms: async () => {
        throw new Error('connect ECONNREFUSED')
      },
      now: () => NOW,
    })
    expect(rpcs.map(([n]) => n)).toEqual(['team_call_expire_rings'])
    expect(result.unreachable).toBe(true)
    expect(result.ended).toBe(0)
  })

  it('calling off: no LiveKit to ask, nothing ended', async () => {
    rpc.team_call_expire_rings = { data: [], error: null }
    const result = await sweepTeamCalls(db, { openRooms: null, now: () => NOW })
    expect(result).toEqual({ checked: 0, ended: 0, missed: 0, unreachable: false, missedRings: [] })
  })
})
