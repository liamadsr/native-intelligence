'use client'

/**
 * Knowledge as a card: the real KnowledgeView, on the claims or the library
 * (and a package in it). Inline, claims read as a list and the map is a
 * still: the WebGL map runs in full screen only, and one card at a time
 * (./map-lease.ts). Which surface the card is on is the card's, never the
 * page's remembered choice.
 */
import * as React from 'react'
import { KnowledgeView } from '@/app/account/(dashboard)/views/knowledge-view'
import { PageCardSurface, usePageCardSurface, usePagePlace, type PageCardProps } from './page-card'
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
  const place = usePagePlace(props)
  const mapAllowed = useMapAllowed(toolCallId, fullScreen)
  const records = usePageRecords(toolCallId, store)
  const pkg = place.at?.type === 'package' ? place.at : null
  const card = React.useMemo(
    () => ({
      mode: (place.tab === 'library' ? 'library' : 'graph') as 'library' | 'graph',
      onMode: (mode: 'library' | 'graph') => place.setTab(mode === 'library' ? 'library' : 'claims'),
      mapAllowed,
      onWantMap: () => store.enterFullScreen(toolCallId),
      // A package the person opens is where the card is now (the note, read_card).
      onPackageChange: (pkg: { id: string; name?: string } | null) =>
        place.go(pkg ? { type: 'package', id: pkg.id, ...(pkg.name ? { label: pkg.name } : {}) } : null, 'library'),
    }),
    [place, mapAllowed, store, toolCallId],
  )
  return (
    <PageCardSurface surface={surface}>
      <div className="relative h-full min-h-0">
        <CardCovered covered={!!records.current}>
        <KnowledgeView
          card={card}
          initialPackageId={pkg?.id}
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
