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

  it('each entry done stops the phones still ringing for it: a member’s rings, or the whole call’s', async () => {
    tables.team_call_eject[0].call_id = 'call-a'
    tables.team_call_eject[1].call_id = 'call-b'
    tables.team_call_eject[3].call_id = 'call-d'
    const stopped: Array<[string, string | null]> = []
    await drainTeamCallEjections(db, {
      remove: async (room) => {
        if (room === 'tc-d') throw new Error('connect ECONNREFUSED')
      },
      close: async () => {},
      stopPhones: async (_svc, callId, memberId) => void stopped.push([callId, memberId]),
    })
    // The one LiveKit refused waits, and so do its phones' cancels (the next drain sends them).
    expect(stopped).toEqual([['call-a', 'mem-1'], ['call-b', null]])
  })

  it('the next drain takes what waited', async () => {
    const deps = { remove: async () => {}, close: async () => {} }
    await drainTeamCallEjections(db, deps)
    expect(tables.team_call_eject.every((r) => r.done_at)).toBe(true)
    expect(await drainTeamCallEjections(db, deps)).toEqual({ done: 0, failed: 0 })
  })
})

describe('the call recorder on the outbox', () => {
  it('settled first: a recorder the call wants again (notes off, then on) is left in the room; one it does not is taken out', async () => {
    tables.team_call_eject = [
      { id: 'r1', call_id: 'call-a', room: 'tc-a', identity: 'notes-recorder-recorder', attempts: 0, done_at: null, created_at: '2026-11-11T10:00:00Z' },
      { id: 'r2', call_id: 'call-b', room: 'tc-b', identity: 'notes-recorder-recorder', attempts: 0, done_at: null, created_at: '2026-11-11T10:00:01Z' },
    ]
    const asked: string[] = []
    const svc = Object.assign(memoryDb(tables), {
      rpc: async (name: string) => {
        asked.push(name)
        // 588's capture_feed_settle_ejects: call-a has the recorder's live session in its current round.
        tables.team_call_eject[0].done_at = '2026-11-11T10:00:05Z'
        return { data: 1, error: null }
      },
    }) as unknown as SupabaseClient
    const removed: Array<[string, string]> = []
    const stopped: unknown[] = []
    const result = await drainTeamCallEjections(svc, {
      remove: async (room, identity) => void removed.push([room, identity]),
      close: async () => {},
      stopPhones: async (...args) => void stopped.push(args),
    })
    expect(asked).toEqual(['capture_feed_settle_ejects'])
    expect(removed).toEqual([['tc-b', 'notes-recorder-recorder']])
    expect(result).toEqual({ done: 1, failed: 0 })
    // A recorder rings no phone.
    expect(stopped).toEqual([])
  })

  it('a settle that fails takes the recorder out anyway (the work list puts it back); no recorder entry, no settle', async () => {
    tables.team_call_eject = [{ id: 'r1', call_id: 'call-a', room: 'tc-a', identity: 'notes-recorder-recorder', attempts: 0, done_at: null, created_at: '2026-11-11T10:00:00Z' }]
    const failing = Object.assign(memoryDb(tables), { rpc: async () => ({ data: null, error: { message: 'no such function' } }) }) as unknown as SupabaseClient
    const removed: string[] = []
    const warn = console.warn
    console.warn = () => undefined
    try {
      await drainTeamCallEjections(failing, { remove: async (_room, identity) => void removed.push(identity), close: async () => {} })
    } finally {
      console.warn = warn
    }
    expect(removed).toEqual(['notes-recorder-recorder'])
    const asked: string[] = []
    const plain = Object.assign(memoryDb({ team_call_eject: [{ id: 'p1', room: 'tc-x', identity: 'mem-1', attempts: 0, done_at: null, created_at: '2026-11-11T10:00:00Z' }] }), {
      rpc: async (name: string) => (asked.push(name), { data: 0, error: null }),
    }) as unknown as SupabaseClient
    await drainTeamCallEjections(plain, { remove: async () => {}, close: async () => {} })
    expect(asked).toEqual([])
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
