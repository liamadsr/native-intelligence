import { describe, expect, it } from 'vitest'
import {
  applyHolds,
  filterItems,
  holdUntil,
  holdUntilError,
  isInboxItemKey,
  mailItems,
  notificationItems,
  notificationOpen,
  type InboxNotificationRow,
} from '../items'

const CH = '55555555-5555-4555-8555-555555555555'
const MSG1 = '77777777-7777-4777-8777-777777777771'
const MSG2 = '77777777-7777-4777-8777-777777777772'

const row = (over: Partial<InboxNotificationRow>): InboxNotificationRow => ({
  id: 'n',
  type: 'team_chat_message',
  title: 'Ana Ruiz in #launch',
  body: 'hello',
  actor_id: 'ana',
  target_type: 'team_chat_message',
  target_id: MSG1,
  context_type: 'team_chat_channel',
  context_id: CH,
  is_read: false,
  group_key: `team_chat:${CH}`,
  metadata: { channel_id: CH, message_id: MSG1, thread_root_id: null },
  created_at: '2026-11-23T10:00:00Z',
  actor: { id: 'ana', display_name: 'Ana Ruiz', avatar_url: null },
  ...over,
})

describe('notificationItems', () => {
  it('a conversation is one item: its newest row, counted, unread while any is', () => {
    const items = notificationItems([
      row({ id: 'a', is_read: true }),
      row({ id: 'b', body: 'newer', created_at: '2026-11-23T10:05:00Z', target_id: MSG2, metadata: { channel_id: CH, message_id: MSG2 } }),
      row({ id: 'c', type: 'action_assigned', group_key: null, target_type: 'action', target_id: 'act-1', context_type: null, context_id: null, metadata: {}, created_at: '2026-11-23T09:00:00Z', title: 'Ana assigned you ENG-4' }),
    ])
    expect(items.map((i) => i.key)).toEqual([`n:team_chat:${CH}`, 'n:c'])
    expect(items[0]).toMatchObject({ count: 2, body: 'newer', unread: true, category: 'messages', notificationIds: ['b', 'a'] })
    expect(items[0].open).toEqual({ kind: 'team_chat', channelId: CH, messageId: MSG2, threadRootId: null })
    expect(items[1]).toMatchObject({ category: 'mentions', open: { kind: 'record', type: 'action', id: 'act-1' } })
  })
  it('opens a thread reply on its thread', () => {
    expect(notificationOpen(row({ metadata: { channel_id: CH, message_id: MSG2, thread_root_id: MSG1 } }))).toEqual({ kind: 'team_chat', channelId: CH, messageId: MSG2, threadRootId: MSG1 })
  })
  it('an item with nowhere to go opens nothing', () => {
    expect(notificationOpen(row({ type: 'agent_digest', target_type: null, target_id: null, context_type: null, context_id: null, metadata: null }))).toEqual({ kind: 'none' })
  })
})

describe('mailItems', () => {
  it('only to-respond or important, newest first', () => {
    const items = mailItems([
      { id: '11111111-1111-4111-8111-111111111111', provider_thread_id: 't1', account_id: null, last_message_at: '2026-11-22T10:00:00Z', is_unread: true, needs_reply: true, auto_classified: 'personal', subject: 'Contract', from_name: 'Dana' },
      { id: '22222222-2222-4222-8222-222222222222', provider_thread_id: 't2', account_id: null, last_message_at: '2026-11-23T10:00:00Z', is_unread: false, needs_reply: false, auto_classified: 'important', from_email: 'lee@example.com' },
      { id: '33333333-3333-4333-8333-333333333333', provider_thread_id: 't3', account_id: null, last_message_at: '2026-11-23T11:00:00Z', is_unread: true, needs_reply: false, auto_classified: 'newsletter' },
    ])
    expect(items.map((i) => i.title)).toEqual(['lee@example.com', 'Dana'])
    expect(items[1]).toMatchObject({ body: 'Contract', type: 'mail_to_respond', category: 'mail' })
  })
})

