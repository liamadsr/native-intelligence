'use client'

/**
 * SEO's Backlinks page: who links to a site or a page. Drawn by the page
 * card (components/chat-cards/pages/seo-backlinks-card.tsx), which keeps the
 * tab; the site on show is this page's own state (the page has no place).
 *
 *   Start control  the site or page (the workspace's own site prefilled) and
 *                  "Look up links": the button is the request, and it spends
 *                  unless that site was looked up in the last 12 hours.
 *   Opening        never spends: the stored lookups are read (free) and the
 *                  newest stored overview of the workspace's own site opens,
 *                  if there is one; otherwise the first-run block, or the
 *                  Recent list of stored lookups (they reopen for free).
 *   A site         the crumb and the site, when it was looked up (Refresh
 *                  buys again) and what the numbers leave out (the scope
 *                  note), then four tabs: Overview (./overview-tab.tsx), and
 *                  Links, Sites and Pages (./profile-lists.tsx), which each
 *                  wait for their own "Load …" button since every page of
 *                  them is bought.
 *
 * Where lookups are off, stored lookups still open from Recent, every buying
 * control stays in place disabled with the reason in its title, and an empty
 * page shows SeoDataNotice. A 402 is a neutral banner; anything else that
 * fails is an amber banner with a retry.
 */
