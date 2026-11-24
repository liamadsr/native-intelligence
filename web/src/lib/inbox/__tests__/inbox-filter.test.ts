/**
 * Incoming's filter (../items.ts; Liam, 11-24: "the same type of filter for
 * the incoming view with the different notifications we support with all
 * being the default"): Status and Type, each Type a group of the real
 * notification types. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import { NOTIFICATION_TYPES } from '@/lib/notifications'
import {
  DEFAULT_INBOX_FILTER,
  INBOX_KINDS,
  filterInbox,
  inboxKindCounts,
  inboxKindOf,
  isDefaultInboxFilter,
  parseInboxFilter,
  toggleInboxKind,
  type InboxItem,
} from '../items'

const item = (key: string, type: string, over: Partial<InboxItem> = {}): InboxItem => ({
  key,
  source: 'notification',
  category: 'other',
  at: '2026-11-24T10:00:00Z',
  title: key,
  body: null,
  unread: true,
  count: 1,
  notificationIds: [key],
  actor: null,
  open: { kind: 'none' },
  type,
  ...over,
})

describe('Incoming’s kinds', () => {
  it('give every real notification type a kind, Other only for what fits none', () => {
    const others = NOTIFICATION_TYPES.filter((t) => inboxKindOf({ source: 'notification', type: t }) === 'other')
    expect(others).toEqual(['workspace_merged'])
    expect(inboxKindOf({ source: 'notification', type: 'team_chat_message' })).toBe('messages')
    expect(inboxKindOf({ source: 'notification', type: 'mentioned' })).toBe('mentions')
    expect(inboxKindOf({ source: 'notification', type: 'meeting_waiting' })).toBe('meetings')
    expect(inboxKindOf({ source: 'notification', type: 'github_checks_failed' })).toBe('reviews')
    expect(inboxKindOf({ source: 'notification', type: 'comment_reply' })).toBe('comments')
    expect(inboxKindOf({ source: 'notification', type: 'work_needs_you' })).toBe('agent')
    expect(inboxKindOf({ source: 'mail', type: 'mail_to_respond' })).toBe('mail')
    expect(inboxKindOf({ source: 'notification', type: 'something_new' })).toBe('other')
    expect(INBOX_KINDS.map((k) => k.key)).toEqual(['messages', 'mentions', 'mail', 'meetings', 'tasks', 'comments', 'reviews', 'agent', 'other'])
  })
})

describe('Incoming’s filter', () => {
  const data = {
    items: [item('a', 'team_chat_message'), item('b', 'mentioned', { unread: false }), item('c', 'mail', { source: 'mail' })],
    held: [item('h', 'reminder')],
  }

  it('is All by default: every listed item, not the held', () => {
    expect(isDefaultInboxFilter(DEFAULT_INBOX_FILTER)).toBe(true)
    expect(filterInbox(data, DEFAULT_INBOX_FILTER).map((i) => i.key)).toEqual(['a', 'b', 'c'])
  })

  it('narrows by Status (Unread, Read, Held) and by Type, together', () => {
    expect(filterInbox(data, { status: 'unread', kinds: [] }).map((i) => i.key)).toEqual(['a', 'c'])
    expect(filterInbox(data, { status: 'read', kinds: [] }).map((i) => i.key)).toEqual(['b'])
    expect(filterInbox(data, { status: 'held', kinds: [] }).map((i) => i.key)).toEqual(['h'])
    expect(filterInbox(data, { status: 'all', kinds: ['mail', 'messages'] }).map((i) => i.key)).toEqual(['a', 'c'])
    expect(filterInbox(data, { status: 'unread', kinds: ['mentions'] })).toEqual([])
    expect(filterInbox(null, DEFAULT_INBOX_FILTER)).toEqual([])
  })

  it('counts the kinds the list has (a held one’s kind offered, at 0)', () => {
    expect([...inboxKindCounts(data)]).toEqual([['messages', 1], ['mentions', 1], ['mail', 1], ['tasks', 0]])
  })

  it('toggles a Type, and reads a saved one back with only what it knows', () => {
    const on = toggleInboxKind(DEFAULT_INBOX_FILTER, 'reviews')
    expect(on.kinds).toEqual(['reviews'])
    expect(toggleInboxKind(on, 'reviews').kinds).toEqual([])
    expect(parseInboxFilter(JSON.stringify({ status: 'held', kinds: ['mail', 'nope', 'mail'] }))).toEqual({ status: 'held', kinds: ['mail'] })
    expect(parseInboxFilter('{bad')).toEqual(DEFAULT_INBOX_FILTER)
    expect(parseInboxFilter(JSON.stringify({ status: 'weird' }))).toEqual(DEFAULT_INBOX_FILTER)
  })
})
