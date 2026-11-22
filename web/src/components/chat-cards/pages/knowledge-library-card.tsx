'use client'

/**
 * The Library as a card (Liam, 11-21: Knowledge's library tab, its own page,
 * after Knowledge in Drive): the real KnowledgeLibrary, with the workspace
 * brief, the Review queue, Refresh briefs, the projects (each with Promote)
 * and the packages. A package open in its panel is where the card is (`at`,
 * for the note and read_card, and a step Back undoes); a package link or the
 * agent's `show` opens the card on one, and the header names it ("Library ›
 * <package>", the title the way back). No picker and no search: the Library
 * has no query behind it. The Review queue and Refresh briefs are in the
 * header (Liam, 11-22); a record open over the page has the header then
 * (CardCovered).
 */
import * as React from 'react'
import { KnowledgeLibrary } from '@/app/account/(dashboard)/views/knowledge-library'
import { PageCardSurface, usePageCardSurface, usePagePlace, type PageCardProps } from './page-card'
import { RecordOverlay, usePageRecords } from './record-overlay'
import { isRecordType } from '../card-body'
import { CardCovered } from '../card-covered'

export default function KnowledgeLibraryCard(props: PageCardProps) {
  const { toolCallId, store } = props
  const surface = usePageCardSurface(props)
  const place = usePagePlace(props)
  const records = usePageRecords(toolCallId, store)
  const pkg = place.at?.type === 'package' ? place.at : null
  const { go } = place
  const onPackageChange = React.useCallback(
    (next: { id: string; name?: string } | null) => go(next ? { type: 'package', id: next.id, ...(next.name ? { label: next.name } : {}) } : null),
    [go],
  )
  return (
    <PageCardSurface surface={surface}>
      <div className="relative h-full min-h-0">
        <CardCovered covered={!!records.current}>
          <KnowledgeLibrary
            initialPackageId={pkg?.id}
            onPackageChange={onPackageChange}
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
