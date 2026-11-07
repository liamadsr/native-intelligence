'use client'

/**
 * Sequences as a card: the real SequencesView, the list or one sequence.
 * Opening a sequence, and Back to the list, move the card the way they move a
 * tab; the list is a card list (the card surface), so its filters stay with
 * the card.
 */
import * as React from 'react'
import { SequencesView } from '@/app/account/(dashboard)/sequences/sequences-view'
import { PageCardSurface, usePageCardSurface, usePagePlace, type PageCardProps } from './page-card'

export default function SequencesCard(props: PageCardProps) {
  const surface = usePageCardSurface(props)
  const place = usePagePlace(props)
  const sequence = place.at?.type === 'sequence' ? place.at : null
  return (
    <PageCardSurface surface={surface}>
      <div className="h-full min-h-0">
        <SequencesView
          sequenceId={sequence?.id ?? null}
          onOpenSequence={(id, name) => place.go({ type: 'sequence', id, label: name })}
          onCloseDetail={() => place.go(null)}
        />
      </div>
    </PageCardSurface>
  )
}
