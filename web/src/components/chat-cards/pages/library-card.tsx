'use client'

/**
 * Agents & skills as a card: the real AgentsView (the Library), on agents or
 * skills, opening on one item when the agent named it. The type it is on is
 * the card's (its tab), never the page's remembered choice. An item opens in
 * the page's own dialog, as on the page.
 */
import * as React from 'react'
import { AgentsView } from '@/app/account/(dashboard)/views/agents-view'
import { usePagePlace, type PageCardProps } from './page-card'

export default function LibraryCard(props: PageCardProps) {
  const place = usePagePlace(props)
  const at = place.at
  const item = at && (at.type === 'agent' || at.type === 'skill') ? { id: at.id, type: at.type as 'agent' | 'skill' } : null
  const type = place.tab === 'skills' ? 'skill' : 'agent'
  const card = React.useMemo(
    () => ({ type: type as 'agent' | 'skill', onType: (next: 'agent' | 'skill') => place.setTab(next === 'skill' ? 'skills' : 'agents') }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setTab is stable
    [type],
  )
  return (
    <div className="h-full min-h-0">
      <AgentsView card={card} initialItemId={item?.id} initialItemCategory={item?.type} />
    </div>
  )
}
