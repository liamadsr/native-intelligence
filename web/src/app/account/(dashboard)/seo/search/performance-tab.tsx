'use client'

/**
 * The Queries and Pages tabs: Search Console's numbers for the period, by
 * the searches people typed (Queries) or by the site's pages (Pages).
 *
 *   tiles     clicks, impressions, click rate and average position for the
 *             whole period (with the "contains" filter), each with its change
 *             against the period before (lower is better for position)
 *   charts    daily clicks and daily impressions, one line each (their
 *             scales differ a hundredfold, so they do not share an axis)
 *   rows      the search or the page, then the four numbers, sorted by a
 *             small chip row (the rows read so far; Google sends them by
 *             clicks), "Show more" pages on Google's own row numbering
 *
 * A page row's hover action "Check indexing" asks Google whether it lists
 * that page (POST …/inspect) and says so under the row.
 *
 * Reads: POST /api/account/seo/google/search-console/performance with a
 * request counter, so a slow answer never overwrites a newer one.
 */
import * as React from 'react'
import { Loader2, Search, X } from 'lucide-react'
import type { SearchConsolePerformance, SearchConsoleRow, UrlInspectionRow } from '@/lib/seo/google/view'
import { cn } from '@/lib/utils'
import { FilterChips } from '../shared/tab-pills'
import { StatTiles, type StatTile } from '../shared/stat-tiles'
import { TREND_TONES, TrendChart } from '../shared/trend-chart'
import { errorMessage } from '../api'
import { pathOf } from '../ui-helpers'
import { fetchPerformance, inspectUrls, isSetupGone } from './api'
import { SEARCH_PERIODS, changeNote, dateSpan, inspectionSummary, percent, position, whole, type SearchPeriod } from './helpers'
import { ReadError, type ConnectFn } from './setup'

const PAGE_SIZE = 100

type SortKey = 'clicks' | 'impressions' | 'position'
const SORTS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'clicks', label: 'Clicks' },
  { value: 'impressions', label: 'Impressions' },
  { value: 'position', label: 'Position' },
]

/** Narrow card: the row, clicks and position; wider: all four numbers. */
const GRID = 'grid grid-cols-[minmax(0,1fr)_4rem_4rem] items-start gap-2 @lg:grid-cols-[minmax(0,1fr)_4.5rem_5.5rem_4.5rem_4.5rem]'

export function sortRows(rows: readonly SearchConsoleRow[], by: SortKey): SearchConsoleRow[] {
  const copy = [...rows]
  if (by === 'position') copy.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))
  else copy.sort((a, b) => b[by] - a[by])
  return copy
}

