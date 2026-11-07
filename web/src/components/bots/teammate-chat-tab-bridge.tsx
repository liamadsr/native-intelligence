'use client'

/**
 * Answers `openTeammateChatTab(teammateId, item?)` (src/lib/bots/teammate-chat-tab.ts)
 * in the dashboard: the teammate looked up in the roster (the shared source),
 * then its page opened as a card in the chat (the `bot` page kind), on the
 * item when one is asked (bots-v4.md Phase 2). A teammate the roster doesn't
 * hold (deleted, or behind a private team the user isn't on) isn't the
 * signed-in user's to open: the event is left alone, and the caller falls
 * back. Mounted once, in the dashboard shell, inside the shared source. Keeps
 * the user's avatar and initials for the page too.
 *
 * One face (always-on-agent §2c): an area face's page is the agent's, so an
 * ask for one (an old link, a notice, a deep link) opens its workspace's
 * Assistant's page instead (agent-face.ts agentTeammateIdFor).
 */
import { useEffect, useRef } from 'react'
import { useAgentWorkShared } from '@/components/work/agent-work-provider'
import { openTarget } from '@/lib/chat-cards/open-card'
import { OPEN_TEAMMATE_CHAT_EVENT, setTeammateChatUser } from '@/lib/bots/teammate-chat-tab'
import { isWorkItemId } from '@/lib/work/item-id'
import { agentTeammateIdFor } from '@/lib/bots/agent-face'

/** An item's title on the page, at most. */
const ITEM_TITLE_MAX = 120

export function TeammateChatTabBridge({ userAvatarUrl = null, userInitials = 'You' }: { userAvatarUrl?: string | null; userInitials?: string }) {
  const { work } = useAgentWorkShared()
  const roster = useRef(work.roster)
  roster.current = work.roster

  useEffect(() => {
    setTeammateChatUser({ avatarUrl: userAvatarUrl, initials: userInitials })
  }, [userAvatarUrl, userInitials])

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ teammateId?: unknown; itemId?: unknown; itemTitle?: unknown }>).detail
      const asked = detail?.teammateId
      // An area face's page is the agent's (one face).
      const teammateId = typeof asked === 'string' ? agentTeammateIdFor(roster.current, asked) : null
      const mate = teammateId ? roster.current.find((t) => t.id === teammateId) : undefined
      if (!mate) return
      // One of its items: checked, not trusted (an id that isn't a work
      // item's opens the bot's own page). The page's own reads (the item
      // route, the run chat routes) are where access is decided.
      const itemId = isWorkItemId(detail.itemId) ? detail.itemId : null
      const itemTitle =
        typeof detail.itemTitle === 'string' && detail.itemTitle.trim() ? detail.itemTitle.trim().slice(0, ITEM_TITLE_MAX) : 'Work item'
      const opened = openTarget(
        { type: 'bot', teammateId: mate.id, name: mate.name?.trim() || 'Teammate', item: itemId ? { itemId, title: itemTitle } : null },
        // One card per bot's page: the one already in the chat comes back, on the item when asked.
        { from: 'bot', reuse: true },
      )
      if (opened) event.preventDefault()
    }
    window.addEventListener(OPEN_TEAMMATE_CHAT_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_TEAMMATE_CHAT_EVENT, onOpen)
  }, [])

  return null
}
