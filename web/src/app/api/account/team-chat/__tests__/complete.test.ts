/**
 * Team chat's routes for migrations 555-559, as the person under RLS: a reply
 * in a thread and the thread's read; a channel's page without its threads'
 * replies, with their summaries and reactions; a retried send (the same
 * client id) answering with the row the first made, nothing run twice; files
 * only the person's own in the channel's folder, their size storage's, never
 * the client's; reactions one emoji through team_chat_react; a link's preview
 * asked for after the answer; a delete takes the person's files with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ANA = '33333333-3333-4333-8333-333333333333'
const BEN = '44444444-4444-4444-8444-444444444444'
const CH = '55555555-5555-4555-8555-555555555555'
const OTHER_CH = '66666666-6666-4666-8666-666666666666'
const ROOT = '77777777-7777-4777-8777-777777777777'
const REPLY = '88888888-8888-4888-8888-888888888888'
const SEND = '99999999-9999-4999-8999-999999999999'
const FILE = 'f0000000-0000-4000-8000-000000000001'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  db: null as unknown as SupabaseClient,
  delivered: [] as Array<Record<string, unknown>>,
  previews: [] as string[],
  rpcs: [] as Array<[string, unknown]>,
  rpcAnswer: { data: true as unknown, error: null as unknown },
  objects: new Map<string, number>(),
  removed: [] as string[][],
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({ supabase: h.db, user: { id: USER, user_metadata: { assistant_name: 'Juniper' } }, workspaceId: WS, member: { id: ANA } }),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.db }))
vi.mock('@/lib/team-chat/agent-turn', () => ({
  deliverTeamChatMention: async (_svc: unknown, input: Record<string, unknown>) => {
    h.delivered.push(input)
    return 'queued'
  },
}))
vi.mock('@/lib/team-chat/link-preview', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-chat/link-preview')>()),
  requestLinkPreview: async (message: { id: string }) => {
    h.previews.push(message.id)
    return true
  },
}))

import { GET as getMessages, POST as postMessage } from '../channels/[id]/messages/route'
import { DELETE as deleteMessage } from '../messages/[id]/route'
import { POST as react } from '../messages/[id]/reactions/route'
import { POST as readThread } from '../threads/[id]/read/route'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

function client(): SupabaseClient {
  // One row per author and client id, as 555's unique index has it.
  const db = memoryDb(tables, {
    team_chat_message: (a, b) => !!a.client_id && a.client_id === b.client_id && a.author_member_id === b.author_member_id,
  })
  return Object.assign(db, {
    rpc: async (name: string, args: unknown) => {
      h.rpcs.push([name, args])
      return h.rpcAnswer
    },
    storage: {
      from: () => ({
        list: async (folder: string, opts: { search: string }) => {
          const size = h.objects.get(`${folder}/${opts.search}`)
          return { data: size === undefined ? [] : [{ name: opts.search, metadata: { size, mimetype: 'application/pdf' } }], error: null }
        },
        remove: async (paths: string[]) => {
          h.removed.push(paths)
          return { data: [], error: null }
        },
      }),
    },
  }) as unknown as SupabaseClient
}

const message = (over: Row): Row => ({
  channel_id: CH,
  workspace_id: WS,
  author_kind: 'member',
  author_member_id: BEN,
  thread_root_id: null,
  client_id: null,
  body: 'x',
  mentions: [],
  attachments: [],
  link_preview: null,
  created_at: '2026-11-09T10:00:00Z',
  deleted_at: null,
  ...over,
})

beforeEach(() => {
  tables = {
    team_chat_channel: [
      { id: CH, workspace_id: WS, kind: 'channel', name: 'launch', team_id: null, dm_key: null, archived_at: null, created_at: '2026-11-08T00:00:00Z' },
      { id: OTHER_CH, workspace_id: WS, kind: 'channel', name: 'other', team_id: null, dm_key: null, archived_at: null, created_at: '2026-11-08T00:00:00Z' },
    ],
    team_chat_message: [
      message({ id: ROOT, body: 'Ship Friday?' }),
      message({ id: REPLY, thread_root_id: ROOT, body: 'Yes', created_at: '2026-11-09T10:05:00Z' }),
    ],
    team_chat_thread: [{ root_id: ROOT, channel_id: CH, reply_count: 1, last_reply_at: '2026-11-09T10:05:00Z', participant_ids: [BEN] }],
    team_chat_reaction: [
      { message_id: ROOT, member_id: BEN, emoji: '👍', active: true, created_at: '2026-11-09T10:01:00Z' },
      { message_id: ROOT, member_id: ANA, emoji: '👀', active: false, created_at: '2026-11-09T10:02:00Z' },
      { message_id: REPLY, member_id: ANA, emoji: '🎉', active: true, created_at: '2026-11-09T10:06:00Z' },
    ],
    member: [
      { id: ANA, workspace_id: WS, display_name: 'Ana Ruiz' },
      { id: BEN, workspace_id: WS, display_name: 'Ben Ortiz' },
    ],
  }
  h.db = client()
  h.afters = []
  h.delivered = []
  h.previews = []
  h.rpcs = []
  h.rpcAnswer = { data: true, error: null }
  h.objects = new Map()
  h.removed = []
})

function req(url: string, body?: unknown, method = 'POST') {
  return new NextRequest(new URL(url, 'http://localhost'), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (body: unknown) => postMessage(req(`/api/account/team-chat/channels/${CH}/messages`, body), params(CH))

describe('threads', () => {
  it('a channel’s page leaves its threads’ replies out, and brings the summaries and the reactions that are on', async () => {
    const res = await getMessages(req(`/api/account/team-chat/channels/${CH}/messages`, undefined, 'GET'), params(CH))
    const json = await res.json()
    expect(json.messages.map((m: Row) => m.id)).toEqual([ROOT])
    expect(json.threads).toEqual([{ root_id: ROOT, channel_id: CH, reply_count: 1, last_reply_at: '2026-11-09T10:05:00Z', participant_ids: [BEN] }])
    expect(json.reactions).toEqual([{ message_id: ROOT, member_id: BEN, emoji: '👍', active: true }])
  })

  it('a thread: its root, its replies and their reactions; a root of another channel, or a reply, is a 404', async () => {
    const json = await (await getMessages(req(`/api/account/team-chat/channels/${CH}/messages?thread=${ROOT}`, undefined, 'GET'), params(CH))).json()
    expect(json.root.id).toBe(ROOT)
    expect(json.messages.map((m: Row) => m.id)).toEqual([REPLY])
    expect(json.reactions.map((r: Row) => r.emoji)).toEqual(['👍', '🎉'])
    expect((await getMessages(req(`/api/account/team-chat/channels/${OTHER_CH}/messages?thread=${ROOT}`, undefined, 'GET'), params(OTHER_CH))).status).toBe(404)
    expect((await getMessages(req(`/api/account/team-chat/channels/${CH}/messages?thread=${REPLY}`, undefined, 'GET'), params(CH))).status).toBe(404)
    expect((await getMessages(req(`/api/account/team-chat/channels/${CH}/messages?thread=nope`, undefined, 'GET'), params(CH))).status).toBe(400)
  })

  it('a reply in a thread is posted under its root (the database files a reply to a reply under the root)', async () => {
    const res = await post({ body: 'On it', thread: ROOT })
    expect(res.status).toBe(201)
    expect((await res.json()).message).toMatchObject({ thread_root_id: ROOT, author_member_id: ANA, body: 'On it' })
    expect((await post({ body: 'x', thread: 'nope' })).status).toBe(400)
  })

  it('reading a thread goes through team_chat_mark_thread_read, as the person', async () => {
    expect((await readThread(req(`/api/account/team-chat/threads/${ROOT}/read`), params(ROOT))).status).toBe(200)
    expect(h.rpcs).toEqual([['team_chat_mark_thread_read', { root: ROOT }]])
    h.rpcAnswer = { data: null, error: { code: '42501', message: 'no such thread' } }
    expect((await readThread(req(`/api/account/team-chat/threads/${ROOT}/read`), params(ROOT))).status).toBe(403)
    expect((await readThread(req('/api/account/team-chat/threads/nope/read'), params('nope'))).status).toBe(404)
  })
})

describe('retry-safe sends', () => {
  it('the same client id twice: one row, the second answer is the first’s row (replayed), and the intake is asked for that same message (its turn’s id is the message’s: replay.test.ts)', async () => {
    const first = await post({ body: '@Juniper status?', clientId: SEND })
    expect(first.status).toBe(201)
    const sent = (await first.json()).message
    expect(sent.client_id).toBe(SEND)
    const again = await post({ body: '@Juniper status?', clientId: SEND })
    expect(again.status).toBe(200)
    const replay = await again.json()
    expect(replay).toMatchObject({ replayed: true, message: { id: sent.id } })
    expect(tables.team_chat_message.filter((m) => m.client_id === SEND)).toHaveLength(1)
    for (const task of h.afters) await task()
    expect(h.delivered.map((d) => (d.message as { id: string }).id)).toEqual([sent.id, sent.id])
    expect((await post({ body: 'x', clientId: 'nope' })).status).toBe(400)
  })
})

describe('files', () => {
  const own = `${CH}/${USER}/${FILE}.pdf`

  it('the person’s own upload in this channel’s folder rides with the message, its size storage’s; files alone are a message', async () => {
    h.objects.set(own, 2048)
    const res = await post({ body: '', attachments: [{ path: own, name: 'Quote.pdf', size: 1, type: 'text/html' }] })
    expect(res.status).toBe(201)
    expect((await res.json()).message.attachments).toEqual([{ path: own, name: 'Quote.pdf', size: 2048, type: 'application/pdf' }])
  })

  it('a path outside their folder, or a file storage doesn’t have, is refused and nothing is posted', async () => {
    const before = tables.team_chat_message.length
    expect((await post({ body: 'see', attachments: [{ path: `${CH}/${BEN}/${FILE}.pdf`, name: 'x.pdf' }] })).status).toBe(400)
    expect((await post({ body: 'see', attachments: [{ path: `${OTHER_CH}/${USER}/${FILE}.pdf`, name: 'x.pdf' }] })).status).toBe(400)
    expect((await post({ body: 'see', attachments: [{ path: own, name: 'x.pdf' }] })).status).toBe(400)
    h.objects.set(own, 20 * 1024 * 1024)
    expect((await post({ body: 'see', attachments: [{ path: own, name: 'x.pdf' }] })).status).toBe(400)
    expect(tables.team_chat_message).toHaveLength(before)
    expect((await post({ body: '' })).status).toBe(400)
  })

  it('a delete takes the person’s files with it', async () => {
    h.objects.set(own, 2048)
    const { message: sent } = await (await post({ body: 'here', attachments: [{ path: own, name: 'Quote.pdf' }] })).json()
    expect((await deleteMessage(req(`/api/account/team-chat/messages/${sent.id}`, undefined, 'DELETE'), params(sent.id))).status).toBe(200)
    expect(h.removed).toEqual([[own]])
  })
})

describe('reactions', () => {
  const url = `/api/account/team-chat/messages/${ROOT}/reactions`
  it('one emoji, turned on or off through team_chat_react', async () => {
    const res = await react(req(url, { emoji: '👍', on: true }), params(ROOT))
    expect(await res.json()).toEqual({ on: true })
    expect(h.rpcs).toEqual([['team_chat_react', { msg: ROOT, reaction: '👍', turn_on: true }]])
  })

  it('words, a missing state or a bad id are refused before the database; a message they can’t post beside is a 403', async () => {
    expect((await react(req(url, { emoji: 'lol', on: true }), params(ROOT))).status).toBe(400)
    expect((await react(req(url, { emoji: '👍' }), params(ROOT))).status).toBe(400)
    expect((await react(req('/x', { emoji: '👍', on: true }), params('nope'))).status).toBe(404)
    expect(h.rpcs).toHaveLength(0)
    h.rpcAnswer = { data: null, error: { code: '42501', message: 'no such message' } }
    expect((await react(req(url, { emoji: '👍', on: true }), params(ROOT))).status).toBe(403)
  })
})

describe('link previews', () => {
  it('a message with a link asks for its preview after the answer; one without asks nothing', async () => {
    await post({ body: 'no link here' })
    expect(h.afters).toHaveLength(0)
    const { message: sent } = await (await post({ body: 'read https://news.example.test/story' })).json()
    expect(h.afters).toHaveLength(1)
    await h.afters[0]()
    expect(h.previews).toEqual([sent.id])
  })
})
