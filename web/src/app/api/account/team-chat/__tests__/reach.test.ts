/**
 * Team chat's phase 2 routes (migration 560): reading a channel or a thread
 * reads its notifications (560's functions do it, as the person) and cancels
 * a waiting email only when there was something unread; a channel's level is
 * set through team_chat_set_notify; one message opens where it is (its
 * channel, its thread's root), never another workspace's or a deleted one;
 * a deleted message's notifications go with it.
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
import { GET as getMessage, DELETE as deleteMessage } from '../messages/[id]/route'

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
  it('reading a channel marks it (and, in the database, its notifications) read, and cancels its waiting email', async () => {
    const res = await readChannel(post(`/api/account/team-chat/channels/${CH}/read`), params(CH))
    expect(res.status).toBe(200)
    expect(h.rpcs).toEqual([['team_chat_mark_read', { ch: CH }]])
    await runAfters()
    expect(h.events).toEqual([{ name: 'team-chat/read', data: { key: `${USER}:team_chat:${CH}` } }])
  })

  it('nothing unread there: no cancel sent (a read mark is not an event)', async () => {
    tables.notification[0].is_read = true
    await readChannel(post(`/api/account/team-chat/channels/${CH}/read`), params(CH))
    await runAfters()
    expect(h.rpcs).toHaveLength(1)
    expect(h.events).toEqual([])
  })

  it('reading a thread marks it read and cancels the thread’s email only when the person had one waiting', async () => {
    await readThread(post(`/api/account/team-chat/threads/${ROOT}/read`), params(ROOT))
    await runAfters()
    expect(h.rpcs).toEqual([['team_chat_mark_thread_read', { root: ROOT }]])
    // The thread's notification is someone else's: nothing of the person's to cancel.
    expect(h.events).toEqual([])
    tables.notification.push({ id: 'n3', recipient_id: ANA, type: 'team_chat_message', target_id: REPLY, group_key: `team_chat_thread:${ROOT}`, is_read: false })
    await readThread(post(`/api/account/team-chat/threads/${ROOT}/read`), params(ROOT))
    await runAfters()
    expect(h.events).toEqual([{ name: 'team-chat/read', data: { key: `${USER}:team_chat_thread:${ROOT}` } }])
  })

  it('a channel they may not read is refused, and nothing is cancelled', async () => {
    h.rpcAnswer = { data: null, error: { code: '42501', message: 'no such channel' } }
    expect((await readChannel(post(`/api/account/team-chat/channels/${CH}/read`), params(CH))).status).toBe(403)
    await runAfters()
    expect(h.events).toEqual([])
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

  it('a deleted message’s notifications go with it, everyone’s', async () => {
    const res = await deleteMessage(new NextRequest(new URL(`/api/account/team-chat/messages/${REPLY}`, 'http://localhost'), { method: 'DELETE' }), params(REPLY))
    expect(res.status).toBe(200)
    await runAfters()
    expect(tables.notification.map((n) => n.id)).toEqual(['n1'])
  })
})