describe('applyHolds', () => {
  const now = new Date('2026-11-23T12:00:00Z')
  const items = notificationItems([
    row({ id: 'a', created_at: '2026-11-23T11:00:00Z' }),
    row({ id: 'x', group_key: null, type: 'reminder', created_at: '2026-11-23T11:30:00Z' }),
  ])
  it('a running hold sets the item aside', () => {
    const r = applyHolds(items, [{ item_key: `n:team_chat:${CH}`, held_until: '2026-11-23T18:00:00Z', held_at: '2026-11-23T11:10:00Z' }], now)
    expect(r.listed.map((i) => i.key)).toEqual(['n:x'])
    expect(r.held).toMatchObject([{ key: `n:team_chat:${CH}`, heldUntil: '2026-11-23T18:00:00Z' }])
  })
  it('something new since the hold brings it back', () => {
    const r = applyHolds(items, [{ item_key: `n:team_chat:${CH}`, held_until: '2026-11-23T18:00:00Z', held_at: '2026-11-23T10:30:00Z' }], now)
    expect(r.held).toEqual([])
    expect(r.listed).toHaveLength(2)
  })
  it('a hold that ran out puts its item back at the top', () => {
    const r = applyHolds(items, [{ item_key: `n:team_chat:${CH}`, held_until: '2026-11-23T11:45:00Z', held_at: '2026-11-23T11:10:00Z' }], now)
    expect(r.listed.map((i) => i.key)).toEqual([`n:team_chat:${CH}`, 'n:x'])
    expect(r.held).toEqual([])
  })
})

describe('filters, holds and keys', () => {
  it('filters by category', () => {
    const items = notificationItems([row({ id: 'a' }), row({ id: 'b', type: 'mentioned', group_key: null })])
    expect(filterItems(items, 'messages').map((i) => i.key)).toEqual([`n:team_chat:${CH}`])
    expect(filterItems(items, 'mentions').map((i) => i.key)).toEqual(['n:b'])
    expect(filterItems(items, 'all')).toHaveLength(2)
  })
  it('hold times on the local clock', () => {
    const mon = new Date(2026, 10, 23, 14, 0) // a Monday afternoon
    expect(holdUntil('hour', mon).getTime() - mon.getTime()).toBe(3_600_000)
    expect([holdUntil('evening', mon).getDate(), holdUntil('evening', mon).getHours()]).toEqual([23, 18])
    expect(holdUntil('evening', new Date(2026, 10, 23, 17, 30)).getDate()).toBe(24)
    expect([holdUntil('tomorrow', mon).getDate(), holdUntil('tomorrow', mon).getHours()]).toEqual([24, 8])
    const nextWeek = holdUntil('next_week', mon)
    expect([nextWeek.getDay(), nextWeek.getDate(), nextWeek.getHours()]).toEqual([1, 30, 8])
    expect(holdUntil('next_week', new Date(2026, 10, 25, 9, 0)).getDate()).toBe(30)
  })
  it('hold end checks', () => {
    const now = new Date('2026-11-23T12:00:00Z')
    expect(holdUntilError('2026-11-23T13:00:00Z', now)).toBeNull()
    expect(holdUntilError('2026-11-23T11:00:00Z', now)).toMatch(/future/)
    expect(holdUntilError('2027-06-01T00:00:00Z', now)).toMatch(/90 days/)
    expect(holdUntilError(1, now)).toMatch(/time/)
  })
  it('item keys', () => {
    expect(isInboxItemKey(`n:team_chat:${CH}`)).toBe(true)
    expect(isInboxItemKey('n:team_chat_thread:abc')).toBe(true)
    expect(isInboxItemKey('mail:11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isInboxItemKey('mail:nope')).toBe(false)
    expect(isInboxItemKey('x:1')).toBe(false)
    expect(isInboxItemKey(`n:${'a'.repeat(201)}`)).toBe(false)
  })
})
