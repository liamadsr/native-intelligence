/**
 * Team chat's routes (roadmap #7): everything runs as the person, under RLS
 * (a channel RLS hides is a 404, never a leak); mentions keep only workspace
 * members; @-mentioning the person's own agent (by the flag or by its name)
 * queues its turn after the answer, and a plain message never does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ANA = '33333333-3333-4333-8333-333333333333'
const BEN = '44444444-4444-4444-8444-444444444444'
const STRANGER = '88888888-8888-4888-8888-888888888888'
const CH = '55555555-5555-4555-8555-555555555555'
const HIDDEN = '66666666-6666-4666-8666-666666666666'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  db: null as unknown as SupabaseClient,
  meta: {} as Record<string, unknown>,
  delivered: [] as Array<Record<string, unknown>>,
  notified: [] as string[],
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({
    supabase: h.db,
    user: { id: USER, user_metadata: h.meta },
    workspaceId: WS,
    member: { id: ANA },
  }),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.db }))
vi.mock('@/lib/team-chat/notify', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-chat/notify')>()),
  // Every message asks for its notifications, last of what runs after the answer (migration 560).
  requestTeamChatNotify: async (id: string) => {
    h.notified.push(id)
  },
}))
vi.mock('@/lib/team-chat/agent-turn', () => ({
  deliverTeamChatMention: async (_svc: unknown, input: Record<string, unknown>) => {
    h.delivered.push(input)
    return 'queued'
  },
}))

import { POST as postMessage, GET as getMessages } from '../channels/[id]/messages/route'
import { POST as createChannel } from '../channels/route'
import { PATCH as editMessage, DELETE as deleteMessage } from '../messages/[id]/route'

type Row = Record<string, unknown>

/**
 * The person's RLS view of the database: the channel they may read is there,
 * the hidden one is not (RLS filters it out before the route sees it).
 */
function seed(): Record<string, Row[]> {
  return {
    team_chat_channel: [{ id: CH, workspace_id: WS, kind: 'channel', name: 'launch', topic: null, team_id: null, dm_key: null, last_message_at: null, archived_at: null, created_at: '2026-11-08T00:00:00Z' }],
    team_chat_message: [],
    member: [
      { id: ANA, workspace_id: WS, display_name: 'Ana Ruiz' },
      { id: BEN, workspace_id: WS, display_name: 'Ben Ortiz' },
    ],
  }
}

function req(url: string, body?: unknown, method = 'POST') {
  return new NextRequest(new URL(url, 'http://localhost'), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })

let tables: Record<string, Row[]>
beforeEach(() => {
  tables = seed()
  h.db = memoryDb(tables)
  h.afters = []
  h.meta = { assistant_name: 'Juniper' }
  h.delivered = []
  h.notified = []
})

