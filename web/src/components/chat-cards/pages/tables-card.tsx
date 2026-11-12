'use client'

/**
 * Tables as a card: the real TablesView, with its own fetch. Opened on a
 * table (the agent's `show`, phase 5) it is that table, in the layout the
 * agent asked for (the card's tab); opened on a row, that table with the row
 * open: a row's record card. Opening a table, and Back to the list, move the
 * card the way they move a tab.
 */
import * as React from 'react'
import { TablesView, type TablesCardState } from '@/app/account/(dashboard)/views/tables-view'
import { usePagePlace, type PageCardProps } from './page-card'

export default function TablesCard(props: PageCardProps) {
  const place = usePagePlace(props)
  const at = place.at
  const openId = at?.type === 'data_table' ? at.id : at?.type === 'data_row' ? (at.in ?? null) : null
  const rowId = at?.type === 'data_row' ? at.id : null
  const { go } = place
  const card = React.useMemo<TablesCardState>(
    () => ({
      openId,
      rowId,
      layout: place.tab,
      onOpen: (id, name) => go(id ? { type: 'data_table', id, ...(name ? { label: name } : {}) } : null),
    }),
    [openId, rowId, place.tab, go],
  )
  return (
    <div className="h-full min-h-0">
      <TablesView onCount={props.onCount} card={card} />
    </div>
  )
}
