'use client'

/**
 * SEO's Rankings as a card: the real Rankings page, the workspace's rank
 * trackers or one tracker. Opening a tracker, and Back, move the card (the
 * `seo_rank_tracker` place, a step the header's Back walks); the tracker's
 * Positions and History are the card's tabs (PAGE_KINDS.seo_rankings.tabs).
 * It is not a views-system list, so there is nothing of the person's to keep
 * with the card beyond where it is.
 */
import * as React from 'react'
import { RankingsPage } from '@/app/account/(dashboard)/seo/rankings/rankings-view'
import { pageTab } from '@/lib/chat-cards/pages'
import { usePagePlace, type PageCardProps } from './page-card'

export default function SeoRankingsCard(props: PageCardProps) {
  const place = usePagePlace(props)
  const tracker = place.at?.type === 'seo_rank_tracker' ? place.at : null
  return (
    <div className="h-full min-h-0" data-seo-rankings-card="">
      <RankingsPage
        trackerId={tracker?.id ?? null}
        trackerLabel={tracker?.label}
        tab={pageTab('seo_rankings', place.tab)}
        onOpenTracker={(t) => place.go({ type: 'seo_rank_tracker', id: t.id, label: t.domain })}
        onCloseTracker={() => place.go(null)}
        onTab={place.setTab}
        onCount={props.onCount}
      />
    </div>
  )
}
