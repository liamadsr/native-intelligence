'use client'

/**
 * SEO's Competitors page: what any site ranks for, and who competes with it.
 * Drawn by the page card (components/chat-cards/pages/seo-competitors-card.tsx),
 * which keeps the tab; the site on show is this page's own state (the page
 * has no place).
 *
 *   Start control  the site (the workspace's own prefilled), the market
 *                  (kept per device) and "Look up site": the button is the
 *                  request, and it spends unless the site was looked up in
 *                  the last 12 hours.
 *   Opening        never spends: the stored lookups are read (free) and the
 *                  newest stored overview of the workspace's own site opens,
 *                  if there is one; otherwise the first-run block, or the
 *                  Recent list of stored lookups (they reopen for free).
 *   A site         the crumb and the site, its market and when it was looked
 *                  up (Refresh buys again), the server's note when its top
 *                  keywords or pages could not be read (Refresh offered then
 *                  too), then three tabs: Overview,
 *                  Keywords and Competitors (./overview-tab.tsx,
 *                  ./keywords-tab.tsx, ./competitors-tab.tsx).
 *
 * Where lookups are off, stored lookups still open from Recent, every
 * buying control stays in place disabled with the reason in its title, and
 * an empty page shows SeoDataNotice. A 402 is a neutral banner; anything
 * else that fails is an amber banner with a retry.
 */
import * as React from 'react'
import { AlertTriangle, Swords } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { PageTitle } from '@/components/views/page-title'
import type { DomainOverview } from '@/lib/seo/domain/view'
import { describeMarket, type SeoMarketOptions } from '@/lib/seo/keywords/view'
import type { SeoLookupSummary } from '@/lib/seo/lookup-view'
import { isSeoRefusalCode, type SeoSpendView } from '@/lib/seo/spend-view'
import { ViewHeader } from '../../views/view-header'
import { SeoRequestError, errorMessage } from '../api'
import { CenteredError, CenteredLoader } from '../load-states'
import { SeoDataNotice, SeoSpendLine, buyBlockedReason, useSeoData } from '../shared/data-status'
import { PartialNote, partialNoteText } from '../shared/partial-note'
import { TabPills } from '../shared/tab-pills'
import { relativeWhen } from '../ui-helpers'
import {
  fetchMarkets,
  fetchOverview,
  fetchOwnSite,
  fetchRecentOverviews,
  fetchStoredOverview,
  paidFailure,
  type Market,
} from './api'
import { CompetitorsTab, YourSiteChip, useCompetitors } from './competitors-tab'
import { bareHost, domainLocations, initialMarket, overviewFromLookup, readStoredMarket, sameSite, siteOfLabel, writeStoredMarket } from './helpers'
import { KeywordsTab, useRankedKeywords } from './keywords-tab'
import { OverviewTab } from './overview-tab'
import { StartControl } from './start-control'

export const COMPETITOR_TABS = ['overview', 'keywords', 'competitors'] as const
type CompetitorTab = (typeof COMPETITOR_TABS)[number]

export interface CompetitorsPageProps {
  /** The card's tab (PAGE_KINDS.seo_competitors.tabs). */
  tab?: string
  onTab: (tab: string) => void
  /** The card header's count: the stored lookups, while none is open. */
  onCount?: (count: number | null) => void
}

type Refusal = NonNullable<SeoSpendView['refusal']>
interface Banner {
  kind: 'limit' | 'failed'
  message: string
}

