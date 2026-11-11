/**
 * A retried send (the same client id) finishes what the first try didn't:
 * the first try stores the message, then fails before its mention edges, its
 * channel shares, the agent's turn and the link preview; the retry answers
 * with the stored message (`replayed`) and does each of those, exactly once,
 * however many more retries come. The agent's intake runs for real
 * (src/lib/team-chat/agent-turn.ts); Inngest drops a second event with an id
 * it has seen, as it does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ANA = '33333333-3333-4333-8333-333333333333'
const CH = '55555555-5555-4555-8555-555555555555'
const SEND = '99999999-9999-4999-8999-999999999999'
const DOC = 'd0000000-0000-4000-8000-000000000001'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  db: null as unknown as SupabaseClient,
  // Inngest: the ids it has taken (a second event with one of them is dropped).
  seen: new Set<string>(),
  accepted: [] as Array<{ name: string; id: string }>,
  persisted: new Set<string>(),
  edges: new Map<string, string[]>(),
  grants: new Set<string>(),
  shareFailsOnce: true,
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
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: async (event: { name: string; id: string }) => {
      if (h.seen.has(event.id)) return { ids: [] }
      h.seen.add(event.id)
      h.accepted.push({ name: event.name, id: event.id })
      return { ids: [event.id] }
    },
  },
}))
vi.mock('@/lib/chat/eve-message-writer', () => ({
  // The person's message in their conversation, by its id: a second write finds it there.
  persistEveMessage: async (_db: unknown, opts: { messageId: string }) => {
    if (h.persisted.has(opts.messageId)) return { written: false }
    h.persisted.add(opts.messageId)
    return { written: true }
  },
}))
vi.mock('@/lib/team-chat/record-mentions', () => ({
  fenceRecordMentions: async (_db: unknown, _scope: unknown, raw: unknown) => raw ?? [],
  // The edges match the list (a sync, not an append).
  syncMessageMentions: async (_db: unknown, input: { messageId: string; records: Array<{ id: string }> }) => {
    h.edges.set(input.messageId, input.records.map((r) => r.id))
  },
  storedRecordMentions: async () => [],
}))
vi.mock('@/lib/entity-access/share', () => ({
  // The first try dies here, after the insert; a grant the channel has is never made again.
  shareMentionedRecords: async (_db: unknown, input: { records: Array<{ id: string }> }) => {
    if (h.shareFailsOnce) {
      h.shareFailsOnce = false
      throw new Error('connection reset')
    }
    const fresh = input.records.filter((r) => !h.grants.has(r.id))
    for (const r of fresh) h.grants.add(r.id)
    return { shared: fresh.map((r) => ({ grant_id: `g-${r.id}`, type: 'document', id: r.id, label: 'Plan' })), shared_with: fresh.length ? '#launch' : null }
  },
}))

import { POST as postMessage } from '../channels/[id]/messages/route'

let tables: Record<string, Array<Record<string, unknown>>>
beforeEach(() => {
  tables = {
    team_chat_channel: [{ id: CH, workspace_id: WS, kind: 'channel', name: 'launch', team_id: null, dm_key: null, archived_at: null, created_at: '2026-11-08T00:00:00Z' }],
    team_chat_message: [],
    member: [{ id: ANA, workspace_id: WS, user_id: USER, display_name: 'Ana Ruiz' }],
    team_chat_agent_thread: [],
    chat_conversations: [],
  }
  const db = memoryDb(tables, {
    team_chat_message: (a, b) => !!a.client_id && a.client_id === b.client_id && a.author_member_id === b.author_member_id,
  })
  h.db = Object.assign(db, { auth: { admin: { getUserById: async () => ({ data: { user: { user_metadata: { assistant_name: 'Juniper' } } } }) } } }) as unknown as SupabaseClient
  h.afters = []
  h.seen = new Set()
  h.accepted = []
  h.persisted = new Set()
  h.edges = new Map()
  h.grants = new Set()
  h.shareFailsOnce = true
})

const send = () =>
  postMessage(
    new NextRequest(new URL(`/api/account/team-chat/channels/${CH}/messages`, 'http://localhost'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '@Juniper see @Plan https://news.example.test/story', records: [{ type: 'document', id: DOC, label: 'Plan' }], clientId: SEND }),
    }),
    { params: Promise.resolve({ id: CH }) },
  )
async function runAfters() {
  const tasks = h.afters.splice(0)
  for (const task of tasks) await task()
}

describe('a retried send', () => {
  it('finishes everything the first try left undone, exactly once', async () => {
    const first = await send()
    expect(first.status).toBe(500)
    await runAfters()
    // Stored, but nothing after the insert happened.
    expect(tables.team_chat_message).toHaveLength(1)
    const id = tables.team_chat_message[0].id as string
    expect(h.grants.size).toBe(0)
    expect(h.accepted).toEqual([])

    const retry = await send()
    expect(retry.status).toBe(200)
    const json = await retry.json()
    expect(json).toMatchObject({ replayed: true, message: { id }, shared: [{ id: DOC }], shared_with: '#launch' })
    await runAfters()

    // And again (the answer to the retry was lost too): nothing more.
    const again = await send()
    expect(again.status).toBe(200)
    expect((await again.json()).shared).toEqual([])
    await runAfters()

    expect(tables.team_chat_message).toHaveLength(1)
    expect(h.edges.get(id)).toEqual([DOC])
    expect([...h.grants]).toEqual([DOC])
    expect(h.accepted).toEqual([
      { name: 'team-chat/link-preview.requested', id: expect.stringMatching(new RegExp(`^team-chat-preview-${id}-`)) },
      { name: 'team-chat/turn.requested', id: `team-chat-turn-${id}` },
    ])
    // One conversation for the channel, one copy of the person's words in it.
    expect(tables.chat_conversations).toHaveLength(1)
    expect(h.persisted.size).toBe(1)
  })
})
