/**
 * The sub-nav and support conversations (migration 715): a customer's own is
 * pinned first in Favorites, whatever they starred; our staff's view of every
 * customer's is a Support section of its own, at the top.
 */
import { describe, expect, it } from 'vitest'
import type { TeamChatPanelConversation } from '@/components/chat-cards/team-chat-card-controls'
import type { TeamChatChannel } from '@/lib/team-chat/types'
import { isPinnedSupport, sectionOf, teamChatPanelSections } from '../team-chat-panel-model'

function conv(id: string, over: Partial<TeamChatChannel> = {}, title = id): TeamChatPanelConversation {
  return {
    channel: {
      id,
      kind: 'channel',
      name: id,
      topic: null,
      team_id: null,
      dm_member_id: null,
      last_message_at: null,
      archived_at: null,
      unread: 0,
      mentions: 0,
      thread_unread: 0,
      thread_mentions: 0,
      notify: 'mentions',
      ...over,
    },
    title,
    teamName: null,
    privateTeam: false,
    person: null,
  }
}

const SUPPORT_INFO = { workspace_id: 'w', workspace_name: 'W', customer_user_id: 'u', customer_member_id: 'm', customer_name: 'Ana Ruiz', customer_email: 'ana@example.com' }

describe('support conversations in the sub-nav', () => {
  it('the customer’s own: first in Favorites, pinned, and not again under Channels', () => {
    const general = conv('general')
    const starredDm = conv('dm1', { kind: 'dm', dm_member_id: 'x' })
    const mine = conv('support', { kind: 'support', name: 'Native Intelligence Support x Bo Lind' })
    const sections = teamChatPanelSections([general, starredDm, mine], ['dm1'])
    expect(sections[0].key).toBe('favorites')
    expect(sections[0].rows.map((r) => r.conversation.channel.id)).toEqual(['support', 'dm1'])
    expect(sections.find((s) => s.key === 'channels')?.rows.map((r) => r.conversation.channel.id)).toEqual(['general'])
    expect(sections.some((s) => s.key === 'support')).toBe(false)
    expect(isPinnedSupport(mine)).toBe(true)
  })

  it('pinned even when it was starred too (listed once)', () => {
    const mine = conv('support', { kind: 'support', name: 'S' })
    expect(teamChatPanelSections([mine], ['support'])[0].rows).toHaveLength(1)
  })

  it('our staff’s: a Support section first, latest activity first, never in Favorites', () => {
    const a = conv('a', { kind: 'support', support: SUPPORT_INFO, last_message_at: '2026-11-20T00:00:00Z' }, 'Ana Ruiz')
    const b = conv('b', { kind: 'support', support: { ...SUPPORT_INFO, customer_name: 'Bo Lind' }, last_message_at: '2026-11-22T00:00:00Z' }, 'Bo Lind')
    const sections = teamChatPanelSections([conv('general'), a, b], ['a'])
    expect(sections[0].key).toBe('support')
    expect(sections[0].heading).toBe('Support')
    expect(sections[0].rows.map((r) => r.conversation.title)).toEqual(['Bo Lind', 'Ana Ruiz'])
    expect(isPinnedSupport(a)).toBe(false)
    expect(sectionOf(a)).toBe('support')
  })
})
