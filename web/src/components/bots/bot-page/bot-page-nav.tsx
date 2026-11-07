'use client'

/**
 * Where a bot's page sends a click that stays on it (one of its own items, or
 * back to its lists). The page's card provides it (pages/bot-card.tsx keeps
 * the item open with the card); the rows deep inside the page's work column
 * read it through useBotPageOpen.
 */
import { createContext, useContext } from 'react'
import type { TeammateChatItem } from '@/lib/bots/teammate-chat-tab'

export interface BotPageNav {
  /** One of the page's teammate's items on this page; null: back to its lists. */
  openItem: (item: TeammateChatItem | null) => void
}

export const BotPageNavContext = createContext<BotPageNav | null>(null)

/** The page's navigation, or null outside a bot's page. */
export function useBotPageNav(): BotPageNav | null {
  return useContext(BotPageNavContext)
}
