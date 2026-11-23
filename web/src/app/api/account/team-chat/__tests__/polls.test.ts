/**
 * Channel polls' routes (migration 703): each checks what it's sent, then
 * calls 703's function as the person, which holds the rules (tested on a
 * local Postgres: docs/plans/channels-inbox.md). Here: the checks, the
 * calls, the answers, the notification and the refusals.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ANA = '33333333-3333-4333-8333-333333333333'
const CH = '55555555-5555-4555-8555-555555555555'
const MSG = '77777777-7777-4777-8777-777777777777'
const POLL = '88888888-8888-4888-8888-888888888888'
const OPT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OPT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CLIENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const h = vi.hoisted(() => ({
  db: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  answers: {} as Record<string, { data: unknown; error: unknown }>,
  afters: [] as Array<() => unknown>,
  events: [] as Array<{ name: string; data: unknown }>,
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => unknown) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({ supabase: h.db, user: { id: USER, user_metadata: {} }, workspaceId: WS, member: { id: ANA } }),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: async (e: { name: string; data: unknown }) => void h.events.push({ name: e.name, data: e.data }) },
}))

import { POST as createPollRoute } from '../channels/[id]/polls/route'
import { GET as readPollRoute } from '../polls/[id]/route'
import { POST as voteRoute } from '../polls/[id]/vote/route'
import { POST as closeRoute } from '../polls/[id]/close/route'

const pollJson = (over: Record<string, unknown> = {}) => ({
  id: POLL,
  channel_id: CH,
  message_id: MSG,
  question: 'Lunch?',
  multiple: false,
  anonymous: false,
  closes_at: null,
  closed_at: null,
  created_by: ANA,
  created_at: '2026-11-23T10:00:00Z',
  options: [
    { id: OPT_A, label: 'Tacos', position: 0, votes: 1, voter_ids: [ANA] },
    { id: OPT_B, label: 'Ramen', position: 1, votes: 0, voter_ids: [] },
  ],
  voters: 1,
  mine: [OPT_A],
  can_close: true,
  ...over,
})

beforeEach(() => {
  const tables = {
    team_chat_channel: [{ id: CH, workspace_id: WS, kind: 'channel', name: 'launch', archived_at: null }],
    team_chat_message: [{ id: MSG, channel_id: CH, workspace_id: WS, author_kind: 'member', author_member_id: ANA, body: 'Poll: Lunch?', thread_root_id: null, created_at: '2026-11-23T10:00:00Z', deleted_at: null, attachments: [], poll_id: POLL }],
  }
  h.db = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcs.push([name, args])
      return h.answers[name] ?? { data: null, error: null }
    },
  }) as unknown as SupabaseClient
  h.rpcs = []
  h.afters = []
  h.events = []
  h.answers = {
    team_chat_poll_create: { data: { message_id: MSG, poll_id: POLL }, error: null },
    team_chat_poll_read: { data: pollJson(), error: null },
    team_chat_poll_vote: { data: pollJson(), error: null },
    team_chat_poll_close: { data: pollJson({ closed_at: '2026-11-23T11:00:00Z' }), error: null },
  }
})

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (url: string, body?: unknown) =>
  new NextRequest(new URL(url, 'http://localhost'), { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })

describe('POST /channels/[id]/polls', () => {
  const good = { question: ' Lunch? ', options: ['Tacos', ' Ramen ', ''], multiple: false, anonymous: true, client_id: CLIENT }

  it('posts the checked poll through team_chat_poll_create, answers the message and the poll, and asks for its notifications', async () => {
    const res = await createPollRoute(post(`/api/account/team-chat/channels/${CH}/polls`, good), params(CH))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.message.id).toBe(MSG)
    expect(json.poll.id).toBe(POLL)
    expect(h.rpcs[0]).toEqual([
      'team_chat_poll_create',
      { ch: CH, question: 'Lunch?', options: ['Tacos', 'Ramen'], multiple: false, anonymous: true, closes_at: null, thread_root: null, client: CLIENT },
    ])
    for (const task of h.afters.splice(0)) await task()
    expect(h.events.map((e) => e.data)).toEqual([{ messageId: MSG }])
  })

  it('refuses a bad poll, a bad thread or client id, and an unknown channel before the database', async () => {
    const url = `/api/account/team-chat/channels/${CH}/polls`
    expect((await createPollRoute(post(url, { ...good, options: ['only one'] }), params(CH))).status).toBe(400)
    expect((await createPollRoute(post(url, { ...good, thread_root_id: 'x' }), params(CH))).status).toBe(400)
    expect((await createPollRoute(post(url, { ...good, client_id: 7 }), params(CH))).status).toBe(400)
    expect((await createPollRoute(post(url, good), params('nope'))).status).toBe(404)
    const elsewhere = '99999999-9999-4999-8999-999999999999'
    expect((await createPollRoute(post(`/api/account/team-chat/channels/${elsewhere}/polls`, good), params(elsewhere))).status).toBe(404)
    expect(h.rpcs).toEqual([])
  })

  it('a channel they may not post in is a 403', async () => {
    h.answers.team_chat_poll_create = { data: null, error: { code: '42501', message: 'team chat: no posting here' } }
    expect((await createPollRoute(post(`/api/account/team-chat/channels/${CH}/polls`, good), params(CH))).status).toBe(403)
  })
})

describe('GET /polls/[id]', () => {
  it('reads it as the person', async () => {
    const res = await readPollRoute(new NextRequest(new URL(`http://localhost/api/account/team-chat/polls/${POLL}`)), params(POLL))
    expect((await res.json()).poll).toMatchObject({ id: POLL, mine: [OPT_A], can_close: true })
    expect(h.rpcs).toEqual([['team_chat_poll_read', { poll: POLL }]])
  })
  it('one they may not read, or none, is a 404', async () => {
    h.answers.team_chat_poll_read = { data: null, error: { code: '42501', message: 'no' } }
    expect((await readPollRoute(new NextRequest(new URL('http://localhost/x')), params(POLL))).status).toBe(404)
    h.answers.team_chat_poll_read = { data: null, error: null }
    expect((await readPollRoute(new NextRequest(new URL('http://localhost/x')), params(POLL))).status).toBe(404)
  })
  it('an anonymous poll never names a voter, whatever it is sent', async () => {
    h.answers.team_chat_poll_read = { data: pollJson({ anonymous: true }), error: null }
    const json = await (await readPollRoute(new NextRequest(new URL('http://localhost/x')), params(POLL))).json()
    expect(json.poll.options.every((o: { voter_ids: string[] }) => o.voter_ids.length === 0)).toBe(true)
  })
})

describe('POST /polls/[id]/vote and /close', () => {
  it('sends the whole answer, deduplicated', async () => {
    const res = await voteRoute(post(`/x`, { option_ids: [OPT_A, OPT_A.toUpperCase()] }), params(POLL))
    expect(res.status).toBe(200)
    expect(h.rpcs).toEqual([['team_chat_poll_vote', { poll: POLL, option_ids: [OPT_A] }]])
  })
  it('an empty answer takes the vote back', async () => {
    await voteRoute(post(`/x`, { option_ids: [] }), params(POLL))
    expect(h.rpcs).toEqual([['team_chat_poll_vote', { poll: POLL, option_ids: [] }]])
  })
  it('refuses junk before the database, and says why when the poll refuses', async () => {
    expect((await voteRoute(post(`/x`, { option_ids: 'a' }), params(POLL))).status).toBe(400)
    expect((await voteRoute(post(`/x`, { option_ids: ['nope'] }), params(POLL))).status).toBe(400)
    expect(h.rpcs).toEqual([])
    h.answers.team_chat_poll_vote = { data: null, error: { code: '22023', message: 'team chat: this poll is closed' } }
    const res = await voteRoute(post(`/x`, { option_ids: [OPT_B] }), params(POLL))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/closed/)
  })
  it('close goes through team_chat_poll_close; someone else is a 403', async () => {
    const res = await closeRoute(post(`/x`), params(POLL))
    expect((await res.json()).poll.closed_at).toBe('2026-11-23T11:00:00Z')
    h.answers.team_chat_poll_close = { data: null, error: { code: '42501', message: 'not yours' } }
    expect((await closeRoute(post(`/x`), params(POLL))).status).toBe(403)
  })
})
