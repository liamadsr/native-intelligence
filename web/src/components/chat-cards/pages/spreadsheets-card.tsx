'use client'

/**
 * Spreadsheets as a card: the real SpreadsheetsView, its list a card list of
 * the views system (docs/plans/views-everywhere.md), kept with the card.
 * Opened on a spreadsheet it is that workbook's editor; opening one, and Back
 * to the list, move the card the way they move a tab (./tables-card.tsx).
 */
import * as React from 'react'
import { SpreadsheetsView, type SpreadsheetsCardState } from '@/app/account/(dashboard)/views/spreadsheets-view'
import { PageCardSurface, usePageCardSurface, usePagePlace, type PageCardProps } from './page-card'

export default function SpreadsheetsCard(props: PageCardProps) {
  const place = usePagePlace(props)
  const surface = usePageCardSurface(props)
  const openId = place.at?.type === 'spreadsheet' ? place.at.id : null
  const { go } = place
  const card = React.useMemo<SpreadsheetsCardState>(
    () => ({
      openId,
      onOpen: (id, name) => go(id ? { type: 'spreadsheet', id, ...(name ? { label: name } : {}) } : null),
    }),
    [openId, go],
  )
  return (
    <PageCardSurface surface={surface}>
      <div className="h-full min-h-0">
        <SpreadsheetsView card={card} />
      </div>
    </PageCardSurface>
  )
}
