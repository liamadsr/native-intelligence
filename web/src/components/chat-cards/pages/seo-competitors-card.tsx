'use client'

/**
 * SEO's Competitors as a card: the real Competitors page, what any site ranks
 * for and who competes with it. The looked-up site's Overview, Keywords and
 * Competitors are the card's tabs (PAGE_KINDS.seo_competitors.tabs); the
 * page has no place, so the site on show is the page's own state (it opens
 * on the workspace's own site's stored lookup, never spending).
 */
import * as React from 'react'
import { CompetitorsPage } from '@/app/account/(dashboard)/seo/competitors/competitors-view'
import { pageTab } from '@/lib/chat-cards/pages'
import { usePagePlace, type PageCardProps } from './page-card'

export default function SeoCompetitorsCard(props: PageCardProps) {
  const place = usePagePlace(props)
  return (
    <div className="h-full min-h-0" data-seo-competitors-card="">
      <CompetitorsPage tab={pageTab('seo_competitors', place.tab)} onTab={place.setTab} onCount={props.onCount} />
    </div>
  )
}