export function CompetitorsPage({ tab, onTab, onCount }: CompetitorsPageProps) {
  const seoData = useSeoData()
  const [booted, setBooted] = React.useState(false)
  const [bootError, setBootError] = React.useState(false)
  const [recent, setRecent] = React.useState<SeoLookupSummary[]>([])
  const [ownSite, setOwnSite] = React.useState<string | null>(null)
  const [markets, setMarkets] = React.useState<SeoMarketOptions | null>(null)
  const [market, setMarketState] = React.useState<Market | null>(null)
  const [site, setSite] = React.useState('')
  const [overview, setOverview] = React.useState<DomainOverview | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [opening, setOpening] = React.useState<string | null>(null)
  const [fieldError, setFieldError] = React.useState<string | null>(null)
  const [banner, setBanner] = React.useState<Banner | null>(null)
  const [refusal, setRefusal] = React.useState<Refusal | null>(null)
  const booting = React.useRef(0)
  const asked = React.useRef(0)

  const ownHost = ownSite ? bareHost(ownSite) : null

  // What a refusal after the fact means for the page, on top of the spend read.
  const view: SeoSpendView | null = React.useMemo(() => {
    if (!refusal) return seoData.view
    const base = seoData.view ?? { spent_dollars: 0, cap_dollars: 0, resets_at: '', configured: refusal.code !== 'SEO_NOT_CONFIGURED' }
    return { ...base, can_buy: false, refusal }
  }, [seoData.view, refusal])
  const blockedReason = buyBlockedReason(view)

  const reloadRecent = React.useCallback(async () => {
    try {
      setRecent(await fetchRecentOverviews())
    } catch {
      /* the list just stays as it was */
    }
  }, [])

  const boot = React.useCallback(async () => {
    const ask = ++booting.current
    setBooted(false)
    setBootError(false)
    const [lookups, own, options] = await Promise.allSettled([fetchRecentOverviews(), fetchOwnSite(), fetchMarkets()])
    if (ask !== booting.current) return
    if (lookups.status === 'rejected') {
      setBootError(true)
      return
    }
    const ownUrl = own.status === 'fulfilled' ? own.value : null
    const opts = options.status === 'fulfilled' ? options.value : null
    const host = ownUrl ? bareHost(ownUrl) : null
    setRecent(lookups.value)
    setOwnSite(ownUrl)
    setMarkets(opts)
    setMarketState(initialMarket(opts, readStoredMarket()))
    setSite(host ?? '')
    // The own site's newest stored overview opens by itself: a free read, never a lookup.
    const stored = host ? lookups.value.find((l) => sameSite(siteOfLabel(l.label), host)) : undefined
    if (stored) {
      try {
        const detail = await fetchStoredOverview(stored.id)
        if (ask !== booting.current) return
        const opened = overviewFromLookup(detail, host)
        setOverview(opened)
        setMarketState({ location_code: opened.location_code, language_code: opened.language_code })
      } catch {
        /* the index, then: it is still in Recent */
      }
    }
    if (ask === booting.current) setBooted(true)
  }, [])

  React.useEffect(() => {
    void boot()
  }, [boot])

  React.useEffect(() => {
    onCount?.(booted && !overview ? recent.length : null)
  }, [onCount, booted, overview, recent.length])

  const setMarket = (next: Market) => {
    setMarketState(next)
    writeStoredMarket(next)
  }

  const show = (next: DomainOverview) => {
    setOverview(next)
    setSite(next.domain)
    setMarketState({ location_code: next.location_code, language_code: next.language_code })
    if (tab && tab !== 'overview') onTab('overview')
  }

  /** Lookups turned out to be off (503 / 403 after the fact): the page shows it as the spend read would. */
  const refuse = (err: unknown) => {
    const apiError = err instanceof SeoRequestError ? err.apiError : null
    const code = isSeoRefusalCode(apiError?.code) ? apiError.code : 'SEO_NOT_CONFIGURED'
    setRefusal({ code, message: apiError?.message ?? 'Search data is off' })
    seoData.refresh()
  }

  /** Look a site up: the button's request. Spends unless stored. */
  const lookUp = async (input: { domain: string; market: Market | null; refresh?: boolean }) => {
    const ask = ++asked.current
    setBusy(true)
    setFieldError(null)
    setBanner(null)
    const own = !!ownHost && bareHost(input.domain) === ownHost
    try {
      const next = await fetchOverview({ domain: own ? null : input.domain.trim(), market: input.market, refresh: input.refresh })
      if (ask !== asked.current) return
      if (!next.from_cache) seoData.refresh()
      show(next)
      void reloadRecent()
    } catch (err) {
      if (ask !== asked.current) return
      const failure = paidFailure(err)
      if (failure === 'limit') setBanner({ kind: 'limit', message: errorMessage(err) })
      else if (failure === 'off') refuse(err)
      else if (failure === 'field') setFieldError(errorMessage(err))
      else setBanner({ kind: 'failed', message: errorMessage(err, 'Could not look up the site.') })
    } finally {
      if (ask === asked.current) setBusy(false)
    }
  }

  const openRecent = async (lookup: SeoLookupSummary) => {
    setOpening(lookup.id)
    setBanner(null)
    setFieldError(null)
    try {
      show(overviewFromLookup(await fetchStoredOverview(lookup.id), ownHost))
    } catch (err) {
      toast.error('Could not open that lookup', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setOpening(null)
    }
  }

  const back = () => {
    asked.current++
    setBusy(false)
    setOverview(null)
    setBanner(null)
    setFieldError(null)
    setSite(ownHost ?? '')
    void reloadRecent()
  }

  const isOwn = !!overview && (overview.is_own_site || (!!ownHost && sameSite(overview.domain, ownHost)))

  const header = (
    <ViewHeader
      className="gap-3"
      title={
        overview ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <PageTitle label="Competitors" onClick={back} />
            <h1 data-seo-site-title="" className="min-w-0 truncate text-sm font-semibold" title={overview.domain}>
              {overview.domain}
            </h1>
            {isOwn && <YourSiteChip />}
          </div>
        ) : (
          <PageTitle label="Competitors" as="h1" />
        )
      }
      actions={<SeoSpendLine view={view} />}
    />
  )

  if (!booted) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        {bootError ? <CenteredError text="Could not load your site lookups." onRetry={() => void boot()} /> : <CenteredLoader />}
      </div>
    )
  }

  const locations = domainLocations(markets)
  const activeTab: CompetitorTab = tab && (COMPETITOR_TABS as readonly string[]).includes(tab) ? (tab as CompetitorTab) : 'overview'
  return (
    <div data-seo-competitors-page="" data-seo-state={overview ? 'site' : 'index'} className="flex h-full min-h-0 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="max-w-3xl">
          <StartControl
            site={site}
            onSite={(next) => {
              setSite(next)
              if (fieldError) setFieldError(null)
            }}
            market={market}
            onMarket={setMarket}
            locations={locations}
            busy={busy}
            blockedReason={blockedReason}
            error={fieldError}
            onSubmit={() => void lookUp({ domain: site, market })}
          />
          {banner?.kind === 'limit' && (
            <p data-seo-limit="" className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              {banner.message}
            </p>
          )}
          {banner?.kind === 'failed' && (
            <div data-seo-failed="" className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
              <p className="min-w-0 flex-1">{banner.message}</p>
              <Button variant="ghost" size="sm" className="-my-1 h-7 shrink-0 text-xs" disabled={busy || !site.trim()} onClick={() => void lookUp({ domain: site, market })}>
                Try again
              </Button>
            </div>
          )}
        </div>

        {overview ? (
          <SiteResult
            key={`${overview.domain}|${overview.location_code}|${overview.language_code}|${overview.fetched_at}`}
            overview={overview}
            tab={activeTab}
            onTab={onTab}
            busy={busy}
            blockedReason={blockedReason}
            onRefresh={() =>
              void lookUp({ domain: overview.domain, market: { location_code: overview.location_code, language_code: overview.language_code }, refresh: true })
            }
            onLookUp={(domain) => {
              setSite(domain)
              void lookUp({ domain, market: { location_code: overview.location_code, language_code: overview.language_code } })
            }}
            onSpent={seoData.refresh}
            onOff={refuse}
          />
        ) : recent.length > 0 ? (
          <RecentList lookups={recent} ownHost={ownHost} opening={opening} onOpen={(l) => void openRecent(l)} />
        ) : view && !view.can_buy ? (
          <SeoDataNotice view={view} what="Site data" />
        ) : (
          <FirstRun />
        )}
      </div>
    </div>
  )
}

