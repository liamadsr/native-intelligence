'use client'

/**
 * SEO's Backlinks as a card: the real Backlinks page, who links to a site or
 * a page. The looked-up site's Overview, Links, Sites and Pages are the
 * card's tabs (PAGE_KINDS.seo_backlinks.tabs: overview, links, domains,
 * pages); the page has no place, so the site on show is the page's own state
 * (it opens on the workspace's own site's stored lookup, never spending).
 */
import * as React from 'react'
import { BacklinksPage } from '@/app/account/(dashboard)/seo/backlinks/backlinks-view'
import { pageTab } from '@/lib/chat-cards/pages'
import { usePagePlace, type PageCardProps } from './page-card'

export default function SeoBacklinksCard(props: PageCardProps) {
  const place = usePagePlace(props)
  return (
    <div className="h-full min-h-0" data-seo-backlinks-card="">
      <BacklinksPage tab={pageTab('seo_backlinks', place.tab)} onTab={place.setTab} onCount={props.onCount} />
    </div>
  )
}
