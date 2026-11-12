'use client'

/**
 * SEO's Search performance as a card: the real Search performance page,
 * what Google Search Console and Google Analytics know about how people find
 * the workspace's site. It has no place; its Queries, Pages, Opportunities
 * and Analytics are the card's tabs (PAGE_KINDS.seo_search.tabs), so the
 * header's Back walks them. The period and the filters are transient.
 */
import * as React from 'react'
import { SearchPerformancePage } from '@/app/account/(dashboard)/seo/search/search-performance-view'
import { pageTab } from '@/lib/chat-cards/pages'
import { usePagePlace, type PageCardProps } from './page-card'

export default function SeoSearchCard(props: PageCardProps) {
  const place = usePagePlace(props)
  return (
    <div className="h-full min-h-0" data-seo-search-card="">
      <SearchPerformancePage tab={pageTab('seo_search', place.tab)} onTab={place.setTab} onCount={props.onCount} />
    </div>
  )
}
