'use client'

/**
 * A work item as a card (the `work_item` page kind): its panel, on its own.
 * Where a work item lands when it has no bot's page to open on
 * (useOpenWorkItem, bots-v4.md Phase 2): a sequence send, or a workspace with
 * no Assistant known. It used to open over the inbox card, which went with
 * the notifications page (docs/plans/retire-notifications-page.md). Only the
 * person opens one (show doesn't offer it); what the panel opens (its output,
 * its run) opens where those open, as cards of their own.
 */
import * as React from 'react'
import { WorkItemDetailPanel } from '@/components/work/work-item-detail-panel'
import { PageCardNotice, type PageCardProps } from './page-card'

export default function WorkItemCard({ spec }: PageCardProps) {
  const itemId = spec.target?.type === 'work_item' ? spec.target.id : null
  if (!itemId) return <PageCardNotice text="This work item can’t open." />
  return (
    <div className="h-full min-h-0">
      <WorkItemDetailPanel key={itemId} itemId={itemId} embedded />
    </div>
  )
}
