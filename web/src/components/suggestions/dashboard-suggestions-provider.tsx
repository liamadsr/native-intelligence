'use client'

/**
 * The dashboard's one suggestions store (mounted in dashboard-shell, inside
 * MainChatProvider), so a suggestion shown in a chat answer and in a document is
 * one row on screen, and a card's "open" opens its record as a card in the
 * chat.
 */
import { useCallback } from 'react'
import { openTarget } from '@/lib/chat-cards/open-card'
import { SuggestionsProvider } from './suggestions-store'

/** The suggestions' records that open as a record card. */
const OPENABLE = new Set(['action', 'project', 'contact'])

export function DashboardSuggestionsProvider({ children }: { children: React.ReactNode }) {
  const openEntity = useCallback((entityType: string, id: string, title: string) => {
    if (!OPENABLE.has(entityType)) return
    openTarget({ type: entityType as 'action' | 'project' | 'contact', id, title }, { from: 'suggestion' })
  }, [])
  return <SuggestionsProvider openEntity={openEntity}>{children}</SuggestionsProvider>
}
