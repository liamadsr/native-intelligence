'use client'

/**
 * Campaigns as a card: the real CampaignsView. Its list is a card list of the
 * views system (docs/plans/views-everywhere.md), kept with the card; the
 * editor is the page's own dialog.
 */
import * as React from 'react'
import { CampaignsView } from '@/app/account/(dashboard)/views/campaigns-view'
import { PageCardSurface, usePageCardSurface, type PageCardProps } from './page-card'

export default function CampaignsCard(props: PageCardProps) {
  const surface = usePageCardSurface(props)
  return (
    <PageCardSurface surface={surface}>
      <div className="h-full min-h-0">
        <CampaignsView />
      </div>
    </PageCardSurface>
  )
}
