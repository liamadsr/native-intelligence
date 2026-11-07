'use client'

/**
 * A record opened from inside a page card (an action on a team board, a
 * notification's subject) draws over the page, in the card, as its detail
 * panel: it never leaves the chat. The card header's Back returns to the page.
 * The page under it is wrapped in CardCovered (card-body.tsx), so the overlay
 * stays transparent over the card's glass.
 */
import * as React from 'react'
import { CardSurfaceContext } from '@/components/views/unified-view-layout'
import { CardRecordPanel, useOpenRecords } from '../card-body'
import { CardOverlay } from '../card-covered'
import type { ChatCardStore } from '../card-store'
import { usePageCardSurface, type PageCardProps } from './page-card'

export function usePageRecords(toolCallId: string, store: ChatCardStore) {
  return useOpenRecords(toolCallId, store)
}

/**
 * The lists inside the record (a project's actions) are card lists, so they
 * never touch the real page's saved views, but quiet: they are not the page
 * the card shows, and must not stand in for it in the agent's note.
 */
export function RecordOverlay({ records, page }: { records: ReturnType<typeof useOpenRecords>; page: PageCardProps }) {
  const quiet = usePageCardSurface(page, { quiet: true })
  if (!records.current) return null
  return (
    <CardOverlay>
      <div className="min-h-0 flex-1 overflow-hidden">
        <CardSurfaceContext.Provider value={quiet}>
          <CardRecordPanel record={records.current} onOpen={records.open} onClose={records.close} />
        </CardSurfaceContext.Provider>
      </div>
    </CardOverlay>
  )
}
