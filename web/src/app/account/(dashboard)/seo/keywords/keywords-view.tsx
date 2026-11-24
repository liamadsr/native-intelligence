'use client'

/**
 * SEO's Keywords page: find the searches people make around a topic
 * (Research) and keep the ones worth going after (Saved). Drawn by the page
 * card (components/chat-cards/pages/seo-keywords-card.tsx), whose tabs are
 * this page's two (PAGE_KINDS.seo_keywords.tabs); it has no place.
 *
 *   Header     "Keywords" and the month's search data spend (in a card,
 *              the card's header: its title, the spend at its right). No
 *              primary button: the research field is the page's main control.
 *              In a card the header holds the research field too, while
 *              Research is in force.
 *   Tabs       Research and Saved, the page's first row, in the card's
 *              corner and outside a card alike (DETAIL_TAB_ROW; Liam, 11-23:
 *              "everything looks the same as the projects page").
 *   Research   ./research-tab.tsx
 *   Saved      ./saved-tab.tsx (always mounted, so its count is known for
 *              the tab and the card header; hidden when not in force)
 *   Results    ./serp-sheet.tsx, opened from either tab for one keyword
 *
 * The market (country, language) is the page's, remembered per browser.
 * Both tabs stay mounted while the other is shown, so a research result and
 * a selection survive a look at the other tab.
 */
import * as React from 'react'
import { DETAIL_TAB_ROW } from '@/components/views/page-tabs'
import { PageTitle } from '@/components/views/page-title'
import { seoMarketOptions } from '@/lib/seo/keywords/view'
import { ViewHeader } from '../../views/view-header'
import { SeoSpendLine, buyBlockedReason, useSeoData } from '../shared/data-status'
import { SEO_HEADER_SPEND, useInCard } from '../shared/header-controls'
import { TabPills } from '../shared/tab-pills'
import { readStoredMarket, writeStoredMarket, type Market } from './keyword-helpers'
import { ResearchTab } from './research-tab'
import { SavedTab } from './saved-tab'
import { SerpSheet, type SerpTarget } from './serp-sheet'

export const KEYWORD_TABS = ['research', 'saved'] as const
export type KeywordTab = (typeof KEYWORD_TABS)[number]

export interface KeywordsPageProps {
  /** The tab in force (PAGE_KINDS.seo_keywords.tabs). */
  tab?: string
  onTab: (tab: string) => void
  /** The card header's count: the saved keywords. */
  onCount?: (count: number | null) => void
}

export function KeywordsPage({ tab, onTab, onCount }: KeywordsPageProps) {
  const seoData = useSeoData()
  // In a card its header names the page and shows the spend line (Liam,
  // 11-22): no row of the page's own above the tabs.
  const inCard = useInCard()
  // The countries and languages are a static list from the build (what GET /api/account/seo/locations answers).
  const markets = React.useMemo(() => seoMarketOptions(), [])
  const [market, setMarket] = React.useState<Market>(() => readStoredMarket(markets))
  const [savedVersion, setSavedVersion] = React.useState(0)
  const [savedTotal, setSavedTotal] = React.useState<number | null>(null)
  const [serp, setSerp] = React.useState<SerpTarget | null>(null)
  // In a card: where the research tab draws its start control, in the header.
  const [formHost, setFormHost] = React.useState<HTMLElement | null>(null)
  const active: KeywordTab = tab === 'saved' ? 'saved' : 'research'
  const { refresh } = seoData

  const pickMarket = React.useCallback((next: Market) => {
    setMarket(next)
    writeStoredMarket(next)
  }, [])

  const reportTotal = React.useCallback(
    (total: number | null) => {
      setSavedTotal(total)
      onCount?.(total)
    },
    [onCount],
  )

  return (
    <div data-kw-page="" className="relative flex h-full min-h-0 flex-col">
      <ViewHeader
        title={<PageTitle label="Keywords" as="h1" />}
        actions={
          inCard ? (
            <>
              {active === 'research' && <span ref={setFormHost} data-kw-form-host="" className="contents" />}
              <SeoSpendLine view={seoData.view} className={SEO_HEADER_SPEND} />
            </>
          ) : (
            <SeoSpendLine view={seoData.view} />
          )
        }
      />
      <div data-seo-tab-row="" className={DETAIL_TAB_ROW}>
        <TabPills
          label="Keywords"
          value={active}
          onChange={onTab}
          tabs={[
            { id: 'research', label: 'Research' },
            { id: 'saved', label: 'Saved', count: savedTotal ?? undefined },
          ]}
        />
      </div>
      <div className="@container min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div hidden={active !== 'research'} className="mt-1">
          <ResearchTab
            header={inCard ? formHost : undefined}
            markets={markets}
            market={market}
            onMarket={pickMarket}
            view={seoData.view}
            spendLoading={seoData.loading}
            onSpent={refresh}
            onCheckResults={setSerp}
            onSaved={() => setSavedVersion((v) => v + 1)}
          />
        </div>
        <div hidden={active !== 'saved'} className="mt-1">
          <SavedTab
            market={market}
            version={savedVersion}
            blocked={buyBlockedReason(seoData.view)}
            onSpent={refresh}
            onTotal={reportTotal}
            onResearch={() => onTab('research')}
          />
        </div>
      </div>
      <SerpSheet target={serp} onClose={() => setSerp(null)} blockedReason={buyBlockedReason(seoData.view)} onSpent={refresh} />
    </div>
  )
}