import * as React from 'react'
import { AlertTriangle, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { PageTitle } from '@/components/views/page-title'
import type { BacklinksOverview } from '@/lib/seo/backlinks/view'
import type { SeoLookupSummary } from '@/lib/seo/lookup-view'
import { isSeoRefusalCode, type SeoSpendView } from '@/lib/seo/spend-view'
import { ViewHeader } from '../../views/view-header'
import { SeoRequestError, errorMessage } from '../api'
import { CenteredError, CenteredLoader } from '../load-states'
import { SeoDataNotice, SeoSpendLine, buyBlockedReason, useSeoData } from '../shared/data-status'
import { TabPills } from '../shared/tab-pills'
import { relativeWhen } from '../ui-helpers'
import { fetchOverview, fetchOwnSite, fetchRecentOverviews, fetchStoredOverview, paidFailure, type BacklinksTarget } from './api'
import { bareHost, hasPagePath, overviewFromLookup, ownSiteLookup, sameSite, siteOfLabel } from './helpers'
import { OverviewTab } from './overview-tab'
import { LinksList, PagesList, SitesList } from './profile-lists'
import { StartControl, type PageScope } from './start-control'
import { useProfile } from './use-profile'

export const BACKLINK_TABS = ['overview', 'links', 'domains', 'pages'] as const
type BacklinkTab = (typeof BACKLINK_TABS)[number]

export interface BacklinksPageProps {
  /** The card's tab (PAGE_KINDS.seo_backlinks.tabs). */
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

export function BacklinksPage({ tab, onTab, onCount }: BacklinksPageProps) {
  const seoData = useSeoData()
  const [booted, setBooted] = React.useState(false)
  const [bootError, setBootError] = React.useState(false)
  const [recent, setRecent] = React.useState<SeoLookupSummary[]>([])
  const [ownSite, setOwnSite] = React.useState<string | null>(null)
  const [site, setSite] = React.useState('')
  const [pageScope, setPageScope] = React.useState<PageScope>('exact_url')
  const [overview, setOverview] = React.useState<BacklinksOverview | null>(null)
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
    const [lookups, own] = await Promise.allSettled([fetchRecentOverviews(), fetchOwnSite()])
    if (ask !== booting.current) return
    if (lookups.status === 'rejected') {
      setBootError(true)
      return
    }
    const ownUrl = own.status === 'fulfilled' ? own.value : null
    const host = ownUrl ? bareHost(ownUrl) : null
    setRecent(lookups.value)
    setOwnSite(ownUrl)
    setSite(host ?? '')
    // The own site's newest stored overview opens by itself: a free read, never a lookup.
    const stored = ownSiteLookup(lookups.value, host)
    if (stored) {
      try {
        const detail = await fetchStoredOverview(stored.id)
        if (ask !== booting.current) return
        setOverview(overviewFromLookup(detail))
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

  const show = (next: BacklinksOverview) => {
    setOverview(next)
    setSite(next.display_target)
    if (next.scope === 'exact_url' || next.scope === 'subfolder') setPageScope(next.scope)
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
  const lookUp = async (input: BacklinksTarget & { refresh?: boolean }) => {
    const ask = ++asked.current
    setFieldError(null)
    setBanner(null)
    setBusy(true)
    try {
      const next = await fetchOverview(input)
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
      else setBanner({ kind: 'failed', message: errorMessage(err, 'Could not look up the links.') })
    } finally {
      if (ask === asked.current) setBusy(false)
    }
  }

  const hasPath = hasPagePath(site)
  /** The start control's press: the typed address, and how far it reaches when it names a page. */
  const submit = () => {
    if (!site.trim()) return
    void lookUp({ target: site.trim(), scope: hasPath ? pageScope : undefined })
  }

  const openRecent = async (lookup: SeoLookupSummary) => {
    setOpening(lookup.id)
    setBanner(null)
    setFieldError(null)
    try {
      show(overviewFromLookup(await fetchStoredOverview(lookup.id)))
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

  const isOwn = !!overview && (overview.scope === 'domain' || overview.scope === 'subdomains') && !!ownHost && sameSite(overview.display_target, ownHost)

  const header = (
    <ViewHeader
      className="gap-3"
      title={
        overview ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <PageTitle label="Backlinks" onClick={back} />
            <h1 data-seo-target-title="" className="min-w-0 truncate text-sm font-semibold" title={overview.display_target}>
              {overview.display_target}
            </h1>
            {isOwn && <YourSiteChip />}
          </div>
        ) : (
          <PageTitle label="Backlinks" as="h1" />
        )
      }
      actions={<SeoSpendLine view={view} />}
    />
  )

  if (!booted) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        {bootError ? <CenteredError text="Could not load your backlink lookups." onRetry={() => void boot()} /> : <CenteredLoader />}
      </div>
    )
  }

  const activeTab: BacklinkTab = tab && (BACKLINK_TABS as readonly string[]).includes(tab) ? (tab as BacklinkTab) : 'overview'
  return (
    <div data-seo-backlinks-page="" data-seo-state={overview ? 'site' : 'index'} className="flex h-full min-h-0 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="max-w-3xl">
          <StartControl
            site={site}
            onSite={(next) => {
              setSite(next)
              if (fieldError) setFieldError(null)
            }}
            hasPath={hasPath}
            pageScope={pageScope}
            onPageScope={setPageScope}
            busy={busy}
            blockedReason={blockedReason}
            error={fieldError}
            onSubmit={submit}
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
              <Button variant="ghost" size="sm" className="-my-1 h-7 shrink-0 text-xs" disabled={busy || !site.trim() || !!blockedReason} onClick={submit}>
                Try again
              </Button>
            </div>
          )}
        </div>

        {overview ? (
          <SiteResult
            key={`${overview.scope}|${overview.display_target}|${overview.fetched_at}`}
            overview={overview}
            own={isOwn}
            tab={activeTab}
            onTab={onTab}
            busy={busy}
            blockedReason={blockedReason}
            onRefresh={() => void lookUp({ target: overview.display_target, scope: overview.scope, refresh: true })}
            onSpent={seoData.refresh}
            onOff={refuse}
          />
        ) : recent.length > 0 ? (
          <RecentList lookups={recent} ownHost={ownHost} opening={opening} onOpen={(l) => void openRecent(l)} />
        ) : view && !view.can_buy ? (
          <SeoDataNotice view={view} what="Backlink data" />
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
        <Link2 className="h-4 w-4" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">See who links to your site</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Links from other sites are one of the main things search engines weigh. This shows how many sites link to you,
          which ones, and which of your pages they point at. It works for a competitor’s site too. Each lookup is bought from
          a search data provider; asked again within 12 hours, it’s free.
        </p>
      </div>
    </div>
  )
}

/** The workspace's own site, marked where it shows. */
function YourSiteChip() {
  return (
    <span data-seo-own-chip="" className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      Your site
    </span>
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
          const name = siteOfLabel(lookup.label)
          const when = relativeWhen(lookup.fetched_at)
          const own = !!ownHost && !name.includes('/') && sameSite(name, ownHost)
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
                  <span className="block truncate text-xs tabular-nums text-muted-foreground">{when}</span>
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
  own,
  tab,
  onTab,
  busy,
  blockedReason,
  onRefresh,
  onSpent,
  onOff,
}: {
  overview: BacklinksOverview
  own: boolean
  tab: BacklinkTab
  onTab: (tab: string) => void
  busy: boolean
  blockedReason: string | null
  onRefresh: () => void
  onSpent: () => void
  onOff: (err: unknown) => void
}) {
  const deps = { canBuy: !blockedReason, onSpent, onOff }
  const links = useProfile('backlinks', overview, deps)
  const sites = useProfile('domains', overview, deps)
  const pages = useProfile('pages', overview, deps)
  const when = relativeWhen(overview.fetched_at)
  const s = overview.summary
  const seeLinks = (domain: string) => {
    links.change({ domainFrom: domain })
    onTab('links')
  }
  return (
    <div data-seo-target={overview.display_target} className="mt-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p data-seo-looked-up="" className="text-xs tabular-nums text-muted-foreground">
          {when ? `Looked up ${when}` : 'Looked up'}
        </p>
        {overview.from_cache && (
          <Button
            variant="ghost"
            size="sm"
            data-seo-refresh=""
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            disabled={busy || !!blockedReason}
            title={blockedReason ?? 'Look the links up again with fresh data: a small charge'}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        )}
      </div>
      {overview.scope_note && (
        <p data-seo-scope-note="" className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          {overview.scope_note}
        </p>
      )}
      <TabPills
        label="Backlinks"
        className="mt-3"
        value={tab}
        onChange={onTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'links', label: 'Links', count: s.backlinks ?? undefined },
          { id: 'domains', label: 'Sites', count: s.referring_domains ?? undefined },
          { id: 'pages', label: 'Pages' },
        ]}
      />
      <div className="mt-4">
        {tab === 'links' ? (
          <LinksList state={links} blockedReason={blockedReason} />
        ) : tab === 'domains' ? (
          <SitesList state={sites} blockedReason={blockedReason} folder={overview.scope === 'subfolder'} onSeeLinks={seeLinks} />
        ) : tab === 'pages' ? (
          <PagesList state={pages} blockedReason={blockedReason} />
        ) : (
          <OverviewTab overview={overview} own={own} />
        )}
      </div>
    </div>
  )
}
