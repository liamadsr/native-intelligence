/**
 * Phase 2 on the client (migration 560): a notification or a search hit opens
 * team chat on the message (one team chat card, moved there), a notification
 * about what is on screen raises no toast, and a muted channel shows no
 * unread count but still its mentions.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cardForTarget } from '@/lib/chat-cards/open-card'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import { entityLink } from '@/lib/entities/entity-actions-registry'
import { menuRowTarget, menuRowMention, type MenuSearchRow } from '@/lib/search/menu-search'
import { notificationCardTarget } from '@/app/account/notification-open'
import { resolveNotificationDetailPanel } from '@/app/account/notification-panel'
import { channelBadge, channelHeaderCount, mergePage } from '../compose'
import { isTeamChatNoticeOnScreen, setTeamChatOnScreen } from '../on-screen'

const CH = '55555555-5555-4555-8555-555555555555'
const MSG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ROOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('opening team chat on a message', () => {
  it('one team chat card (no target, so the one in the chat comes back), started on the message or the channel', () => {
    expect(cardForTarget({ type: 'team_chat', messageId: MSG })).toEqual({ spec: { kind: 'team_chat', title: 'Team chat' }, seed: { at: { type: 'team_chat_message', id: MSG } } })
    expect(cardForTarget({ type: 'team_chat', channelId: CH })).toEqual({ spec: { kind: 'team_chat', title: 'Team chat' }, seed: { at: { type: 'team_chat_channel', id: CH } } })
    expect(cardForTarget({ type: 'team_chat' })).toEqual({ spec: { kind: 'team_chat', title: 'Team chat' } })
  })

  it('a message or a channel, from anywhere an entity opens (the Inbox, a link)', () => {
    expect(entityOpenTarget('team_chat_message', MSG)).toEqual({ type: 'team_chat', messageId: MSG })
    expect(entityOpenTarget('team_chat_channel', CH)).toEqual({ type: 'team_chat', channelId: CH })
    expect(entityLink('team_chat_message', MSG, 'https://app.example.test')).toBe(`https://app.example.test/account?team_chat_message=${MSG}`)
  })

  it('a notification’s click (a native banner’s too) opens team chat on its message', async () => {
    const target = await resolveNotificationDetailPanel({
      type: 'team_chat_message',
      target_type: 'team_chat_message',
      target_id: MSG,
      context_type: 'team_chat_channel',
      context_id: CH,
      title: 'Ana Ruiz in #launch',
      body: 'ship it',
    })
    expect(target).toEqual({ type: 'team_chat', id: MSG, title: 'Ana Ruiz in #launch' })
    expect(notificationCardTarget(target!)).toEqual({ type: 'team_chat', messageId: MSG })
  })

  it('a search hit opens it too, and is never something to @-mention', () => {
    const row: MenuSearchRow = { kind: 'team_chat_message', id: MSG, title: 'the launch plan', place: '#launch', author: 'Ana', channelId: CH, threadRootId: ROOT, createdAt: '2026-11-10T10:00:00Z', score: 0.3 }
    expect(menuRowTarget(row)).toEqual({ type: 'team_chat', messageId: MSG, channelId: CH })
    expect(menuRowMention(row)).toBeNull()
  })
})

describe('on screen: no toast about what the person is reading', () => {
  const view = Symbol('view')
  afterEach(() => setTeamChatOnScreen(view, null))
  const notice = (thread: string | null) => ({ type: 'team_chat_message', metadata: { channel_id: CH, thread_root_id: thread } })

  it('the channel on screen: its own messages; a thread’s reply only with that thread open', () => {
    expect(isTeamChatNoticeOnScreen(notice(null))).toBe(false)
    setTeamChatOnScreen(view, { channelId: CH, threadRootId: null })
    expect(isTeamChatNoticeOnScreen(notice(null))).toBe(true)
    expect(isTeamChatNoticeOnScreen(notice(ROOT))).toBe(false)
    setTeamChatOnScreen(view, { channelId: CH, threadRootId: ROOT })
    expect(isTeamChatNoticeOnScreen(notice(ROOT))).toBe(true)
    expect(isTeamChatNoticeOnScreen({ type: 'agent_message', metadata: { channel_id: CH } })).toBe(false)
    setTeamChatOnScreen(view, null)
    expect(isTeamChatNoticeOnScreen(notice(null))).toBe(false)
  })
})

describe('a muted channel’s badge', () => {
  const counts = { unread: 4, mentions: 1, thread_unread: 2, thread_mentions: 1 }
  it('mentions only and all count everything unread; muted counts nothing but its mentions', () => {
    expect(channelBadge({ ...counts, notify: 'mentions' })).toEqual({ count: 6, mentions: 2 })
    expect(channelBadge({ ...counts, notify: 'all' })).toEqual({ count: 6, mentions: 2 })
    expect(channelBadge({ ...counts, notify: 'muted' })).toEqual({ count: 0, mentions: 2 })
    expect(channelHeaderCount({ ...counts, notify: 'mentions' })).toBe(6)
    expect(channelHeaderCount({ ...counts, notify: 'muted' })).toBe(2)
  })
})

describe('a page around an old message', () => {
  const row = (id: string, at: string, over: Record<string, unknown> = {}) => ({ id, client_id: null as string | null, created_at: at, ...over })
  it('reaching the newest: merged with what is shown; not reaching it: shown alone, only the person’s own sends on their way kept', () => {
    const shown = [row('n1', '2026-11-10T12:00:00Z'), row('pending:c1', '2026-11-10T12:05:00Z', { client_id: 'c1', pending: 'sending' })]
    const page = [row('o1', '2026-11-01T09:00:00Z'), row('o2', '2026-11-01T09:01:00Z')]
    expect(mergePage(shown, page).map((m) => m.id)).toEqual(['o1', 'o2', 'n1', 'pending:c1'])
    expect(mergePage(shown, page, true).map((m) => m.id)).toEqual(['o1', 'o2', 'pending:c1'])
  })
})
