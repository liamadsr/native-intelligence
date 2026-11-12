/**
 * A team-chat message @-mentioning records (migration 480): each record the
 * author may read is stored on the message and written as a `mentions` edge
 * (source team_chat_message → target the record); a foreign or private one is
 * dropped. An edit adds and removes edges to match; a delete removes them all.
 * Member mentions (`mentions`) are unchanged. Fixtures are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '11111111-1111-4111-8111-999999999999'
const USER = '22222222-2222-4222-8222-222222222222'
const BEN_USER = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const ANA = '33333333-3333-4333-8333-333333333333'
const BEN = '44444444-4444-4444-8444-444444444444'
const CH = '55555555-5555-4555-8555-555555555555'
const ACTION = 'a0000000-0000-4000-8000-000000000001'
const ACTION_2 = 'a0000000-0000-4000-8000-000000000002'
const FOREIGN_ACTION = 'a0000000-0000-4000-8000-0000000000ff'
const DEAL = 'd0000000-0000-4000-8000-000000000001'
const BEN_PRIVATE_CAPTURE = 'c0000000-0000-4000-8000-000000000001'
const BEN_EVENT = 'e0000000-0000-4000-8000-000000000001'
const MY_EVENT = 'e0000000-0000-4000-8000-000000000002'

const h = vi.hoisted(() => ({ db: null as unknown as SupabaseClient }))

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({
    supabase: h.db,
    user: { id: USER, user_metadata: { assistant_name: 'Juniper' } },
    workspaceId: WS,
    member: { id: ANA },
  }),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.db }))
vi.mock('@/lib/team-chat/agent-turn', () => ({ deliverTeamChatMention: async () => 'queued' }))

import { POST as postMessage } from '../channels/[id]/messages/route'
import { PATCH as editMessage, DELETE as deleteMessage } from '../messages/[id]/route'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  tables = {
    team_chat_channel: [{ id: CH, workspace_id: WS, kind: 'channel', name: 'launch', team_id: null, dm_key: null, archived_at: null }],
    team_chat_message: [],
    member: [
      { id: ANA, user_id: USER, workspace_id: WS, display_name: 'Ana Ruiz' },
      { id: BEN, user_id: BEN_USER, workspace_id: WS, display_name: 'Ben Ortiz' },
    ],
    actions: [
      { id: ACTION, workspace_id: WS, title: 'Send the Fernhill quote', identifier: 'GEN-42' },
      { id: ACTION_2, workspace_id: WS, title: 'Book the venue', identifier: 'GEN-43' },
      { id: FOREIGN_ACTION, workspace_id: OTHER_WS, title: 'Not yours', identifier: 'OTH-1' },
    ],
    flow: [{ id: DEAL, workspace_id: WS, name: 'Fernhill renewal' }],
    captures: [{ id: BEN_PRIVATE_CAPTURE, workspace_id: WS, visibility: 'private', user_id: BEN_USER, is_eval: false, title: 'Ben 1:1' }],
    local_calendar_event: [
      { id: BEN_EVENT, workspace_id: WS, user_id: BEN_USER, title: 'Ben dentist' },
      { id: MY_EVENT, workspace_id: WS, user_id: USER, title: 'Fernhill sync' },
    ],
    entity_link: [],
  }
  h.db = memoryDb(tables)
})

function req(url: string, body?: unknown, method = 'POST') {
  return new NextRequest(new URL(url, 'http://localhost'), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const edges = () =>
  tables.entity_link
    .filter((e) => e.source_type === 'team_chat_message' && e.relation === 'mentions')
    .map((e) => `${e.target_type}:${e.target_id}`)
    .sort()

async function post(body: string, records: unknown[]) {
  const res = await postMessage(req(`/api/account/team-chat/channels/${CH}/messages`, { body, mentions: [BEN], records }), params(CH))
  expect(res.status).toBe(201)
  return (await res.json()).message as Row & { id: string; record_mentions: Row[] }
}

describe('posting a message that @-mentions records', () => {
  it('stores and links what the author may read, drops what they may not', async () => {
    const message = await post('@Ben Ortiz see @GEN-42, @Fernhill renewal, @OTH-1, @Ben 1:1, @Ben dentist and @Fernhill sync', [
      { type: 'action', id: ACTION, label: 'GEN-42' },
      { type: 'flow', id: DEAL, label: 'Fernhill renewal' },
      { type: 'action', id: FOREIGN_ACTION, label: 'OTH-1' },
      { type: 'capture', id: BEN_PRIVATE_CAPTURE, label: 'Ben 1:1' },
      { type: 'calendar_event', id: BEN_EVENT, label: 'Ben dentist' },
      { type: 'calendar_event', id: MY_EVENT, label: 'Fernhill sync' },
      { type: 'claim', id: ACTION_2, label: 'not mentionable' },
    ])
    expect(message.mentions).toEqual([BEN])
    expect(message.record_mentions).toEqual([
      { type: 'action', id: ACTION, label: 'GEN-42' },
      { type: 'flow', id: DEAL, label: 'Fernhill renewal' },
      { type: 'calendar_event', id: MY_EVENT, label: 'Fernhill sync' },
    ])
    expect(edges()).toEqual([`action:${ACTION}`, `calendar_event:${MY_EVENT}`, `flow:${DEAL}`].sort())
    expect(tables.entity_link.every((e) => e.source_id === message.id && e.workspace_id === WS && e.created_by === ANA)).toBe(true)
  })

  it('keeps a record only while its @label is still in the words', async () => {
    const message = await post('never mind', [{ type: 'action', id: ACTION, label: 'GEN-42' }])
    expect(message.record_mentions).toEqual([])
    expect(edges()).toEqual([])
  })

  it('a message without records (an older client) posts exactly as before', async () => {
    const res = await postMessage(req(`/api/account/team-chat/channels/${CH}/messages`, { body: 'hello' }), params(CH))
    const { message } = await res.json()
    expect(message.record_mentions).toEqual([])
    expect(tables.entity_link).toHaveLength(0)
  })
})

describe('editing and deleting', () => {
  it('an edit adds the new mentions and removes the ones taken out; a delete removes them all', async () => {
    const message = await post('@GEN-42 and @Fernhill renewal', [
      { type: 'action', id: ACTION, label: 'GEN-42' },
      { type: 'flow', id: DEAL, label: 'Fernhill renewal' },
    ])
    // An edge another surface drew from the same message (another relation) is not the mention sync's.
    tables.entity_link.push({ id: 'other-edge', workspace_id: WS, source_type: 'team_chat_message', source_id: message.id, target_type: 'flow', target_id: DEAL, relation: 'related_to' })

    const edited = await editMessage(
      req(`/api/account/team-chat/messages/${message.id}`, { body: 'now @GEN-43 and @Fernhill renewal', records: [{ type: 'action', id: ACTION_2, label: 'GEN-43' }, { type: 'flow', id: DEAL, label: 'Fernhill renewal' }] }, 'PATCH'),
      params(message.id),
    )
    expect(edited.status).toBe(200)
    expect((await edited.json()).message.record_mentions).toHaveLength(2)
    expect(edges()).toEqual([`action:${ACTION_2}`, `flow:${DEAL}`].sort())

    const del = await deleteMessage(req(`/api/account/team-chat/messages/${message.id}`, undefined, 'DELETE'), params(message.id))
    expect(del.status).toBe(200)
    expect(edges()).toEqual([])
    expect(tables.entity_link.map((e) => e.id)).toEqual(['other-edge'])
  })

  it('an edit from an older client (no `records`) keeps the mentions its words still name', async () => {
    const message = await post('@GEN-42 and @Fernhill renewal', [
      { type: 'action', id: ACTION, label: 'GEN-42' },
      { type: 'flow', id: DEAL, label: 'Fernhill renewal' },
    ])
    const edited = await editMessage(
      req(`/api/account/team-chat/messages/${message.id}`, { body: 'just @GEN-42 now' }, 'PATCH'),
      params(message.id),
    )
    expect(edited.status).toBe(200)
    expect((await edited.json()).message.record_mentions).toEqual([{ type: 'action', id: ACTION, label: 'GEN-42' }])
    expect(edges()).toEqual([`action:${ACTION}`])
  })
})
