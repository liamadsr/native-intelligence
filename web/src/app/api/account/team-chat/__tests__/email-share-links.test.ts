/**
 * The message post route turns its author's own email share links into
 * shares (migration 646, src/lib/email-share/bind.ts): the answer's message
 * carries the share and draws the card; someone else's link stays plain text;
 * no link preview is asked for a share link. The route runs for real on the
 * in-memory database; the owner's mailbox check is a fake. Made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const AVERY = '22222222-2222-4222-8222-222222222222'
const BLAKE = '22222222-2222-4222-8222-222222222223'
const M_AVERY = '33333333-3333-4333-8333-333333333333'
const M_BLAKE = '33333333-3333-4333-8333-333333333334'
const CH = '55555555-5555-4555-8555-555555555555'
const ACCOUNT = '66666666-6666-4666-8666-666666666666'
const LINK = '77777777-7777-4777-8777-777777777777'
const TOKEN = 'TokenOne_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  db: null as unknown as SupabaseClient,
  as: { user: '', member: '' },
  events: [] as string[],
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({ supabase: h.db, user: { id: h.as.user, user_metadata: {} }, workspaceId: WS, member: { id: h.as.member } }),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.db }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: async (e: { name: string }) => (h.events.push(e.name), { ids: [] }) } }))
vi.mock('@/lib/team-chat/record-mentions', () => ({
  fenceRecordMentions: async () => [],
  syncMessageMentions: async () => {},
  storedRecordMentions: async () => [],
}))
vi.mock('@/lib/entity-access/share', () => ({ shareMentionedRecords: async () => ({ shared: [], shared_with: null }) }))
vi.mock('@/lib/email/account-scope', () => ({ readableWorkspaceEmailAccounts: async (userId: string) => (userId === AVERY ? [{ id: ACCOUNT }] : []) }))
vi.mock('@/lib/email/thread-mailbox', () => ({ ownedMailbox: async (userId: string, accountId: string) => (userId === AVERY && accountId === ACCOUNT ? { provider: 'google', token: 't' } : null) }))

import { POST as postMessage } from '../channels/[id]/messages/route'

let tables: Record<string, Array<Record<string, unknown>>>
beforeEach(() => {
  tables = {
    team_chat_channel: [{ id: CH, workspace_id: WS, kind: 'channel', name: 'sales', team_id: null, dm_key: null, archived_at: null, created_at: '2026-11-08T00:00:00Z' }],
    team_chat_message: [],
    member: [
      { id: M_AVERY, workspace_id: WS, user_id: AVERY, display_name: 'Avery Stone' },
      { id: M_BLAKE, workspace_id: WS, user_id: BLAKE, display_name: 'Blake Rivera' },
    ],
    email_share: [],
    email_share_link: [
      { id: LINK, token: TOKEN, workspace_id: WS, owner_user_id: AVERY, account_id: ACCOUNT, provider: 'google', provider_thread_id: 'thr-1', thread_index_id: null, message_ids: ['m1', 'm2'], revoked_at: null },
    ],
  }
  h.db = memoryDb(tables)
  h.afters = []
  h.events = []
})

async function send(as: { user: string; member: string }, body: string) {
  h.as = as
  const res = await postMessage(
    new NextRequest(new URL(`/api/account/team-chat/channels/${CH}/messages`, 'http://localhost'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    }),
    { params: Promise.resolve({ id: CH }) },
  )
  for (const task of h.afters.splice(0)) await task()
  return { status: res.status, json: (await res.json()) as { message: { id: string; email_share_id?: string | null } } }
}

describe('posting an email share link', () => {
  it('by its owner: the message carries a share in this channel, frozen as the link; no preview', async () => {
    const { status, json } = await send({ user: AVERY, member: M_AVERY }, `Have a look https://app.northwind.example/mail/s/${TOKEN}`)
    expect(status).toBe(201)
    expect(tables.email_share).toHaveLength(1)
    expect(tables.email_share[0]).toMatchObject({ channel_id: CH, team_chat_message_id: json.message.id, link_id: LINK, message_ids: ['m1', 'm2'], owner_user_id: AVERY })
    expect(json.message.email_share_id).toBe(tables.email_share[0].id)
    expect(tables.team_chat_message[0].email_share_id).toBe(tables.email_share[0].id)
    expect(h.events).not.toContain('team-chat/link-preview.requested')
    expect(h.events.some((e) => /preview/i.test(e))).toBe(false)
  })

  it('by someone else: plain text, nothing shared', async () => {
    const { json } = await send({ user: BLAKE, member: M_BLAKE }, `https://app.northwind.example/mail/s/${TOKEN}`)
    expect(tables.email_share).toHaveLength(0)
    expect(json.message.email_share_id ?? null).toBeNull()
  })
})
