'use client'

/**
 * Tables as a card: the real TablesView, with its own fetch. It is not a
 * views-system list (that is phase 4), so there is nothing of the person's
 * to keep with the card.
 */
import * as React from 'react'
import { TablesView } from '@/app/account/(dashboard)/views/tables-view'
import type { PageCardProps } from './page-card'

export default function TablesCard({ onCount }: PageCardProps) {
  return (
    <div className="h-full min-h-0">
      <TablesView onCount={onCount} />
    </div>
  )
}