export function PerformanceTab({
  dimension,
  period,
  connecting,
  onConnect,
  onChooseSite,
  onSetupGone,
}: {
  dimension: 'query' | 'page'
  period: SearchPeriod
  connecting: boolean
  onConnect: ConnectFn
  onChooseSite: () => void
  /** The site is no longer chosen or connected: the page re-reads its status. */
  onSetupGone: () => void
}) {
  const [data, setData] = React.useState<SearchConsolePerformance | null>(null)
  const [rows, setRows] = React.useState<SearchConsoleRow[]>([])
  const [next, setNext] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failure, setFailure] = React.useState<unknown>(null)
  const [moreFailed, setMoreFailed] = React.useState(false)
  const [typed, setTyped] = React.useState('')
  const [contains, setContains] = React.useState('')
  const [sort, setSort] = React.useState<SortKey>('clicks')
  const asked = React.useRef(0)

  // The "contains" box filters on the server: it waits for the typing to stop.
  React.useEffect(() => {
    const t = setTimeout(() => setContains(typed.trim()), 400)
    return () => clearTimeout(t)
  }, [typed])

  const load = React.useCallback(
    async (startRow: number) => {
      const ask = ++asked.current
      setLoading(true)
      setMoreFailed(false)
      if (!startRow) setFailure(null)
      try {
        const out = await fetchPerformance({
          dimensions: [dimension],
          date_range: period,
          row_limit: PAGE_SIZE,
          ...(startRow ? { start_row: startRow } : { compare: true }),
          ...(contains ? { filters: [{ dimension, operator: 'contains' as const, expression: contains }] } : {}),
        })
        if (ask !== asked.current) return
        if (startRow) {
          // Google's paging is stable, but a row already shown is never drawn twice.
          setRows((r) => {
            const seen = new Set(r.map((x) => x.keys.join('\0')))
            return [...r, ...out.rows.filter((x) => !seen.has(x.keys.join('\0')))]
          })
        } else {
          setData(out)
          setRows(out.rows)
        }
        setNext(out.has_more ? out.next_start_row : null)
      } catch (err) {
        if (ask !== asked.current) return
        if (isSetupGone(err)) onSetupGone()
        else if (startRow) setMoreFailed(true)
        else setFailure(err)
      } finally {
        if (ask === asked.current) setLoading(false)
      }
    },
    [dimension, period, contains, onSetupGone],
  )

  React.useEffect(() => {
    void load(0)
  }, [load])

  const sorted = React.useMemo(() => sortRows(rows, sort), [rows, sort])

  if (failure && !loading) {
    return (
      <ReadError
        err={failure}
        product="search_console"
        what={dimension === 'query' ? 'your searches' : 'your pages'}
        connecting={connecting}
        onConnect={onConnect}
        onChoose={onChooseSite}
        onRetry={() => void load(0)}
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

  const periodWords = SEARCH_PERIODS.find((p) => p.value === period)?.words ?? 'the period before'
  const before = data.previous ? `Against ${dateSpan(data.previous.start_date, data.previous.end_date)}` : undefined
  const tile = (key: 'clicks' | 'impressions' | 'ctr' | 'position', label: string, value: string, kind: 'count' | 'rate' | 'position', title: string): StatTile => {
    const change = changeNote(kind, data.change?.[key])
    return { key, label, value, title, note: change?.note, noteTone: change?.tone }
  }
  const t = data.totals
  const tiles: StatTile[] = [
    tile('clicks', 'Clicks', whole(t.clicks), 'count', 'Times someone clicked through to your site from Google'),
    tile('impressions', 'Impressions', whole(t.impressions), 'count', 'Times your site showed in someone’s Google results'),
    tile('ctr', 'Click rate', t.impressions > 0 ? percent(t.ctr) : '—', 'rate', 'Clicks out of impressions'),
    tile('position', 'Average position', t.impressions > 0 ? position(t.position) : '—', 'position', 'Where your site usually showed in the results: 1 is the top. Lower is better.'),
  ]
  const dates = data.trend.map((d) => d.date)
  const noun = dimension === 'query' ? 'search' : 'page'

  return (
    <div data-seo-search-performance={dimension} className="@container">
      <StatTiles tiles={tiles} />
      <p className="mt-1.5 text-[11px] text-muted-foreground" title={before}>
        {[
          before ? `${dateSpan(data.start_date, data.end_date)}, against ${periodWords}` : dateSpan(data.start_date, data.end_date),
          contains ? `${noun === 'search' ? 'Searches' : 'Pages'} containing “${contains}”` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {data.trend.length > 1 && (
        <div className="mt-4 grid gap-4 @2xl:grid-cols-2">
          <TrendChart
            dates={dates}
            series={[{ key: 'clicks', label: 'Clicks', values: data.trend.map((d) => d.clicks), tone: TREND_TONES[0] }]}
            summary={`Clicks a day from Google, ${dateSpan(data.start_date, data.end_date)}: ${whole(t.clicks)} in all.`}
            height={96}
          />
          <TrendChart
            dates={dates}
            series={[{ key: 'impressions', label: 'Impressions', values: data.trend.map((d) => d.impressions), tone: TREND_TONES[1] }]}
            summary={`Times a day your site showed in Google, ${dateSpan(data.start_date, data.end_date)}: ${whole(t.impressions)} in all.`}
            height={96}
          />
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <FilterChips options={SORTS} value={sort} onChange={setSort} label="Sort by" />
        <label className="ml-auto flex h-7 w-full max-w-56 items-center gap-1.5 rounded-lg border border-border px-2 text-xs focus-within:ring-1 focus-within:ring-ring">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
          <input
            data-seo-search-contains=""
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={dimension === 'query' ? 'Searches containing…' : 'Pages containing…'}
            aria-label={dimension === 'query' ? 'Show searches containing' : 'Show pages containing'}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {typed && (
            <button type="button" aria-label="Clear" title="Clear" onClick={() => setTyped('')} className="text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          )}
        </label>
      </div>

      {rows.length === 0 ? (
        <p data-seo-search-empty="" className="py-10 text-center text-sm text-muted-foreground">
          {loading ? (
            <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
          ) : contains ? (
            `No ${noun === 'search' ? 'searches' : 'pages'} contain “${contains}” in this period.`
          ) : (
            `Google has no ${noun === 'search' ? 'searches' : 'pages'} for your site in this period.`
          )}
        </p>
      ) : (
        <div className={cn('mt-3 transition-opacity', loading && !next && 'opacity-60')}>
          <div aria-hidden className={cn(GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
            <span>{dimension === 'query' ? 'Search' : 'Page'}</span>
            <span className="text-right">Clicks</span>
            <span className="hidden text-right @lg:block">Impressions</span>
            <span className="hidden text-right @lg:block">Click rate</span>
            <span className="text-right" title="Lower is better: 1 is the top of the results">
              Position
            </span>
          </div>
          <ul>
            {sorted.map((row) =>
              dimension === 'page' ? <PageRow key={row.keys[0]} row={row} /> : <QueryRow key={row.keys[0]} row={row} />,
            )}
          </ul>
          {(next !== null || moreFailed) && (
            <div className="flex flex-col items-center gap-1 pt-3">
              {moreFailed && <p className="text-xs text-muted-foreground">Could not load more.</p>}
              <button
                type="button"
                data-seo-search-more=""
                disabled={loading}
                onClick={() => void load(next ?? rows.length)}
                className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
              >
                {loading ? 'Loading…' : moreFailed ? 'Try again' : 'Show more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Numbers({ row }: { row: SearchConsoleRow }) {
  return (
    <>
      <span className="pt-px text-right text-xs tabular-nums text-foreground">{whole(row.clicks)}</span>
      <span className="hidden pt-px text-right text-xs tabular-nums text-muted-foreground @lg:block">{whole(row.impressions)}</span>
      <span className="hidden pt-px text-right text-xs tabular-nums text-muted-foreground @lg:block">{percent(row.ctr)}</span>
      <span className="pt-px text-right text-xs tabular-nums text-muted-foreground" title={row.position === null ? 'Google reports no position here' : undefined}>
        {position(row.position)}
      </span>
    </>
  )
}

function QueryRow({ row }: { row: SearchConsoleRow }) {
  const query = row.keys[0] ?? ''
  return (
    <li data-seo-search-row={query} className={cn(GRID, 'rounded-md px-1 py-1 transition-colors hover:bg-muted/40')}>
      {/* A searcher's own words: plain text. */}
      <span className="min-w-0 truncate text-xs text-foreground" title={query}>
        {query}
      </span>
      <Numbers row={row} />
    </li>
  )
}

type Inspection = { at: 'checking' } | { at: 'done'; row: UrlInspectionRow } | { at: 'failed'; error: string }

function PageRow({ row }: { row: SearchConsoleRow }) {
  const url = row.keys[0] ?? ''
  const [inspection, setInspection] = React.useState<Inspection | null>(null)
  const check = async () => {
    setInspection({ at: 'checking' })
    try {
      const out = await inspectUrls([url])
      const found = out.results.find((r) => r.url === url) ?? out.results[0]
      setInspection(found ? { at: 'done', row: found } : { at: 'failed', error: 'Google returned nothing for this page.' })
    } catch (err) {
      setInspection({ at: 'failed', error: errorMessage(err, 'Could not ask Google about this page.') })
    }
  }
  return (
    <li data-seo-search-row={url} className="group rounded-md px-1 py-1 transition-colors hover:bg-muted/40">
      <div className={GRID}>
        <span className="flex min-w-0 items-center gap-2">
          <a href={url} target="_blank" rel="noreferrer noopener" title={url} className="min-w-0 truncate text-xs text-foreground underline-offset-2 hover:underline">
            {pathOf(url)}
          </a>
          {inspection?.at !== 'checking' && (
            <button
              type="button"
              data-seo-search-inspect={url}
              onClick={() => void check()}
              title="Ask Google whether it lists this page"
              className="shrink-0 rounded px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              {inspection ? 'Check again' : 'Check indexing'}
            </button>
          )}
          {inspection?.at === 'checking' && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" aria-label="Checking" />}
        </span>
        <Numbers row={row} />
      </div>
      {inspection && inspection.at !== 'checking' && <InspectionLine inspection={inspection} />}
    </li>
  )
}

function InspectionLine({ inspection }: { inspection: Exclude<Inspection, { at: 'checking' }> }) {
  if (inspection.at === 'failed') {
    return (
      <p data-seo-search-inspection="failed" className="pt-0.5 pb-1 text-[11px] text-muted-foreground">
        {inspection.error}
      </p>
    )
  }
  const s = inspectionSummary(inspection.row)
  return (
    <div data-seo-search-inspection={s.tone} className="pt-0.5 pb-1 text-[11px] leading-relaxed">
      <span
        className={cn(
          'font-medium',
          s.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : s.tone === 'bad' ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground',
        )}
      >
        {s.headline}
      </span>
      {s.reasons.length > 0 && <span className="text-muted-foreground"> · {s.reasons.join(' · ')}</span>}
      {inspection.row.details_link && (
        <>
          <span className="text-muted-foreground"> · </span>
          <a href={inspection.row.details_link} target="_blank" rel="noreferrer noopener" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
            Open in Search Console
          </a>
        </>
      )}
    </div>
  )
}
