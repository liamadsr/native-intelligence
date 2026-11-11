/**
 * Draining the eject outbox (src/lib/team-calls/eject.ts): each pending
 * entry goes to LiveKit (a person taken out of the room, or a room closed)
 * and is marked done; one LiveKit can't take now stays pending, counted,
 * for the next drain; done entries are left alone. And asking for a drain
 * does nothing while calling is off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { drainTeamCallEjections, requestTeamCallEjections } from '../eject'
import { LIVEKIT_ENV } from './signing'

let tables: Record<string, Array<Record<string, unknown>>>
let db: SupabaseClient
beforeEach(() => {
  tables = {
    team_call_eject: [
      { id: 'e1', room: 'tc-a', identity: 'mem-1', attempts: 0, done_at: null, created_at: '2026-11-11T10:00:00Z' },
      { id: 'e2', room: 'tc-b', identity: null, attempts: 0, done_at: null, created_at: '2026-11-11T10:00:01Z' },
      { id: 'e3', room: 'tc-c', identity: 'mem-3', attempts: 2, done_at: '2026-11-11T09:00:00Z', created_at: '2026-11-11T09:00:00Z' },
      { id: 'e4', room: 'tc-d', identity: 'mem-4', attempts: 0, done_at: null, created_at: '2026-11-11T10:00:02Z' },
    ],
  }
  db = memoryDb(tables)
})
afterEach(() => {
  for (const name of Object.keys(LIVEKIT_ENV)) delete process.env[name]
})

describe('drainTeamCallEjections', () => {
  it('takes each person out, closes each room, marks them done; what LiveKit refuses waits, counted', async () => {
    const removed: Array<[string, string]> = []
    const closed: string[] = []
    const result = await drainTeamCallEjections(db, {
      remove: async (room, identity) => {
        if (room === 'tc-d') throw new Error('connect ECONNREFUSED')
        removed.push([room, identity])
      },
      close: async (room) => {
        closed.push(room)
      },
    })
    expect(removed).toEqual([['tc-a', 'mem-1']])
    expect(closed).toEqual(['tc-b'])
    expect(result).toEqual({ done: 2, failed: 1 })
    const by = Object.fromEntries(tables.team_call_eject.map((r) => [r.id, r]))
    expect(by.e1.done_at).toBeTruthy()
    expect(by.e2.done_at).toBeTruthy()
    expect(by.e4).toMatchObject({ done_at: null, attempts: 1 })
    expect(by.e3.attempts).toBe(2)
  })

  it('the next drain takes what waited', async () => {
    const deps = { remove: async () => {}, close: async () => {} }
    await drainTeamCallEjections(db, deps)
    expect(tables.team_call_eject.every((r) => r.done_at)).toBe(true)
    expect(await drainTeamCallEjections(db, deps)).toEqual({ done: 0, failed: 0 })
  })
})

describe('requestTeamCallEjections', () => {
  it('asks for a drain when calling is on, and does nothing while it is off', async () => {
    const sent: unknown[] = []
    await requestTeamCallEjections(async (e) => void sent.push(e))
    expect(sent).toEqual([])
    Object.assign(process.env, LIVEKIT_ENV)
    await requestTeamCallEjections(async (e) => void sent.push(e))
    expect(sent).toEqual([{ name: 'team-calls/eject.requested', data: {} }])
  })
})
