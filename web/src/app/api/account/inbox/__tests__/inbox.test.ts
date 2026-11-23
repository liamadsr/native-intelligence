/**
 * The inbox (docs/plans/channels-inbox.md, phase 2): one list made of the
 * person's own notifications and mail, as the person. Here: grouping, the
 * team chat fence (a channel they can't read drops out), the mail rule,
 * holds (and no holds before 702), done / undo / read fenced to their own
 * rows, and the hold route's checks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ANA = '33333333-3333-4333-8333-333333333333'
const BEN = '44444444-4444-4444-8444-444444444444'
const CH = '55555555-5555-4555-8555-555555555555'
const GONE = '66666666-6666-4666-8666-666666666666'
const ACC = '99999999-9999-4999-8999-999999999999'
const N = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa0${i}`
const T = (i: number) => `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb0${i}`

const h = vi.hoisted(() => ({ db: null as unknown as SupabaseClient, noHolds: false }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({ supabase: h.db, user: { id: '22222222-2222-4222-8222-222222222222' }, workspaceId: '11111111-1111-4111-8111-111111111111', member: { id: '33333333-3333-4333-8333-333333333333' } }),
}))
vi.mock('@/lib/bots/notice-reach', () => ({
  noticeTeammateReach: async () => ({ reachable: [], orphans: [] }),
  plainNotices: <Q,>(q: Q) => q,
}))
vi.mock('@/lib/email/account-scope', () => ({ getWorkspaceEmailAccountIds: async () => ['99999999-9999-4999-8999-999999999999'] }))

import { GET as getInbox } from '../route'
import { POST as notifications } from '../notifications/route'
import { POST as hold } from '../hold/route'

let tables: Record<string, Array<Record<string, unknown>>>
const note = (i: number, over: Record<string, unknown>) => ({
  id: N(i),
  workspace_id: WS,
  recipient_id: ANA,
  type: 'team_chat_message',
  title: 'Ben in #launch',
  body: `message ${i}`,
  actor_id: BEN,
  target_type: 'team_chat_message',
  target_id: T(i),
  context_type: 'team_chat_channel',
  context_id: CH,
  is_read: false,
  read_at: null,
  is_archived: false,
  group_key: `team_chat:${CH}`,
  metadata: { channel_id: CH, message_id: T(i), thread_root_id: null },
  created_at: `2026-11-23T10:0${i}:00Z`,
  ...over,
})

beforeEach(() => {
  tables = {
    notification: [
      note(1, {}),
      note(2, {}),
      note(3, { type: 'action_assigned', group_key: null, target_type: 'action', target_id: T(3), context_type: null, context_id: null, metadata: {}, title: 'Ben assigned you ENG-4' }),
      // A channel she can't read any more.
      note(4, { context_id: GONE, group_key: `team_chat:${GONE}`, metadata: { channel_id: GONE, message_id: T(4) } }),
      // Someone else's, and one already done.
      note(5, { recipient_id: BEN }),
      note(6, { is_archived: true, group_key: null, type: 'reminder' }),
    ],
    team_chat_channel: [{ id: CH, workspace_id: WS, archived_at: null }],
    email_thread_index: [
      { id: T(7), user_id: USER, workspace_id: WS, account_id: ACC, provider: 'gmail', provider_thread_id: 'g1', provider_message_id: 'm1', folder: 'inbox', last_message_at: '2026-11-23T09:00:00Z', is_unread: true, needs_reply: true, auto_classified: 'personal', from_email: 'dana@example.com' },
      { id: T(8), user_id: USER, workspace_id: WS, account_id: ACC, provider: 'gmail', provider_thread_id: 'g2', provider_message_id: 'm2', folder: 'inbox', last_message_at: '2026-11-23T09:30:00Z', is_unread: true, needs_reply: false, auto_classified: 'newsletter', from_email: 'news@example.com' },
    ],
    inbox_hold: [],
  }
  const db = memoryDb(tables)
  h.db = db
  h.noHolds = false
})

const post = (route: (r: NextRequest) => Promise<Response>, body: unknown) =>
  route(new NextRequest(new URL('http://localhost/api/account/inbox/x'), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))

describe('GET /api/account/inbox', () => {
  it('lists her notifications by conversation and her mail that needs her, fenced to channels she can read', async () => {
    const res = await getInbox()
    expect(res.status).toBe(200)
    const json = await res.json()
    const keys = json.items.map((i: { key: string }) => i.key)
    expect(keys).toEqual([`n:${N(3)}`, `n:team_chat:${CH}`, `mail:${T(7)}`])
    expect(json.items[1]).toMatchObject({ count: 2, unread: true, notificationIds: [N(2), N(1)] })
    expect(json.held).toEqual([])
    expect(json.mail.map((m: { id: string }) => m.id)).toEqual([T(7)])
  })

  it('a held item waits in held, and the list holds before 702 too', async () => {
    tables.inbox_hold.push({ user_id: USER, workspace_id: WS, item_key: `n:${N(3)}`, held_until: new Date(Date.now() + 3_600_000).toISOString(), held_at: '2026-11-23T11:00:00Z' })
    const json = await (await getInbox()).json()
    expect(json.items.map((i: { key: string }) => i.key)).not.toContain(`n:${N(3)}`)
    expect(json.held.map((i: { key: string }) => i.key)).toEqual([`n:${N(3)}`])
    delete tables.inbox_hold
    const base = h.db as unknown as { from: (t: string) => unknown }
    const from = base.from.bind(base)
    h.db = Object.assign(Object.create(base), {
      from: (t: string) =>
        t === 'inbox_hold'
          ? { select: () => ({ eq: () => ({ eq: async () => ({ data: null, error: { code: '42P01', message: 'relation "public.inbox_hold" does not exist' } }) }) }) }
          : from(t),
    }) as SupabaseClient
    expect((await getInbox()).status).toBe(200)
  })
})

describe('POST /api/account/inbox/notifications', () => {
  it('done archives her own rows only; undone brings them back', async () => {
    const res = await post(notifications, { action: 'done', ids: [N(1), N(2), N(5)] })
    expect(await res.json()).toEqual({ updated: 2 })
    expect(tables.notification.filter((r) => r.is_archived).map((r) => r.id).sort()).toEqual([N(1), N(2), N(6)].sort())
    expect(tables.notification.find((r) => r.id === N(5))!.is_archived).toBe(false)
    await post(notifications, { action: 'undone', ids: [N(1)] })
    expect(tables.notification.find((r) => r.id === N(1))!.is_archived).toBe(false)
  })
  it('read marks unread ones read', async () => {
    expect(await (await post(notifications, { action: 'read', ids: [N(1), N(5)] })).json()).toEqual({ updated: 1 })
    expect(tables.notification.find((r) => r.id === N(1))!.is_read).toBe(true)
    expect(tables.notification.find((r) => r.id === N(5))!.is_read).toBe(false)
  })
  it('refuses junk', async () => {
    expect((await post(notifications, { action: 'delete', ids: [N(1)] })).status).toBe(400)
    expect((await post(notifications, { action: 'done', ids: [] })).status).toBe(400)
    expect((await post(notifications, { action: 'done', ids: ['x'] })).status).toBe(400)
    expect((await post(notifications, { action: 'done', ids: Array.from({ length: 201 }, () => N(1)) })).status).toBe(400)
  })
})

describe('POST /api/account/inbox/hold', () => {
  it('holds until a time, again replaces, and null brings it back', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString()
    expect(await (await post(hold, { item_key: `n:team_chat:${CH}`, until })).json()).toEqual({ held_until: until })
    expect(tables.inbox_hold).toHaveLength(1)
    expect(tables.inbox_hold[0]).toMatchObject({ user_id: USER, workspace_id: WS, item_key: `n:team_chat:${CH}` })
    expect(await (await post(hold, { item_key: `n:team_chat:${CH}`, until: null })).json()).toEqual({ held_until: null })
    expect(tables.inbox_hold).toHaveLength(0)
  })
  it('refuses a bad key, the past and too far', async () => {
    expect((await post(hold, { item_key: 'x', until: null })).status).toBe(400)
    expect((await post(hold, { item_key: `mail:${T(7)}`, until: '2020-01-01T00:00:00Z' })).status).toBe(400)
    expect((await post(hold, { item_key: `mail:${T(7)}`, until: new Date(Date.now() + 100 * 86_400_000).toISOString() })).status).toBe(400)
    expect(tables.inbox_hold).toHaveLength(0)
  })
})
