'use client'

/**
 * SEO's Keywords page as a card: the real page, its Research and Saved as
 * the card's tabs (PAGE_KINDS.seo_keywords.tabs; a tab is a step the
 * header's Back walks). It has no place: what is typed, the result on show
 * and the filters are the page's own, and the card header counts the saved
 * keywords.
 */
import * as React from 'react'
import { KeywordsPage } from '@/app/account/(dashboard)/seo/keywords/keywords-view'
import { pageTab } from '@/lib/chat-cards/pages'
import { usePagePlace, type PageCardProps } from './page-card'

export default function SeoKeywordsCard(props: PageCardProps) {
  const place = usePagePlace(props)
  return (
    <div className="h-full min-h-0" data-seo-keywords-card="">
      <KeywordsPage tab={pageTab('seo_keywords', place.tab)} onTab={place.setTab} onCount={props.onCount} />
    </div>
  )
}
