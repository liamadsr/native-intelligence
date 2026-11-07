'use client'

/**
 * Campaigns as a card: the real CampaignsView, with its own fetch. It is not
 * a views-system list, so there is nothing of the person's to keep with the
 * card; the editor is the page's own dialog.
 */
import * as React from 'react'
import { CampaignsView } from '@/app/account/(dashboard)/views/campaigns-view'
import type { PageCardProps } from './page-card'

export default function CampaignsCard({ onCount }: PageCardProps) {
  return (
    <div className="h-full min-h-0">
      <CampaignsView onCount={onCount} />
    </div>
  )
}
