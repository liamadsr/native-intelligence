'use client'

/**
 * Spreadsheets as a card: the real SpreadsheetsView, with its own fetch.
 * Opened on a spreadsheet it is that workbook's editor; opening one, and Back
 * to the list, move the card the way they move a tab (./tables-card.tsx).
 */
import * as React from 'react'
import { SpreadsheetsView, type SpreadsheetsCardState } from '@/app/account/(dashboard)/views/spreadsheets-view'
import { usePagePlace, type PageCardProps } from './page-card'

export default function SpreadsheetsCard(props: PageCardProps) {
  const place = usePagePlace(props)
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
    <div className="h-full min-h-0">
      <SpreadsheetsView onCount={props.onCount} card={card} />
    </div>
  )
}
