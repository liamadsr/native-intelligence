'use client'

/**
 * SEO's AI visibility as a card: the real AI visibility page, the
 * workspace's trackers or one tracker. Opening a tracker, and Back, move the
 * card (the `seo_ai_tracker` place, a step the header's Back walks); the
 * tracker's Results, Questions and Sources are the card's tabs
 * (PAGE_KINDS.seo_ai_visibility.tabs). It is not a views-system list, so
 * there is nothing of the person's to keep with the card beyond where it is.
 */
import * as React from 'react'
import { AiVisibilityPage } from '@/app/account/(dashboard)/seo/ai-visibility/ai-visibility-view'
import { pageTab } from '@/lib/chat-cards/pages'
import { usePagePlace, type PageCardProps } from './page-card'

export default function SeoAiVisibilityCard(props: PageCardProps) {
  const place = usePagePlace(props)
  const tracker = place.at?.type === 'seo_ai_tracker' ? place.at : null
  return (
    <div className="h-full min-h-0" data-seo-ai-visibility-card="">
      <AiVisibilityPage
        trackerId={tracker?.id ?? null}
        trackerLabel={tracker?.label}
        tab={pageTab('seo_ai_visibility', place.tab)}
        onOpenTracker={(t) => place.go({ type: 'seo_ai_tracker', id: t.id, label: t.brand_name })}
        onCloseTracker={() => place.go(null)}
        onTab={place.setTab}
        onCount={props.onCount}
      />
    </div>
  )
}
