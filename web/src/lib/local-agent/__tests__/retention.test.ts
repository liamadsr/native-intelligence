/**
 * Transcript retention (src/lib/local-agent/retention.ts). It deletes rows, so
 * most of what is pinned is what it refuses to touch:
 *   1. A session active inside the 30 days keeps its WHOLE transcript, old
 *      events included; an idle one loses all of it.
 *   2. An event younger than 30 days is never deleted, whatever its session.
 *   3. Only events go: sessions and messages stay.
 *   4. The walk is bounded: it stops at the first event inside the window,
 *      steps over a kept session's old events, and caps the pages per tick.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { EVENT_RETENTION_DAYS, purgeOldEvents } from '../retention'
import { DEVICE, FOLDER, USER, WS, fakeDb, type Row } from './fake-db'

const NOW = Date.parse('2026-12-01T00:00:00Z')
const DAY = 24 * 60 * 60_000
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString()

const session = (id: string, updatedDaysAgo: number): Row => ({
  id,
  user_id: USER,
  workspace_id: WS,
  device_id: DEVICE,
  folder_id: FOLDER,
  status: 'cancelled',
  request: 'look',
  updated_at: daysAgo(updatedDaysAgo),
  created_at: daysAgo(updatedDaysAgo + 1),
})

let nextId = 0
const events = (sessionId: string, n: number, createdDaysAgo: number): Row[] =>
  Array.from({ length: n }, () => ({
    id: ++nextId,
    session_id: sessionId,
    user_id: USER,
    source: 'server',
    run_id: null,
    seq: null,
    kind: 'inbound',
    payload: {},
    created_at: daysAgo(createdDaysAgo),
  }))

const ids = (db: ReturnType<typeof fakeDb>, sessionId: string) =>
  (db.tables.local_agent_event ?? []).filter((e) => e.session_id === sessionId).length

const svcOf = (db: ReturnType<typeof fakeDb>) => db as unknown as SupabaseClient

describe('purgeOldEvents', () => {
  it('keeps 30 days', () => {
    expect(EVENT_RETENTION_DAYS).toBe(30)
  })

  it('deletes an idle session’s whole transcript and keeps one still in use, old events included', async () => {
    nextId = 0
    const db = fakeDb({
      local_agent_session: [session('idle', 40), session('busy', 2), session('recent', 5)],
      local_agent_event: [...events('idle', 3, 45), ...events('busy', 2, 35), ...events('idle', 1, 41), ...events('recent', 2, 5), ...events('busy', 1, 2)],
      local_agent_message: [{ id: 'm1', session_id: 'idle', user_id: USER }],
    })
    const r = await purgeOldEvents(svcOf(db), NOW)
    expect(r).toMatchObject({ ok: true, sessionsPurged: 1, sessionsKept: 1, eventsDeleted: 4, truncated: false })
    expect(ids(db, 'idle')).toBe(0)
    expect(ids(db, 'busy')).toBe(3)
    expect(ids(db, 'recent')).toBe(2)
    // Only events go.
    expect(db.tables.local_agent_session).toHaveLength(3)
    expect(db.tables.local_agent_message).toHaveLength(1)
  })

  it('never deletes an event younger than 30 days, even when its session looks idle', async () => {
    nextId = 0
    const db = fakeDb({
      local_agent_session: [session('odd', 40)],
      local_agent_event: [...events('odd', 2, 40), ...events('odd', 1, 3)],
    })
    const r = await purgeOldEvents(svcOf(db), NOW)
    expect(r.eventsDeleted).toBe(2)
    expect(ids(db, 'odd')).toBe(1)
  })

  it('stops at the first event inside the window', async () => {
    nextId = 0
    const db = fakeDb({
      local_agent_session: [session('idle', 40), session('later', 40)],
      // `later` is idle too, but its events sit after a recent one in id order.
      local_agent_event: [...events('idle', 2, 40), ...events('idle', 1, 1), ...events('later', 2, 40)],
    })
    const r = await purgeOldEvents(svcOf(db), NOW)
    expect(r.scanned).toBe(2)
    expect(r.truncated).toBe(false)
  })

  it('steps over a kept session’s old events across pages', async () => {
    nextId = 0
    const db = fakeDb({
      local_agent_session: [session('busy', 1), session('idle', 40)],
      local_agent_event: [...events('busy', 1200, 35), ...events('idle', 3, 34)],
    })
    const r = await purgeOldEvents(svcOf(db), NOW)
    expect(r).toMatchObject({ ok: true, sessionsPurged: 1, sessionsKept: 1, eventsDeleted: 3, truncated: false })
    expect(ids(db, 'busy')).toBe(1200)
    expect(ids(db, 'idle')).toBe(0)
  })

  it('caps the walk per tick and says so', async () => {
    nextId = 0
    const db = fakeDb({
      local_agent_session: [session('busy', 1)],
      local_agent_event: events('busy', 5001, 35),
    })
    const r = await purgeOldEvents(svcOf(db), NOW)
    expect(r).toMatchObject({ ok: true, scanned: 5000, eventsDeleted: 0, truncated: true })
  })

  it('reads Postgres timestamps (+00:00, no fractions) as instants', async () => {
    nextId = 0
    const pg = (iso: string) => iso.replace(/\.\d{3}Z$/, '+00:00')
    const db = fakeDb({
      local_agent_session: [{ ...session('idle', 40), updated_at: pg(daysAgo(40)) }],
      local_agent_event: events('idle', 2, 40).map((e) => ({ ...e, created_at: pg(e.created_at as string) })),
    })
    const r = await purgeOldEvents(svcOf(db), NOW)
    expect(r.eventsDeleted).toBe(2)
  })

  it('an empty table is a quiet tick', async () => {
    const r = await purgeOldEvents(svcOf(fakeDb()), NOW)
    expect(r).toMatchObject({ ok: true, scanned: 0, eventsDeleted: 0, truncated: false })
  })

  it('a failed read deletes nothing and reports it', async () => {
    nextId = 0
    const db = fakeDb({ local_agent_session: [session('idle', 40)], local_agent_event: events('idle', 2, 40) })
    const failing = {
      from: (table: string) => {
        const q = db.from(table) as Record<string, (...a: unknown[]) => unknown>
        if (table !== 'local_agent_session') return q
        return { select: () => ({ in: async () => ({ data: null, error: { message: 'boom' } }) }) }
      },
    } as unknown as SupabaseClient
    const err = console.error
    console.error = () => {}
    const r = await purgeOldEvents(failing, NOW)
    console.error = err
    expect(r.ok).toBe(false)
    expect(ids(db, 'idle')).toBe(2)
  })
})
