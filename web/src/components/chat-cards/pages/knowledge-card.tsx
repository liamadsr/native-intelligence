'use client'

/**
 * Knowledge as a card: the real KnowledgeView, on the claims. Its library is
 * a page of its own since the split (Liam, 11-21), the Library card
 * (./knowledge-library-card.tsx). Claims open on the graph; inline the map is
 * a still: the WebGL map runs in full screen only, and one card at a time
 * (./map-lease.ts).
 */
import * as React from 'react'
import { KnowledgeView } from '@/app/account/(dashboard)/views/knowledge-view'
import { PageCardSurface, usePageCardSurface, type PageCardProps } from './page-card'
import { acquireMap, mapHolder, releaseMap, subscribeMap } from './map-lease'
import { RecordOverlay, usePageRecords } from './record-overlay'
import { isRecordType } from '../card-body'
import { CardCovered } from '../card-covered'

/** May this card run the map now: full screen, and the lease is its own. */
function useMapAllowed(id: string, fullScreen: boolean): boolean {
  const holder = React.useSyncExternalStore(subscribeMap, mapHolder, () => null)
  React.useEffect(() => {
    if (!fullScreen) return
    acquireMap(id)
    return () => releaseMap(id)
  }, [id, fullScreen])
  // Free again (the holder left full screen): take it.
  React.useEffect(() => {
    if (fullScreen && holder === null) acquireMap(id)
  }, [fullScreen, holder, id])
  return fullScreen && holder === id
}

export default function KnowledgeCard(props: PageCardProps) {
  const { toolCallId, store, fullScreen } = props
  const surface = usePageCardSurface(props)
  const mapAllowed = useMapAllowed(toolCallId, fullScreen)
  const records = usePageRecords(toolCallId, store)
  const covered = !!records.current
  const card = React.useMemo(
    () => ({
      mapAllowed,
      onWantMap: () => store.enterFullScreen(toolCallId),
      // A record open over the page owns the header: the page's controls leave it.
      covered,
    }),
    [mapAllowed, store, toolCallId, covered],
  )
  return (
    <PageCardSurface surface={surface}>
      <div className="relative h-full min-h-0">
        <CardCovered covered={covered}>
          <KnowledgeView
            card={card}
            // A claim's source (a capture, a doc, a project) opens inside the card.
            onOpenEntity={(type, id, title) => {
              if (!isRecordType(type)) return false
              records.open({ type, id, label: title })
              return true
            }}
          />
        </CardCovered>
        <RecordOverlay records={records} page={props} />
      </div>
    </PageCardSurface>
  )
}
