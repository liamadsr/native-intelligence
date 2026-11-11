/**
 * Team calls' store (src/lib/team-calls/store.ts): a missed ring becomes the
 * call message's team chat notification (the same type a message's is, so
 * it toasts, banners, opens the conversation on the call and is read with
 * it), titled for the call; one a person had for the message already (a
 * channel set to all) turns into the missed call and is unread again; each
 * person told is handed to the away email. And the words an ended call's
 * line says are the database's (565's team_call_summary).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { missedCallTitle, notifyMissedCalls, teamCallRingEvent, type MissedRing } from '../store'
import { teamCallDuration, teamCallIdOfRoom, teamCallRingLine, teamCallRoom, teamCallSummary } from '../types'

const ring = (over: Partial<MissedRing> = {}): MissedRing => ({
  ring_id: 'r1',
  call_id: 'call',
  message_id: 'msg',
  workspace_id: 'w',
  channel_id: 'ch',
  channel_kind: 'dm',
  channel_name: null,
  member_id: 'ben',
  user_id: 'u-ben',
  caller_member_id: 'ana',
  caller_name: 'Ana Ruiz',
  ...over,
})

let tables: Record<string, Array<Record<string, unknown>>>
let db: SupabaseClient
let sent: Array<{ name: string; data: unknown }>
const send = async (events: Array<{ name: string; data: unknown }>) => {
  sent.push(...events)
}

beforeEach(() => {
  tables = { notification: [], team_call_ring: [{ id: 'r1', notified_at: null }] }
  db = memoryDb(tables, { notification: (a, b) => a.type === b.type && a.recipient_id === b.recipient_id && a.target_id === b.target_id })
  sent = []
})

describe('notifyMissedCalls', () => {
  it('a DM’s missed call: the call message’s notification, titled for it, and the away email asked for', async () => {
    expect(await notifyMissedCalls(db, [ring()], send)).toBe(1)
    expect(tables.notification).toHaveLength(1)
    expect(tables.notification[0]).toMatchObject({
      workspace_id: 'w',
      recipient_id: 'ben',
      type: 'team_chat_message',
      title: 'Missed call from Ana Ruiz',
      actor_id: 'ana',
      target_type: 'team_chat_message',
      target_id: 'msg',
      context_type: 'team_chat_channel',
      context_id: 'ch',
      group_key: 'team_chat:ch',
      metadata: expect.objectContaining({ reason: 'missed_call', call_id: 'call', author_name: 'Ana Ruiz', place: null }),
    })
    expect(sent).toEqual([{ name: 'team-chat/email.requested', data: { key: 'u-ben', userId: 'u-ben', workspaceId: 'w' } }])
  })

  it('once per ring: told again (a retried step, a second event, the sweeper\u2019s backlog), nobody is told twice', async () => {
    expect(await notifyMissedCalls(db, [ring()], send)).toBe(1)
    expect(tables.team_call_ring[0].notified_at).toBeTruthy()
    expect(await notifyMissedCalls(db, [ring()], send)).toBe(0)
    expect(await notifyMissedCalls(db, [ring(), ring()], send)).toBe(0)
    expect(tables.notification).toHaveLength(1)
    expect(sent).toHaveLength(1)
  })

  it('a channel’s: says where', async () => {
    await notifyMissedCalls(db, [ring({ channel_kind: 'channel', channel_name: 'launch' })], send)
    expect(tables.notification[0].title).toBe('Missed call from Ana Ruiz in #launch')
    expect((tables.notification[0].metadata as { place: string }).place).toBe('#launch')
  })

  it('one they had for the call’s message already becomes the missed call, unread again', async () => {
    tables.notification.push({ id: 'n1', type: 'team_chat_message', recipient_id: 'ben', target_id: 'msg', title: 'Ana Ruiz in #launch', is_read: true, read_at: '2026-11-11T10:00:00Z' })
    expect(await notifyMissedCalls(db, [ring({ channel_kind: 'channel', channel_name: 'launch' })], send)).toBe(1)
    expect(tables.notification).toHaveLength(1)
    expect(tables.notification[0]).toMatchObject({ id: 'n1', title: 'Missed call from Ana Ruiz in #launch', is_read: false, read_at: null })
  })

  it('a ring of a call with no message tells nobody', async () => {
    expect(await notifyMissedCalls(db, [ring({ message_id: null })], send)).toBe(0)
    expect(tables.notification).toEqual([])
    expect(sent).toEqual([])
  })
})

describe('the words', () => {
  it('a ring’s timer event carries ids only, deduped by the ring', () => {
    expect(teamCallRingEvent({ ringId: 'r1', expiresAt: '2026-11-11T10:00:40Z' })).toEqual({
      name: 'team-calls/ring.started',
      id: 'team-call-ring-r1',
      data: { ringId: 'r1', expiresAt: '2026-11-11T10:00:40Z' },
    })
  })

  it('a missed call’s title', () => {
    expect(missedCallTitle(ring({ caller_name: '  ' }))).toBe('Missed call from a teammate')
  })

  it('the incoming card’s line', () => {
    expect(teamCallRingLine({ caller_name: 'Ana Ruiz', channel_kind: 'dm', channel_name: null })).toBe('Ana Ruiz is calling')
    expect(teamCallRingLine({ caller_name: 'Ana Ruiz', channel_kind: 'channel', channel_name: 'launch' })).toBe('Ana Ruiz is calling you in #launch')
  })

  it('rooms are the calls’ own, and nothing else is', () => {
    const id = '77777777-7777-4777-8777-777777777777'
    expect(teamCallIdOfRoom(teamCallRoom(id))).toBe(id)
    expect(teamCallIdOfRoom('tc-not-a-uuid')).toBeNull()
    expect(teamCallIdOfRoom('phase4-room')).toBeNull()
    expect(teamCallIdOfRoom(null)).toBeNull()
  })

  it('durations and the ended line, the same cases as the database’s', () => {
    expect(teamCallDuration(45)).toBe('under a minute')
    expect(teamCallDuration(754)).toBe('12 min')
    expect(teamCallDuration(3900)).toBe('1 h 5 min')
    expect(teamCallDuration(7200)).toBe('2 h')
    const cases: Array<[Parameters<typeof teamCallSummary>, string]> = [
      [['dm', 30, 1], 'Missed call'],
      [['channel', 0, 0], 'Call ended'],
      [['channel', 754, 3], 'Call ended · 12 min · 3 people'],
      [['dm', 3900, 2], 'Call ended · 1 h 5 min · 2 people'],
      [['channel', 45, 1], 'Call ended · under a minute · 1 person'],
      [['channel', 7200, 4], 'Call ended · 2 h · 4 people'],
    ]
    const probes = readFileSync(join(process.cwd(), 'supabase/tests/564_team_calls.sql'), 'utf8')
    for (const [args, words] of cases) {
      expect(teamCallSummary(...args)).toBe(words)
      // The DB probe checks the SQL against the very same words.
      expect(probes).toContain(`'${words}', public.team_call_summary('${args[0]}', ${args[1]}, ${args[2]})`)
    }
  })
})