describe('posting', () => {
  it('posts as the person, keeps only workspace members as mentions, and calls no agent for a plain message', async () => {
    const res = await postMessage(req(`/api/account/team-chat/channels/${CH}/messages`, { body: ' Ready for @Ben Ortiz? ', mentions: [BEN, STRANGER, 'nope'] }), params(CH))
    expect(res.status).toBe(201)
    const { message } = await res.json()
    expect(message).toMatchObject({ channel_id: CH, workspace_id: WS, author_kind: 'member', author_member_id: ANA, body: 'Ready for @Ben Ortiz?', mentions: [BEN], mentions_agent: false })
    // Only its notifications, after the answer.
    expect(h.afters).toHaveLength(1)
    await h.afters[0]()
    expect(h.notified).toEqual([message.id])
    expect(h.delivered).toHaveLength(0)
  })

  it('a channel RLS hides (not a member, another team, someone else’s DM) is a 404, and nothing is written', async () => {
    const res = await postMessage(req(`/api/account/team-chat/channels/${HIDDEN}/messages`, { body: 'hi' }), params(HIDDEN))
    expect(res.status).toBe(404)
    expect(tables.team_chat_message).toHaveLength(0)
    expect((await getMessages(req(`/api/account/team-chat/channels/${HIDDEN}/messages`, undefined, 'GET'), params(HIDDEN))).status).toBe(404)
  })

  it('@-mentioning their agent by name queues its turn after the answer', async () => {
    const res = await postMessage(req(`/api/account/team-chat/channels/${CH}/messages`, { body: '@juniper when is launch?' }), params(CH))
    const { message } = await res.json()
    expect(message.mentions_agent).toBe(true)
    expect(h.delivered).toHaveLength(0)
    // The agent's turn, then the notifications.
    expect(h.afters).toHaveLength(2)
    await h.afters[0]()
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toMatchObject({ userId: USER, message: { id: message.id }, channel: { id: CH, workspace_id: WS, kind: 'channel' }, dmWith: null })
  })

  it('the flag works too, and the default name when they never named their agent', async () => {
    h.meta = {}
    const flagged = await (await postMessage(req(`/api/account/team-chat/channels/${CH}/messages`, { body: 'thoughts?', mentionsAgent: true }), params(CH))).json()
    expect(flagged.message.mentions_agent).toBe(true)
    const byDefault = await (await postMessage(req(`/api/account/team-chat/channels/${CH}/messages`, { body: '@Joseph thoughts?' }), params(CH))).json()
    expect(byDefault.message.mentions_agent).toBe(true)
    // Another member's agent's name is not theirs to call.
    const other = await (await postMessage(req(`/api/account/team-chat/channels/${CH}/messages`, { body: '@Juniper thoughts?' }), params(CH))).json()
    expect(other.message.mentions_agent).toBe(false)
  })

  it('picking a teammate whose name starts with the agent’s never calls the agent', async () => {
    h.meta = {}
    tables.member.push({ id: STRANGER, workspace_id: WS, display_name: 'Joseph Lee' })
    const res = await (await postMessage(req(`/api/account/team-chat/channels/${CH}/messages`, { body: '@Joseph Lee can you check the quote?', mentions: [STRANGER] }), params(CH))).json()
    expect(res.message).toMatchObject({ mentions: [STRANGER], mentions_agent: false })
    expect(h.afters).toHaveLength(1)
    for (const task of h.afters) await task()
    expect(h.delivered).toHaveLength(0)
    expect(h.notified).toEqual([res.message.id])
  })

  it('refuses an empty or oversized message and a bad id', async () => {
    expect((await postMessage(req(`/api/account/team-chat/channels/${CH}/messages`, { body: '  ' }), params(CH))).status).toBe(400)
    expect((await postMessage(req(`/api/account/team-chat/channels/${CH}/messages`, { body: 'x'.repeat(8001) }), params(CH))).status).toBe(400)
    expect((await postMessage(req('/api/account/team-chat/channels/nope/messages', { body: 'hi' }), params('nope'))).status).toBe(404)
  })
})

describe('editing and deleting', () => {
  it('a message RLS lets them change (their own) is edited; one it doesn’t is a 404', async () => {
    tables.team_chat_message.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel_id: CH, workspace_id: WS, author_kind: 'member', author_member_id: ANA, body: 'old', mentions: [] })
    const ok = await editMessage(req('/api/account/team-chat/messages/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { body: 'new @Ben Ortiz', mentions: [BEN] }, 'PATCH'), params('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
    expect(ok.status).toBe(200)
    expect(tables.team_chat_message[0]).toMatchObject({ body: 'new @Ben Ortiz', mentions: [BEN] })
    const missing = await editMessage(req('/api/account/team-chat/messages/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { body: 'x' }, 'PATCH'), params('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
    expect(missing.status).toBe(404)
    expect((await deleteMessage(req('/api/account/team-chat/messages/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', undefined, 'DELETE'), params('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))).status).toBe(404)
    expect((await deleteMessage(req('/api/account/team-chat/messages/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', undefined, 'DELETE'), params('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))).status).toBe(200)
  })
})

describe('channels', () => {
  it('creates through the function as the person; a taken name is a 409; a bad name a 400', async () => {
    const calls: Array<[string, unknown]> = []
    const answers: Array<{ data: unknown; error: unknown }> = [
      { data: CH, error: null },
      { data: null, error: { code: '23505', message: 'duplicate' } },
    ]
    h.db = Object.assign(memoryDb(tables), {
      rpc: async (name: string, args: unknown) => {
        calls.push([name, args])
        return answers.shift()
      },
    }) as unknown as SupabaseClient
    const made = await createChannel(req('/api/account/team-chat/channels', { name: '#Launch ', topic: 'Ship it' }))
    expect(made.status).toBe(201)
    expect(await made.json()).toEqual({ id: CH })
    expect(calls[0]).toEqual(['team_chat_create_channel', { ws: WS, channel_name: 'Launch', channel_team: null, channel_topic: 'Ship it' }])
    expect((await createChannel(req('/api/account/team-chat/channels', { name: 'launch' }))).status).toBe(409)
    expect((await createChannel(req('/api/account/team-chat/channels', { name: '  ' }))).status).toBe(400)
    expect((await createChannel(req('/api/account/team-chat/channels', { name: 'x', teamId: 'nope' }))).status).toBe(400)
  })
})