function FirstRun() {
  return (
    <div data-seo-first-run="" className="mx-auto flex max-w-lg flex-col items-center gap-3 px-1 py-16 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Swords className="h-4 w-4" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">See what any site ranks for</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Type your site or a competitor’s and see which Google searches bring it visitors, which of its pages do the work,
          and who else shows up for the same searches. Each lookup is bought from a search data provider; asked again within
          12 hours, it’s free.
        </p>
      </div>
    </div>
  )
}

/** Past lookups (stored copies): each reopens for free. */
function RecentList({
  lookups,
  ownHost,
  opening,
  onOpen,
}: {
  lookups: readonly SeoLookupSummary[]
  ownHost: string | null
  opening: string | null
  onOpen: (lookup: SeoLookupSummary) => void
}) {
  return (
    <section data-seo-recent="" className="mt-6">
      <h2 className="text-[11px] font-medium text-muted-foreground">Recent</h2>
      <ul className="mt-1 divide-y divide-border">
        {lookups.map((lookup) => {
          const [name, ...rest] = (lookup.label ?? '').split(' · ')
          const when = relativeWhen(lookup.fetched_at)
          const own = !!ownHost && sameSite(name, ownHost)
          return (
            <li key={lookup.id} data-seo-recent-row={lookup.id}>
              <button
                type="button"
                disabled={opening !== null}
                onClick={() => onOpen(lookup)}
                title={`Open what was looked up for ${name || 'this site'}`}
                className="group flex w-full items-center gap-3 py-2 text-left disabled:cursor-wait"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground group-hover:underline">{name || 'A site'}</span>
                    {own && <YourSiteChip />}
                  </span>
                  <span className="block truncate text-xs tabular-nums text-muted-foreground">{[rest.join(' · ') || null, when || null].filter(Boolean).join(' · ')}</span>
                </span>
                {opening === lookup.id && <span className="shrink-0 text-xs text-muted-foreground">Opening…</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function SiteResult({
  overview,
  tab,
  onTab,
  busy,
  blockedReason,
  onRefresh,
  onLookUp,
  onSpent,
  onOff,
}: {
  overview: DomainOverview
  tab: CompetitorTab
  onTab: (tab: string) => void
  busy: boolean
  blockedReason: string | null
  onRefresh: () => void
  onLookUp: (domain: string) => void
  onSpent: () => void
  onOff: (err: unknown) => void
}) {
  const keywords = useRankedKeywords(overview, { canBuy: !blockedReason, onSpent, onOff })
  const competitors = useCompetitors(overview, { onSpent, onOff })
  const when = relativeWhen(overview.fetched_at)
  return (
    <div data-seo-site={overview.domain} className="mt-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p data-seo-looked-up="" className="text-xs tabular-nums text-muted-foreground">
          {[describeMarket(overview.location_code, overview.language_code), when ? `Looked up ${when}` : null].filter(Boolean).join(' · ')}
        </p>
        {(overview.from_cache || !!partialNoteText(overview.partial)) && (
          <Button
            variant="ghost"
            size="sm"
            data-seo-refresh=""
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            disabled={busy || !!blockedReason}
            title={blockedReason ?? 'Look the site up again with fresh data: a small charge'}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        )}
      </div>
      <PartialNote partial={overview.partial} className="mt-1" />
      {overview.has_data ? (
        <>
          <TabPills
            label="Site"
            className="mt-3"
            value={tab}
            onChange={onTab}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'keywords', label: 'Keywords', count: overview.organic_keywords ?? undefined },
              { id: 'competitors', label: 'Competitors', count: competitors.result ? competitors.result.rows.length : undefined },
            ]}
          />
          <div className="mt-4">
            {tab === 'keywords' ? (
              <KeywordsTab state={keywords} blockedReason={blockedReason} />
            ) : tab === 'competitors' ? (
              <CompetitorsTab state={competitors} overview={overview} blockedReason={blockedReason} onLookUp={onLookUp} />
            ) : (
              <OverviewTab overview={overview} onSeeKeywords={() => onTab('keywords')} />
            )}
          </div>
        </>
      ) : (
        <OverviewTab overview={overview} onSeeKeywords={() => onTab('keywords')} />
      )}
    </div>
  )
}
