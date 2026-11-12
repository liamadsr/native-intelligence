'use client'

/**
 * A tracker's History tab, on the device chosen above, over 30, 90 or 365
 * days (GET …/history `days`):
 *
 *   all keywords   how many keywords sit in the top 3 / 10 / 100 check by
 *                  check (three lines), and under it the checks themselves
 *                  (GET …/runs): when, keywords checked, top 3 / top 10,
 *                  what it cost, and how it ended
 *   one keyword    chosen on Positions or in the select here: its position
 *                  over time (1 at the top; a gap where it was not found),
 *                  and its checks: when, the position, the page that ranked
 *
 * The chart is the kit's TrendChart, always with its numbers beside it.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { RankDevice, RankKeywordHistory, RankKeywordRow, RankRunView, RankTrackerTrend, RankTrackerView } from '@/lib/seo/rank/view'
import { cn } from '@/lib/utils'
import { FilterChips } from '../shared/tab-pills'
import { TREND_TONES, TrendChart } from '../shared/trend-chart'
import { count, pathOf } from '../ui-helpers'
import { fetchKeywordHistory, fetchKeywords, fetchRuns, fetchTrend } from './api'
import { RUN_STATUS_WORD, checkWhen } from './rank-helpers'

const RANGES = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: 'A year' },
] as const
type Range = (typeof RANGES)[number]['value']

const TRIGGER = 'h-7 w-auto min-w-0 max-w-[16rem] gap-1.5 rounded-md px-2.5 text-xs shadow-none'
const CHECKS_GRID =
  'grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_4.5rem] items-center gap-2 @2xl:grid-cols-[minmax(0,1fr)_5.5rem_3.5rem_3.5rem_4rem_4.5rem]'
const KEYWORD_GRID = 'grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-2 @lg:grid-cols-[minmax(0,1fr)_6rem_minmax(0,14rem)]'

export function TrackerHistory({
  tracker,
  device,
  version,
  keyword,
  onKeyword,
}: {
  tracker: RankTrackerView
  device: RankDevice
  version: number
  keyword: { id: string; keyword: string } | null
  onKeyword: (keyword: { id: string; keyword: string } | null) => void
}) {
  const [range, setRange] = React.useState<Range>('90')
  const [options, setOptions] = React.useState<RankKeywordRow[]>([])

  // The keywords to choose from: the first page (pinned first), like Positions.
  React.useEffect(() => {
    let alive = true
    fetchKeywords(tracker.id)
      .then((page) => {
        if (alive) setOptions(page.rows)
      })
      .catch(() => {
        /* the select keeps what it has */
      })
    return () => {
      alive = false
    }
  }, [tracker.id, version])

  const choices = keyword && !options.some((o) => o.id === keyword.id) ? [{ id: keyword.id, keyword: keyword.keyword }, ...options] : options
  return (
    <div data-seo-history="" className="@container">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select
          value={keyword?.id ?? 'all'}
          onValueChange={(v) => {
            if (v === 'all') onKeyword(null)
            else {
              const k = choices.find((o) => o.id === v)
              if (k) onKeyword({ id: k.id, keyword: k.keyword })
            }
          }}
        >
          <SelectTrigger data-seo-history-keyword="" aria-label="Keyword" className={TRIGGER}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value="all" className="text-xs">
              All keywords
            </SelectItem>
            {choices.map((k) => (
              <SelectItem key={k.id} value={k.id} className="text-xs">
                {k.keyword}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FilterChips label="Range" options={RANGES} value={range} onChange={setRange} />
      </div>
      <div className="mt-3">
        {keyword ? (
          <KeywordHistory key={keyword.id} tracker={tracker} device={device} keywordId={keyword.id} days={Number(range)} version={version} />
        ) : (
          <TrackerTrend tracker={tracker} device={device} days={Number(range)} version={version} />
        )}
      </div>
    </div>
  )
}

/** A read with a request counter: a slow answer never overwrites a newer one. */
function useRead<T>(read: () => Promise<T>, deps: React.DependencyList): { data: T | null; loading: boolean; error: boolean; retry: () => void } {
  const [data, setData] = React.useState<T | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [tries, setTries] = React.useState(0)
  const asked = React.useRef(0)
  React.useEffect(() => {
    const ask = ++asked.current
    setLoading(true)
    setError(false)
    read()
      .then((d) => {
        if (ask === asked.current) setData(d)
      })
      .catch(() => {
        if (ask === asked.current) setError(true)
      })
      .finally(() => {
        if (ask === asked.current) setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what the read depends on
  }, [...deps, tries])
  return { data, loading, error, retry: () => setTries((t) => t + 1) }
}

function Loading() {
  return (
    <div className="flex justify-center py-10">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
  )
}

function Failed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      <button type="button" onClick={onRetry} className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">
        Try again
      </button>
    </div>
  )
}

const usdCell = (usd: number) => (usd <= 0 ? '$0.00' : usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`)

function TrackerTrend({ tracker, device, days, version }: { tracker: RankTrackerView; device: RankDevice; days: number; version: number }) {
  const trend = useRead<RankTrackerTrend[]>(() => fetchTrend(tracker.id, days), [tracker.id, days, version])
  const [runs, setRuns] = React.useState<RankRunView[]>([])
  const [next, setNext] = React.useState<number | null>(null)
  const [runsLoading, setRunsLoading] = React.useState(true)
  const asked = React.useRef(0)

  const loadRuns = React.useCallback(
    async (offset: number) => {
      const ask = ++asked.current
      setRunsLoading(true)
      try {
        const page = await fetchRuns(tracker.id, offset)
        if (ask !== asked.current) return
        setRuns((r) => (offset ? [...r, ...page.rows] : page.rows))
        setNext(page.next_offset)
      } catch {
        /* the checks list stays as it was */
      } finally {
        if (ask === asked.current) setRunsLoading(false)
      }
    },
    [tracker.id],
  )
  React.useEffect(() => {
    void loadRuns(0)
  }, [loadRuns, version])

  if (!trend.data && trend.loading) return <Loading />
  if (!trend.data && trend.error) return <Failed text="Could not load the history." onRetry={trend.retry} />

  const points = [...(trend.data?.find((t) => t.device === device)?.points ?? [])].sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at))
  const byRun = new Map(points.map((p) => [p.run_id, p]))
  const deep = Math.min(tracker.serp_depth, 100)
  const series = [
    { key: 'top3', label: 'Top 3', values: points.map((p) => p.top3), tone: TREND_TONES[1] },
    { key: 'top10', label: 'Top 10', values: points.map((p) => p.top10), tone: TREND_TONES[0] },
    ...(deep > 10 ? [{ key: 'top100', label: `Top ${deep}`, values: points.map((p) => p.top100), tone: TREND_TONES[3] }] : []),
  ]
  const latest = points[points.length - 1]
  const summary = latest
    ? `How many of ${count(latest.keywords_total, 'keyword')} sat in the top 3, top 10 and top ${deep} on ${device}, check by check, over the last ${days} days. Newest: ${latest.top3} in the top 3, ${latest.top10} in the top 10.`
    : 'No finished checks in this range yet.'

  return (
    <div data-seo-trend-view="">
      <TrendChart dates={points.map((p) => p.checked_at)} series={series} summary={summary} emptyText={points.length === 1 ? 'One check so far: the chart starts with the second.' : 'No finished checks in this range yet.'} />
      {runs.length === 0 && runsLoading ? null : runs.length === 0 ? null : (
        <div className="mt-5">
          <div aria-hidden className={cn(CHECKS_GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
            <span>Check</span>
            <span className="hidden text-right @2xl:block">Keywords</span>
            <span className="text-right">Top 3</span>
            <span className="text-right">Top 10</span>
            <span className="hidden text-right @2xl:block" title="What the check’s searches cost">
              Cost
            </span>
            <span className="text-right">Status</span>
          </div>
          <ul>
            {runs.map((run) => {
              const point = byRun.get(run.id)
              const ended = run.status === 'completed' || run.status === 'failed' || run.status === 'canceled'
              return (
                <li key={run.id} data-seo-check-row={run.id} className={cn(CHECKS_GRID, 'rounded-md px-1 py-1 text-xs transition-colors hover:bg-muted/40')}>
                  <span className="min-w-0 truncate tabular-nums text-foreground">
                    {checkWhen(run.completed_at ?? run.started_at ?? run.created_at)}
                    {run.trigger === 'scheduled' && <span className="text-muted-foreground"> · scheduled</span>}
                  </span>
                  <span className="hidden text-right tabular-nums text-muted-foreground @2xl:block">
                    {run.keywords_total > 0 ? `${run.keywords_checked.toLocaleString()} of ${run.keywords_total.toLocaleString()}` : '—'}
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground" title={point ? undefined : 'No positions from this check'}>
                    {point ? point.top3.toLocaleString() : '—'}
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground" title={point ? undefined : 'No positions from this check'}>
                    {point ? point.top10.toLocaleString() : '—'}
                  </span>
                  <span className="hidden text-right tabular-nums text-muted-foreground @2xl:block" title={ended ? `Estimated at up to $${run.estimate_usd.toFixed(2)}` : 'Counted when it ends'}>
                    {ended ? usdCell(run.cost_usd) : '—'}
                  </span>
                  <span
                    data-seo-check-status={run.status}
                    title={run.error ?? run.note ?? undefined}
                    className={cn('text-right', run.status === 'failed' ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')}
                  >
                    {RUN_STATUS_WORD[run.status]}
                  </span>
                </li>
              )
            })}
          </ul>
          {next !== null && (
            <div className="flex justify-center pt-3">
              <button
                type="button"
                data-seo-checks-more=""
                disabled={runsLoading}
                onClick={() => void loadRuns(next)}
                className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
              >
                {runsLoading ? 'Loading…' : 'Show more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function KeywordHistory({ tracker, device, keywordId, days, version }: { tracker: RankTrackerView; device: RankDevice; keywordId: string; days: number; version: number }) {
  const history = useRead<RankKeywordHistory>(() => fetchKeywordHistory(tracker.id, keywordId, days), [tracker.id, keywordId, days, version])
  if (!history.data && history.loading) return <Loading />
  if (!history.data && history.error) return <Failed text="Could not load this keyword’s history." onRetry={history.retry} />
  const data = history.data!
  const points = [...(data.series[device] ?? [])].sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at))
  const depth = tracker.serp_depth
  const found = points.filter((p) => p.position !== null)
  const best = found.length ? Math.min(...found.map((p) => p.position as number)) : null
  const latest = points[points.length - 1]
  const summary = latest
    ? `Where ${tracker.domain} ranked for “${data.keyword}” on ${device}, check by check, over the last ${days} days. Newest: ${latest.position === null ? `not in the top ${depth}` : `position ${latest.position}`}${best !== null ? `; best ${best}` : ''}.`
    : 'No finished checks in this range yet.'

  return (
    <div data-seo-keyword-history={keywordId}>
      <TrendChart
        dates={points.map((p) => p.checked_at)}
        series={[{ key: 'position', label: 'Position', values: points.map((p) => p.position), tone: TREND_TONES[0] }]}
        summary={summary}
        invert
        format={(v) => Math.round(v).toLocaleString()}
        emptyText={points.length === 1 ? 'One check so far: the chart starts with the second.' : 'No finished checks in this range yet.'}
      />
      {points.length > 0 && (
        <div className="mt-5">
          <div aria-hidden className={cn(KEYWORD_GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
            <span>Check</span>
            <span className="text-right">Position</span>
            <span className="hidden @lg:block">Page</span>
          </div>
          <ul>
            {[...points].reverse().map((p) => (
              <li key={p.run_id} data-seo-keyword-check={p.run_id} className={cn(KEYWORD_GRID, 'rounded-md px-1 py-1 text-xs transition-colors hover:bg-muted/40')}>
                <span className="min-w-0 truncate tabular-nums text-foreground">{checkWhen(p.checked_at)}</span>
                <span className={cn('text-right tabular-nums', p.position === null ? 'text-muted-foreground' : 'font-medium text-foreground')}>
                  {p.position === null ? `Not in top ${depth}` : p.position.toLocaleString()}
                </span>
                <span className="hidden min-w-0 @lg:block">
                  {p.ranking_url ? (
                    <a
                      href={p.ranking_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={p.ranking_url}
                      className="block truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {pathOf(p.ranking_url)}
                    </a>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
