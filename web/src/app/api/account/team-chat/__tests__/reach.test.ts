/**
 * Team chat's phase 2 routes (migration 560): reading a channel or a thread
 * reads its notifications (560's functions do it, as the person; an email
 * waiting leaves it out), with no event per read; a channel's level is
 * set through team_chat_set_notify; one message opens where it is (its
 * channel, its thread's root), never another workspace's or a deleted one;
 * and the page around an older message loads instead of giving up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '99999999-9999-4999-8999-999999999999'
const USER = '22222222-2222-4222-8222-222222222222'
const ANA = '33333333-3333-4333-8333-333333333333'
const CH = '55555555-5555-4555-8555-555555555555'
const FAR = '66666666-6666-4666-8666-666666666666'
const ROOT = '77777777-7777-4777-8777-777777777777'
const REPLY = '88888888-8888-4888-8888-888888888888'
const ELSEWHERE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  db: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  rpcAnswer: { data: null as unknown, error: null as unknown },
  events: [] as Array<{ name: string; data: unknown }>,
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({ supabase: h.db, user: { id: USER, user_metadata: {} }, workspaceId: WS, member: { id: ANA } }),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.db }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: async (event: { name: string; data: unknown }) => {
      h.events.push({ name: event.name, data: event.data })
      return { ids: [] }
    },
  },
}))

import { POST as readChannel } from '../channels/[id]/read/route'
import { POST as readThread } from '../threads/[id]/read/route'
import { POST as setNotify } from '../channels/[id]/notify/route'
import { GET as getMessage } from '../messages/[id]/route'
import { GET as getMessages } from '../channels/[id]/messages/route'

let tables: Record<string, Array<Record<string, unknown>>>
beforeEach(() => {
  tables = {
    team_chat_channel: [
      { id: CH, workspace_id: WS, kind: 'channel', name: 'launch', archived_at: null },
      { id: FAR, workspace_id: OTHER_WS, kind: 'channel', name: 'far', archived_at: null },
    ],
    team_chat_message: [
      { id: ROOT, channel_id: CH, workspace_id: WS, author_kind: 'member', author_member_id: ANA, thread_root_id: null, body: 'root', created_at: '2026-11-10T10:00:00Z', deleted_at: null, attachments: [] },
      { id: REPLY, channel_id: CH, workspace_id: WS, author_kind: 'member', author_member_id: ANA, thread_root_id: ROOT, body: 'reply', created_at: '2026-11-10T10:05:00Z', deleted_at: null, attachments: [] },
      { id: ELSEWHERE, channel_id: FAR, workspace_id: OTHER_WS, author_kind: 'member', author_member_id: ANA, thread_root_id: null, body: 'far', created_at: '2026-11-10T10:00:00Z', deleted_at: null, attachments: [] },
    ],
    notification: [
      { id: 'n1', recipient_id: ANA, type: 'team_chat_message', target_id: ROOT, group_key: `team_chat:${CH}`, is_read: false },
      { id: 'n2', recipient_id: 'someone-else', type: 'team_chat_message', target_id: REPLY, group_key: `team_chat_thread:${ROOT}`, is_read: false },
    ],
  }
  const db = memoryDb(tables)
  h.db = Object.assign(db, {
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcs.push([name, args])
      return h.rpcAnswer
    },
  }) as unknown as SupabaseClient
  h.afters = []
  h.rpcs = []
  h.rpcAnswer = { data: null, error: null }
  h.events = []
})

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (url: string, body?: unknown) =>
  new NextRequest(new URL(url, 'http://localhost'), { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
async function runAfters() {
  for (const task of h.afters.splice(0)) await task()
}

describe('read clears', () => {
  it('reading a channel or a thread goes through 560’s functions, which read its notifications too (an email waiting leaves it out: email.test.ts)', async () => {
    expect((await readChannel(post(`/api/account/team-chat/channels/${CH}/read`), params(CH))).status).toBe(200)
    expect((await readThread(post(`/api/account/team-chat/threads/${ROOT}/read`), params(ROOT))).status).toBe(200)
    expect(h.rpcs).toEqual([
      ['team_chat_mark_read', { ch: CH }],
      ['team_chat_mark_thread_read', { root: ROOT }],
    ])
    // A read mark is not an event: nothing is sent per read.
    await runAfters()
    expect(h.events).toEqual([])
  })

  it('a channel they may not read is refused', async () => {
    h.rpcAnswer = { data: null, error: { code: '42501', message: 'no such channel' } }
    expect((await readChannel(post(`/api/account/team-chat/channels/${CH}/read`), params(CH))).status).toBe(403)
  })
})

describe('a channel’s level', () => {
  it('all, mentions or muted through team_chat_set_notify; null is the default; anything else is refused before the database', async () => {
    h.rpcAnswer = { data: 'muted', error: null }
    const res = await setNotify(post(`/api/account/team-chat/channels/${CH}/notify`, { level: 'muted' }), params(CH))
    expect(await res.json()).toEqual({ notify: 'muted' })
    expect(h.rpcs).toEqual([['team_chat_set_notify', { ch: CH, level: 'muted' }]])
    h.rpcAnswer = { data: 'mentions', error: null }
    expect(await (await setNotify(post(`/api/account/team-chat/channels/${CH}/notify`, { level: null }), params(CH))).json()).toEqual({ notify: 'mentions' })
    expect((await setNotify(post(`/api/account/team-chat/channels/${CH}/notify`, { level: 'loud' }), params(CH))).status).toBe(400)
    expect((await setNotify(post('/x', { level: 'all' }), params('nope'))).status).toBe(404)
    expect(h.rpcs).toHaveLength(2)
  })

  it('a channel they may not read is a 403', async () => {
    h.rpcAnswer = { data: null, error: { code: '42501', message: 'no such channel' } }
    expect((await setNotify(post(`/api/account/team-chat/channels/${CH}/notify`, { level: 'all' }), params(CH))).status).toBe(403)
  })
})

describe('one message, where it is', () => {
  const get = (id: string) => getMessage(new NextRequest(new URL(`/api/account/team-chat/messages/${id}`, 'http://localhost')), params(id))

  it('a reply comes with its thread’s root; a channel message with none', async () => {
    const reply = await (await get(REPLY)).json()
    expect(reply.message).toMatchObject({ id: REPLY, channel_id: CH, thread_root_id: ROOT })
    expect(reply.root).toMatchObject({ id: ROOT })
    expect((await (await get(ROOT)).json()).root).toBeNull()
  })

  it('another workspace’s message, a deleted one, or none is a 404', async () => {
    expect((await get(ELSEWHERE)).status).toBe(404)
    tables.team_chat_message[0].deleted_at = '2026-11-11T00:00:00Z'
    expect((await get(ROOT)).status).toBe(404)
    expect((await get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).status).toBe(404)
  })

  it('the page around an older message: a few before it, on to the newest when that fits, else that page alone (hasNewer)', async () => {
    // Root-level messages of the channel, a minute apart.
    tables.team_chat_message = []
    for (let i = 0; i < 260; i++) {
      tables.team_chat_message.push({ id: `c0000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, channel_id: CH, workspace_id: WS, author_kind: 'member', author_member_id: ANA, thread_root_id: null, body: `m${i}`, created_at: new Date(Date.UTC(2026, 10, 10, 0, i)).toISOString(), deleted_at: null, attachments: [] })
    }
    const idOf = (i: number) => `c0000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
    const around = async (i: number) =>
      (await getMessages(new NextRequest(new URL(`/api/account/team-chat/channels/${CH}/messages?around=${idOf(i)}`, 'http://localhost')), params(CH))).json()
    // An old one: 25 before it, 200 from it, more after (shown alone, with a way to the newest).
    const old = await around(10)
    expect(old.messages[0].body).toBe('m0')
    expect(old.messages.map((m: { body: string }) => m.body)).toContain('m10')
    expect(old.messages).toHaveLength(10 + 200)
    expect(old).toMatchObject({ hasOlder: false, hasNewer: true })
    // A recent one: on to the newest, unbroken (merged with the newest page).
    const recent = await around(200)
    expect(recent.messages[0].body).toBe('m175')
    expect(recent.messages.at(-1).body).toBe('m259')
    expect(recent).toMatchObject({ hasOlder: true, hasNewer: false })
  })

  it('around a message that isn’t one of the channel’s own (another channel’s, a thread’s reply) is a 404; a bad id a 400', async () => {
    const at = (q: string) => getMessages(new NextRequest(new URL(`/api/account/team-chat/channels/${CH}/messages?around=${q}`, 'http://localhost')), params(CH))
    expect((await at(REPLY)).status).toBe(404)
    expect((await at(ELSEWHERE)).status).toBe(404)
    expect((await at('nope')).status).toBe(400)
  })
})
