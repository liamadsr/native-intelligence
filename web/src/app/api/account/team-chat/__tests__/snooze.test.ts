/**
 * Muting a channel for a while (migration 702): the route checks the time and
 * hands it to team_chat_snooze as the person; the channel list carries a
 * running snooze and drops a finished one, and still lists channels before
 * 702 (no muted_until column).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ANA = '33333333-3333-4333-8333-333333333333'
const CH = '55555555-5555-4555-8555-555555555555'
const CH2 = '66666666-6666-4666-8666-666666666666'

const h = vi.hoisted(() => ({
  db: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  rpcAnswer: { data: null as unknown, error: null as unknown },
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({ supabase: h.db, user: { id: USER, user_metadata: {} }, workspaceId: WS, member: { id: ANA } }),
}))

import { POST as snooze } from '../channels/[id]/snooze/route'
import { listChannels } from '@/lib/team-chat/store'

const inHour = () => new Date(Date.now() + 3_600_000).toISOString()
let tables: Record<string, Array<Record<string, unknown>>>
beforeEach(() => {
  tables = {
    team_chat_channel: [
      { id: CH, workspace_id: WS, kind: 'channel', name: 'launch', topic: null, team_id: null, dm_key: null, last_message_at: '2026-11-10T10:00:00Z', archived_at: null, created_at: '2026-11-01T00:00:00Z' },
      { id: CH2, workspace_id: WS, kind: 'channel', name: 'random', topic: null, team_id: null, dm_key: null, last_message_at: '2026-11-09T10:00:00Z', archived_at: null, created_at: '2026-11-01T00:00:00Z' },
    ],
    team_chat_member: [
      { channel_id: CH, member_id: ANA, workspace_id: WS, notify_level: 'all', muted_until: inHour() },
      { channel_id: CH2, member_id: ANA, workspace_id: WS, notify_level: null, muted_until: '2026-01-01T00:00:00Z' },
    ],
  }
  h.db = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcs.push([name, args])
      if (name === 'team_chat_unread' || name === 'team_chat_thread_unread') return { data: [], error: null }
      return h.rpcAnswer
    },
  }) as unknown as SupabaseClient
  h.rpcs = []
  h.rpcAnswer = { data: null, error: null }
})

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (body: unknown, id = CH) =>
  snooze(new NextRequest(new URL(`/api/account/team-chat/channels/${id}/snooze`, 'http://localhost'), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), params(id))

describe('POST snooze', () => {
  it('a future time goes to team_chat_snooze as the person and comes back', async () => {
    const until = inHour()
    h.rpcAnswer = { data: until, error: null }
    const res = await post({ until })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ muted_until: until })
    expect(h.rpcs).toEqual([['team_chat_snooze', { ch: CH, until: new Date(until).toISOString() }]])
  })

  it('null ends it', async () => {
    const res = await post({ until: null })
    expect(await res.json()).toEqual({ muted_until: null })
    expect(h.rpcs).toEqual([['team_chat_snooze', { ch: CH, until: null }]])
  })

  it('the past, too far, junk and a bad id are refused before the database', async () => {
    expect((await post({ until: new Date(Date.now() - 1000).toISOString() })).status).toBe(400)
    expect((await post({ until: new Date(Date.now() + 40 * 86_400_000).toISOString() })).status).toBe(400)
    expect((await post({ until: 'later' })).status).toBe(400)
    expect((await post({ until: inHour() }, 'nope')).status).toBe(404)
    expect(h.rpcs).toEqual([])
  })

  it('a channel they may not read is a 403', async () => {
    h.rpcAnswer = { data: null, error: { code: '42501', message: 'no such channel' } }
    expect((await post({ until: inHour() })).status).toBe(403)
  })
})

describe('listChannels and a snooze', () => {
  it('carries a running snooze, drops a finished one, keeps the level', async () => {
    const { channels } = await listChannels(h.db, { workspaceId: WS, memberId: ANA })
    const launch = channels.find((c) => c.id === CH)!
    const random = channels.find((c) => c.id === CH2)!
    expect(launch.notify).toBe('all')
    expect(launch.muted_until).toBe(tables.team_chat_member[0].muted_until)
    expect(random.muted_until).toBeNull()
    expect(random.notify).toBe('mentions')
  })

  it('before 702 (no muted_until) it reads without it', async () => {
    for (const row of tables.team_chat_member) delete row.muted_until
    const base = h.db as unknown as { from: (t: string) => unknown }
    const from = base.from.bind(base)
    h.db = Object.assign(Object.create(h.db as object), {
      from: (t: string) => {
        const q = from(t) as { select: (c: string) => unknown }
        if (t !== 'team_chat_member') return q
        return {
          ...q,
          select: (cols: string) =>
            cols.includes('muted_until')
              ? { eq: () => ({ eq: async () => ({ data: null, error: { code: '42703', message: 'column team_chat_member.muted_until does not exist' } }) }) }
              : q.select(cols),
        }
      },
    }) as SupabaseClient
    const { channels } = await listChannels(h.db, { workspaceId: WS, memberId: ANA })
    expect(channels.find((c) => c.id === CH)!.notify).toBe('all')
    expect(channels.every((c) => c.muted_until === null)).toBe(true)
  })
})
