'use client'

/**
 * The inbox as a card (docs/plans/channels-inbox.md, phase 2): the real
 * InboxView, on the inbox's one store (components/inbox/inbox-store.ts). A
 * record opened from it draws over it, in the card (RecordOverlay), as any
 * page card opens one; For you's count is the side panel's own
 * (useForYouEntries).
 *
 * The Inbox page's card. Full screen from `md` up with Home's panel beside
 * the rail (its Inbox side since 11-24; the Inbox panel before) (Liam, 11-23, Inbox "Like Home"; docs/plans/hub-panels.md), the
 * panel holds the filter and the list, and the card shows just the item open
 * (`covered`), or a quiet note when none is. A record the panel opens comes
 * here too (the store's `record`), this card brought in front for it.
 */
import * as React from 'react'
import { InboxView } from '@/components/inbox/inbox-view'
import { takeInboxRecord, useInbox } from '@/components/inbox/inbox-store'
import { useForYouEntries } from '@/app/account/(dashboard)/chat/for-you-column'
import { useOwnSubnavShown } from '@/app/account/(dashboard)/page-panel/subnav-on-screen'
import { useRailShown } from '@/app/account/(dashboard)/rail/rail-media'
import { CardCovered } from '../card-covered'
import type { PageCardProps } from './page-card'
import { RecordOverlay, usePageRecords } from './record-overlay'

export default function InboxCard(props: PageCardProps) {
  const { fullScreen, store, toolCallId } = props
  const records = usePageRecords(toolCallId, store)
  const forYou = useForYouEntries()
  const openRecord = React.useCallback((record: Parameters<typeof records.open>[0]) => records.open(record), [records])
  // The Inbox panel beside the rail is its filter and list (subnav-on-screen.ts): only while it is really there.
  const railShown = useRailShown()
  // Home's (Liam, 11-24): the Inbox is Home's Inbox side, so Home's panel beside it covers the list.
  const panelShown = useOwnSubnavShown('home')
  const covered = !!fullScreen && railShown && panelShown
  const show = React.useCallback(() => {
    if (store.fullScreen() !== toolCallId) store.enterFullScreen(toolCallId)
  }, [store, toolCallId])
  // A record the panel opened: over this card, which comes in front for it.
  const { record, openKey } = useInbox(false)
  React.useEffect(() => {
    if (!record) return
    takeInboxRecord()
    records.open({ type: record.type, id: record.id, label: record.label })
    show()
  }, [record, records, show])
  // An item open while a record is over the card (a step from the panel): the item, the record put away.
  const recordShown = !!records.current
  const lastOpenKey = React.useRef(openKey)
  React.useEffect(() => {
    if (openKey && openKey !== lastOpenKey.current && recordShown) records.close()
    lastOpenKey.current = openKey
  }, [openKey, recordShown, records])
  return (
    <div className="relative h-full min-h-0">
      <CardCovered covered={recordShown}>
        <InboxView forYouCount={forYou.length} onOpenRecord={openRecord} covered={covered} onBeside={show} />
      </CardCovered>
      <RecordOverlay records={records} page={props} />
    </div>
  )
}
