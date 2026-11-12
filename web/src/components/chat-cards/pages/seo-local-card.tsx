'use client'

/**
 * SEO's Local as a card: the real Local page, the businesses the workspace
 * follows on Google Maps or one business. Opening a business, and Back, move
 * the card (the `seo_local_business` place, a step the header's Back walks);
 * the business's Map rankings, Profile and Reviews are the card's tabs
 * (PAGE_KINDS.seo_local.tabs). It is not a views-system list, so there is
 * nothing of the person's to keep with the card beyond where it is.
 */
import * as React from 'react'
import { LocalPage } from '@/app/account/(dashboard)/seo/local/local-view'
import { pageTab } from '@/lib/chat-cards/pages'
import { usePagePlace, type PageCardProps } from './page-card'

export default function SeoLocalCard(props: PageCardProps) {
  const place = usePagePlace(props)
  const business = place.at?.type === 'seo_local_business' ? place.at : null
  return (
    <div className="h-full min-h-0" data-seo-local-card="">
      <LocalPage
        businessId={business?.id ?? null}
        businessLabel={business?.label}
        tab={pageTab('seo_local', place.tab)}
        onOpenBusiness={(b) => place.go({ type: 'seo_local_business', id: b.id, label: b.title })}
        onCloseBusiness={() => place.go(null)}
        onTab={place.setTab}
        onCount={props.onCount}
      />
    </div>
  )
}
