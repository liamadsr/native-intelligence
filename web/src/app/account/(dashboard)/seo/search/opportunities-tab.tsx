'use client'

/**
 * The Opportunities tab: where a little work would bring more people from
 * Google, read from Search Console (and Google Analytics when it is chosen):
 *
 *   Almost on page one           searches whose best page ranks 5 to 20
 *   Shown often, clicked rarely  searches clicked well under the site's own
 *                                usual rate at that position
 *   Pages worth improving        pages ranking 4 to 20, scored with what
 *                                their search visitors did (Analytics only;
 *                                without it, one quiet line pointing there)
 *
 * An empty list is hidden; with all of them empty, one quiet line.
 * Reads: POST /api/account/seo/google/search-console/opportunities for the
 * header's period, with a request counter.
 */
import * as React from 'react'
import { BarChart3, CircleCheck, Loader2 } from 'lucide-react'
import type { SearchOpportunities } from '@/lib/seo/google/view'
import { cn } from '@/lib/utils'
import { pathOf } from '../ui-helpers'
import { fetchOpportunities, isSetupGone } from './api'
import { percent, periodDates, position, whole, type SearchPeriod } from './helpers'
import { ReadError, type ConnectFn } from './setup'

const LIMIT = 25

export function OpportunitiesTab({
  period,
  connecting,
  onConnect,
  onChooseSite,
  onSetupGone,
  onOpenAnalytics,
}: {
  period: SearchPeriod
  connecting: boolean
  onConnect: ConnectFn
  onChooseSite: () => void
  onSetupGone: () => void
  onOpenAnalytics: () => void
}) {
  const [data, setData] = React.useState<SearchOpportunities | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failure, setFailure] = React.useState<unknown>(null)
  const asked = React.useRef(0)

  const load = React.useCallback(async () => {
    const ask = ++asked.current
    setLoading(true)
    setFailure(null)
    try {
      const out = await fetchOpportunities({ ...periodDates(period, 'search_console'), limit: LIMIT })
      if (ask === asked.current) setData(out)
    } catch (err) {
      if (ask !== asked.current) return
      if (isSetupGone(err)) onSetupGone()
      else setFailure(err)
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [period, onSetupGone])

  React.useEffect(() => {
    void load()
  }, [load])

  if (failure && !loading) {
    return (
      <ReadError
        err={failure}
        product="search_console"
        what="your opportunities"
        connecting={connecting}
        onConnect={onConnect}
        onChoose={onChooseSite}
        onRetry={() => void load()}
      />
    )
  }
  if (!data) {
    return (
      <div data-seo-loading="" className="flex justify-center py-16">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const pages = data.pages?.rows ?? []
  const nothing = data.striking_distance.length === 0 && data.low_ctr.length === 0 && pages.length === 0
  const analyticsMissing = data.pages_unavailable && (data.pages_unavailable.code === 'NOT_CONNECTED' || data.pages_unavailable.code === 'NO_SOURCE')

  return (
    <div data-seo-search-opportunities="" className={cn('@container space-y-6 transition-opacity', loading && 'opacity-60')}>
      {nothing ? (
        <div data-seo-search-nothing="" className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <CircleCheck className="h-7 w-7 text-muted-foreground/60" aria-hidden />
          <div>
            <p className="text-sm font-medium text-foreground">Nothing stands out right now</p>
            <p className="mt-1 text-sm text-muted-foreground">No searches are just short of page one, or clicked less than usual, in this period.</p>
          </div>
        </div>
      ) : null}

      {data.striking_distance.length > 0 && (
        <Section
          id="striking"
          title="Almost on page one"
          caption="Searches where your site shows just below the first page, at positions 5 to 20. A small improvement to the page can lift them onto it."
          header={['Search', 'Position', 'Impressions']}
          grid="grid-cols-[minmax(0,1fr)_4rem_5.5rem]"
        >
          {data.striking_distance.map((r) => (
            <li key={`${r.query}\0${r.page}`} data-seo-search-striking={r.query} className="grid grid-cols-[minmax(0,1fr)_4rem_5.5rem] items-start gap-2 rounded-md px-1 py-1 hover:bg-muted/40">
              <span className="min-w-0">
                <span className="block truncate text-xs text-foreground" title={r.query}>
                  {r.query}
                </span>
                <PageLink url={r.page} />
              </span>
              <span className="pt-px text-right text-xs tabular-nums text-foreground">{position(r.position)}</span>
              <span className="pt-px text-right text-xs tabular-nums text-muted-foreground">{whole(r.impressions)}</span>
            </li>
          ))}
        </Section>
      )}

      {data.low_ctr.length > 0 && (
        <Section
          id="low-ctr"
          title="Shown often, clicked rarely"
          caption="Searches where people see your site but click it less than they usually do at that position. A clearer title and description in the results often helps."
          header={['Search', 'Position', 'Impressions', 'Click rate']}
          grid="grid-cols-[minmax(0,1fr)_4rem_6.5rem] @lg:grid-cols-[minmax(0,1fr)_4rem_5.5rem_6.5rem]"
          wideOnly={[2]}
        >
          {data.low_ctr.map((r) => (
            <li
              key={`${r.query}\0${r.page}`}
              data-seo-search-low-ctr={r.query}
              className="grid grid-cols-[minmax(0,1fr)_4rem_6.5rem] items-start gap-2 rounded-md px-1 py-1 hover:bg-muted/40 @lg:grid-cols-[minmax(0,1fr)_4rem_5.5rem_6.5rem]"
            >
              <span className="min-w-0">
                <span className="block truncate text-xs text-foreground" title={r.query}>
                  {r.query}
                </span>
                <PageLink url={r.page} />
              </span>
              <span className="pt-px text-right text-xs tabular-nums text-foreground">{position(r.position)}</span>
              <span className="hidden pt-px text-right text-xs tabular-nums text-muted-foreground @lg:block">{whole(r.impressions)}</span>
              <span
                className="pt-px text-right text-xs tabular-nums"
                title={`Your site’s usual click rate at this position is ${percent(r.expected_ctr)}: about ${whole(r.missed_clicks)} more clicks at that rate`}
              >
                <span className="text-foreground">{percent(r.ctr)}</span>
                <span className="block text-[11px] text-muted-foreground">usually {percent(r.expected_ctr)}</span>
              </span>
            </li>
          ))}
        </Section>
      )}

      {pages.length > 0 && data.pages && (
        <Section
          id="pages"
          title="Pages worth improving"
          caption={
            'Pages just off the top of the results whose search visitors stay and act. Scored 0 to 100 from how often they show, what their visitors did, and how close they are to the top.' +
            (data.pages.scoring.score_data_limited ? ' Google is still processing some of this. A missing row is unknown, not zero.' : '')
          }
          header={['Page', 'Score', 'Position', 'Clicks', 'Visits']}
          grid="grid-cols-[minmax(0,1fr)_3.5rem_4rem] @lg:grid-cols-[minmax(0,1fr)_3.5rem_4rem_4rem_4rem]"
          wideOnly={[3, 4]}
        >
          {pages.map((p) => (
            <li
              key={p.page}
              data-seo-search-page-opportunity={p.page}
              className="grid grid-cols-[minmax(0,1fr)_3.5rem_4rem] items-start gap-2 rounded-md px-1 py-1 hover:bg-muted/40 @lg:grid-cols-[minmax(0,1fr)_3.5rem_4rem_4rem_4rem]"
            >
              <a href={p.page} target="_blank" rel="noreferrer noopener" title={p.page} className="min-w-0 truncate text-xs text-foreground underline-offset-2 hover:underline">
                {pathOf(p.page)}
              </a>
              <span
                className={cn('pt-px text-right text-xs tabular-nums', p.score === null ? 'text-muted-foreground' : 'font-medium text-foreground')}
                title={p.score === null ? 'Google Analytics has no visits for this page: not scored' : p.score_components ? `Demand ${Math.round(p.score_components.demand)} · value ${Math.round(p.score_components.business_value)} · reach ${Math.round(p.score_components.reachability)}` : undefined}
              >
                {p.score === null ? '—' : Math.round(p.score)}
              </span>
              <span className="pt-px text-right text-xs tabular-nums text-muted-foreground">{position(p.position)}</span>
              <span className="hidden pt-px text-right text-xs tabular-nums text-muted-foreground @lg:block">{whole(p.clicks)}</span>
              <span className="hidden pt-px text-right text-xs tabular-nums text-muted-foreground @lg:block" title={p.analytics ? undefined : 'No Google Analytics row for this page'}>
                {p.analytics ? whole(p.analytics.sessions) : '—'}
              </span>
            </li>
          ))}
        </Section>
      )}

      {data.pages_unavailable && (
        <div data-seo-search-pages-unavailable="" className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <BarChart3 className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            {analyticsMissing
              ? 'Google Analytics adds a third list here: the pages worth improving, scored by what their visitors did.'
              : data.pages_unavailable.message}
          </p>
          <button type="button" data-seo-search-open-analytics="" onClick={onOpenAnalytics} className="-my-1 h-7 shrink-0 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">
            Go to Analytics
          </button>
        </div>
      )}

      {data.query_rows_truncated && !nothing && (
        <p className="text-[11px] text-muted-foreground">Read from your top {whole(data.query_rows_considered)} searches and pages.</p>
      )}
    </div>
  )
}

function PageLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" title={url} className="block truncate text-[11px] text-muted-foreground underline-offset-2 hover:underline">
      {pathOf(url)}
    </a>
  )
}

function Section({
  id,
  title,
  caption,
  header,
  grid,
  wideOnly = [],
  children,
}: {
  id: string
  title: string
  caption: string
  header: string[]
  /** The rows' grid columns (the header uses the same). */
  grid: string
  /** Header columns shown only on a wider card (the rows drop the same cells). */
  wideOnly?: number[]
  children: React.ReactNode
}) {
  return (
    <section data-seo-search-section={id}>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{caption}</p>
      <div aria-hidden className={cn('mt-2 grid items-start gap-2 px-1 pb-1 text-[11px] text-muted-foreground', grid)}>
        {header.map((h, i) => (
          <span
            key={h}
            className={cn(i > 0 && 'text-right', wideOnly.includes(i) && 'hidden @lg:block')}
          >
            {h}
          </span>
        ))}
      </div>
      <ul>{children}</ul>
    </section>
  )
}
