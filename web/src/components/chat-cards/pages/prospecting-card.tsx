'use client'

/**
 * Prospecting as a card: the real ProspectingView, the lists or one list's
 * entries. Opening a list, and Back, move the card; both lists are card lists
 * (the entries keep their stage tabs).
 *
 * The list page's rows state their intents (save, dismiss, find people) as
 * events. The card gives its subtree its own target for them, so a save
 * pressed in the card is handled by the card's list page alone, and the real
 * page showing the same list never saves it a second time. The same flag
 * keeps the card's list page out of the page's module stores (the Sequenced
 * chips, the selection Scout reads).
 */
import * as React from 'react'
import { ProspectingView } from '@/app/account/(dashboard)/prospecting/prospecting-view'
import { ProspectEntryActionTargetContext } from '@/components/views/list/entity-row'
import { PageCardSurface, usePageCardSurface, usePagePlace, type PageCardProps } from './page-card'

export default function ProspectingCard(props: PageCardProps) {
  const surface = usePageCardSurface(props)
  const place = usePagePlace(props)
  const [actionTarget] = React.useState(() => new EventTarget())
  const list = place.at?.type === 'prospect_list' ? place.at : null
  return (
    <ProspectEntryActionTargetContext.Provider value={actionTarget}>
      <PageCardSurface surface={surface}>
        <div className="h-full min-h-0">
          <ProspectingView
            listId={list?.id ?? null}
            onOpenList={(id, name) => place.go({ type: 'prospect_list', id, label: name })}
            onCloseDetail={() => place.go(null)}
          />
        </div>
      </PageCardSurface>
    </ProspectEntryActionTargetContext.Provider>
  )
}
