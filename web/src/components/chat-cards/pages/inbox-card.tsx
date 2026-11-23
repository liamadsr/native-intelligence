'use client'

/**
 * The inbox as a card (docs/plans/channels-inbox.md, phase 2): the real
 * InboxView, with its own reads. A record opened from it draws over it, in
 * the card (RecordOverlay), as any page card opens one; For you's count is
 * the side panel's own (useForYouEntries).
 */
import * as React from 'react'
import { InboxView } from '@/components/inbox/inbox-view'
import { useForYouEntries } from '@/app/account/(dashboard)/chat/for-you-column'
import { CardCovered } from '../card-covered'
import type { PageCardProps } from './page-card'
import { RecordOverlay, usePageRecords } from './record-overlay'

export default function InboxCard(props: PageCardProps) {
  const records = usePageRecords(props.toolCallId, props.store)
  const forYou = useForYouEntries()
  const openRecord = React.useCallback((record: Parameters<typeof records.open>[0]) => records.open(record), [records])
  return (
    <div className="relative h-full min-h-0">
      <CardCovered covered={!!records.current}>
        <InboxView forYouCount={forYou.length} onOpenRecord={openRecord} />
      </CardCovered>
      <RecordOverlay records={records} page={props} />
    </div>
  )
}
