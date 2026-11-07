'use client'

/**
 * A bot's page, opened from anywhere (bots-v2.md "Teammate chat in a tab";
 * bots-v4.md Phase 1b: the page is the bot's, its work beside its chat,
 * TeammateChatPage, lib/bots/bot-page.ts). Since P5 it opens as a card in the
 * chat (the `bot` page kind), full screen.
 *
 * `openTeammateChatTab(teammateId)` (openBotPage, the desktop overlay's Open
 * in Dial8 through desktop-open-chat.ts) is a window event the dashboard's
 * TeammateChatTabBridge answers with the roster: a teammate it holds opens as
 * a card, and the event is cancelled so the caller knows; one it doesn't hold
 * (deleted, or behind a private team) is left alone, and the caller falls
 * back.
 *
 * With an item (`openTeammateChatTab(teammateId, { itemId, title })`,
 * bots-v4.md "An item opens on its bot's page", Phase 2), the card opens on
 * that item: the item on the work side, the conversation about it beside it,
 * and its way back to the bot's lists.
 */
import { useSyncExternalStore } from 'react'

/** Asks the dashboard for a bot's page: `detail` is OpenTeammateChatDetail. Cancelled (preventDefault) once it's opened. */
export const OPEN_TEAMMATE_CHAT_EVENT = 'dial8:open-teammate-chat'

/** One of a teammate's work items, as its page opens on it: its id and its title (the item's own, for its label). */
export interface TeammateChatItem {
  itemId: string
  title: string
}

/** What the open event carries: `{ teammateId }`, and for one of its items `itemId` and `itemTitle`. */
export interface OpenTeammateChatDetail {
  teammateId: string
  itemId?: string
  itemTitle?: string
}

/**
 * Open a teammate's page (on one of its items, when given). True once the
 * dashboard opened it; false where there is no dashboard to answer, or the
 * roster doesn't hold the teammate.
 */
export function openTeammateChatTab(teammateId: string, item?: TeammateChatItem | null): boolean {
  if (typeof window === 'undefined' || !teammateId) return false
  const detail: OpenTeammateChatDetail = {
    teammateId,
    ...(item ? { itemId: item.itemId, itemTitle: item.title } : {}),
  }
  const event = new CustomEvent(OPEN_TEAMMATE_CHAT_EVENT, { detail, cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

// ── The signed-in user, for their own messages on the page ──
// The shell has the user's avatar and initials; the page renders in a card
// the shell's props don't reach, so the bridge (teammate-chat-tab-bridge.tsx)
// keeps them here. Memory only.

export interface TeammateChatUser {
  avatarUrl: string | null
  initials: string
}

const NO_USER: TeammateChatUser = Object.freeze({ avatarUrl: null, initials: 'You' })
let user: TeammateChatUser = NO_USER
const listeners = new Set<() => void>()

/** The bridge says who's signed in (their avatar and initials). */
export function setTeammateChatUser(next: TeammateChatUser): void {
  if (next.avatarUrl === user.avatarUrl && next.initials === user.initials) return
  user = next
  for (const listener of [...listeners]) listener()
}

/** The signed-in user's avatar and initials, for their messages on the page. */
export function useTeammateChatUser(): TeammateChatUser {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
    () => user,
    () => NO_USER,
  )
}
