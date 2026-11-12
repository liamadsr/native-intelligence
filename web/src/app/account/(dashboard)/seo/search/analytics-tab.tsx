'use client'

/**
 * The Analytics tab: Google Analytics' fixed reports for the workspace's
 * chosen property, for the header's period. Optional: without a property it
 * shows its own small setup block (connect, choose, reconnect) and the rest
 * of the page carries on.
 *
 *   picker      the report (and its breakdown, where it takes one)
 *   overview    tiles with their change against the period before, and the
 *               daily visits and people
 *   table       rows drawn from the report's own column metadata: its
 *               dimensions on the left, its metrics right-aligned, labelled
 *               through one label map; the less important numbers drop on a
 *               narrow card
 *   health      a plain checklist of what is set up and what is missing
 *
 * Reads: POST /api/account/seo/google/analytics/report with a request counter.
 */
import * as React from 'react'
import { AlertTriangle, CircleAlert, CircleCheck, Info, Loader2 } from 'lucide-react'
import {
  ANALYTICS_BREAKDOWNS,
  type AnalyticsDiagnostic,
  type AnalyticsOverviewReport,
  type AnalyticsPropertyOption,
  type AnalyticsReport,
  type AnalyticsReportName,
  type AnalyticsRow,
  type AnalyticsSourceView,
  type AnalyticsTableReport,
  type GoogleProductStatus,
  type MeasurementHealthReport,
} from '@/lib/seo/google/view'
import { cn } from '@/lib/utils'
import { FilterChips } from '../shared/tab-pills'
import { StatTiles, type StatTile } from '../shared/stat-tiles'
import { TREND_TONES, TrendChart } from '../shared/trend-chart'
import { count, pathOf } from '../ui-helpers'
import { fetchAnalyticsReport, isSetupGone } from './api'
import {
  ANALYTICS_REPORT_CAPTION,
  ANALYTICS_REPORT_OPTIONS,
  BREAKDOWN_LABEL,
  COLUMN_TITLE,
  MEASUREMENT_ISSUE,
  changeNote,
  columnLabel,
  dateSpan,
  daysBetween,
  formatMetric,
  gaDate,
  isMine,
  isRateMetric,
  periodDates,
  type SearchPeriod,
} from './helpers'
import { ChoosePicker, ConnectBlock, ReadError, ReconnectBlock, type ConnectFn } from './setup'

const PAGE_SIZE = 50
const LIMITED = 'Google is still processing some of this. A missing row is unknown, not zero.'

type AnalyticsStatus = GoogleProductStatus<AnalyticsPropertyOption, AnalyticsSourceView>

export function AnalyticsTab({
  status,
  period,
  connecting,
  onConnect,
  onChooseProperty,
  onStatusChanged,
}: {
  status: AnalyticsStatus
  period: SearchPeriod
  connecting: boolean
  onConnect: ConnectFn
  /** Open the property picker (the page's "Change Analytics property"). */
  onChooseProperty: () => void
  /** A choice was made, or the choice is gone: the page re-reads its status. */
  onStatusChanged: () => void
}) {
  if (status.state === 'not_connected') return <ConnectBlock product="analytics" busy={connecting} onConnect={onConnect} compact />
  if (status.state === 'choose')
    return <ChoosePicker data={{ product: 'analytics', status }} connecting={connecting} onConnect={onConnect} onChosen={onStatusChanged} compact />
  if (status.state === 'needs_reconnect' || !status.source)
    return (
      <ReconnectBlock
        product="analytics"
        name={status.source?.chosen_by_name ?? null}
        isYou={isMine(status.source?.account_id, status.my_accounts)}
        email={status.source?.account_email ?? null}
        connecting={connecting}
        onConnect={onConnect}
        onChoose={onChooseProperty}
        compact
      />
    )
  return (
    <AnalyticsReports
      source={status.source}
      chosenByYou={isMine(status.source.account_id, status.my_accounts)}
      period={period}
      connecting={connecting}
      onConnect={onConnect}
      onChooseProperty={onChooseProperty}
      onSetupGone={onStatusChanged}
    />
  )
}

function AnalyticsReports({
  source,
  chosenByYou,
  period,
  connecting,
  onConnect,
  onChooseProperty,
  onSetupGone,
}: {
  source: AnalyticsSourceView
  chosenByYou: boolean
  period: SearchPeriod
  connecting: boolean
  onConnect: ConnectFn
  onChooseProperty: () => void
  onSetupGone: () => void
}) {
  const [report, setReport] = React.useState<AnalyticsReportName>('organic_overview')
  const breakdowns = (ANALYTICS_BREAKDOWNS as Partial<Record<AnalyticsReportName, readonly string[]>>)[report] ?? null
  const [breakdown, setBreakdown] = React.useState<string | null>(null)
  const activeBreakdown = breakdowns ? (breakdown && breakdowns.includes(breakdown) ? breakdown : breakdowns[0]) : null
  const [data, setData] = React.useState<AnalyticsReport | null>(null)
  const [rows, setRows] = React.useState<AnalyticsRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [failure, setFailure] = React.useState<unknown>(null)
  const [moreFailed, setMoreFailed] = React.useState(false)
  const asked = React.useRef(0)

  const load = React.useCallback(
    async (offset: number) => {
      const ask = ++asked.current
      setLoading(true)
      setMoreFailed(false)
      if (!offset) {
        setFailure(null)
        setData((d) => (d && d.report === report ? d : null))
      }
      try {
        const out = await fetchAnalyticsReport({
          report,
          ...(report === 'measurement_health' ? {} : periodDates(period, 'analytics')),
          ...(report === 'organic_overview' ? { trend: 'daily' as const } : {}),
          ...(report !== 'organic_overview' && report !== 'measurement_health' ? { limit: PAGE_SIZE, ...(offset ? { offset } : {}) } : {}),
          ...(activeBreakdown ? { breakdown: activeBreakdown } : {}),
        })
        if (ask !== asked.current) return
        if (offset && out.kind === 'table') {
          setRows((r) => [...r, ...out.rows])
          setData(out)
        } else {
          setData(out)
          setRows(out.kind === 'table' ? out.rows : [])
        }
      } catch (err) {
        if (ask !== asked.current) return
        if (isSetupGone(err)) onSetupGone()
        else if (offset) setMoreFailed(true)
        else setFailure(err)
      } finally {
        if (ask === asked.current) setLoading(false)
      }
    },
    [report, period, activeBreakdown, onSetupGone],
  )

  React.useEffect(() => {
    void load(0)
  }, [load])

  const name = source.property_name ?? source.property_id
  return (
    <div data-seo-search-analytics="" className="@container">
      <p data-seo-search-property="" className="mb-3 truncate text-[11px] text-muted-foreground" title={`${source.property_id}${source.account_email ? ` · read through ${source.account_email}` : ''}`}>
        {[name, source.chosen_by_name || chosenByYou ? `chosen by ${chosenByYou ? 'you' : source.chosen_by_name}` : null].filter(Boolean).join(' · ')}
      </p>
      <FilterChips options={ANALYTICS_REPORT_OPTIONS} value={report} onChange={setReport} label="Report" />
      <p className="mt-1.5 text-xs text-muted-foreground">{ANALYTICS_REPORT_CAPTION[report]}</p>
      {breakdowns && breakdowns.length > 1 && (
        <FilterChips
          className="mt-2"
          options={breakdowns.map((b) => ({ value: b, label: BREAKDOWN_LABEL[b] ?? b }))}
          value={activeBreakdown ?? breakdowns[0]}
          onChange={setBreakdown}
          label="Break down"
        />
      )}

      <div className="mt-4">
        {failure && !loading ? (
          <ReadError
            err={failure}
            product="analytics"
            what="this report"
            connecting={connecting}
            onConnect={onConnect}
            onChoose={onChooseProperty}
            onRetry={() => void load(0)}
          />
        ) : !data ? (
          <div data-seo-loading="" className="flex justify-center py-16">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className={cn('transition-opacity', loading && rows.length === 0 && 'opacity-60')}>
            {data.kind === 'overview' ? (
              <OverviewReport report={data} />
            ) : data.kind === 'measurement_health' ? (
              <HealthReport report={data} />
            ) : (
              <TableReport report={data} rows={rows} loading={loading} moreFailed={moreFailed} onMore={() => data.page.next_offset !== null && void load(data.page.next_offset)} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────

const OVERVIEW_TILES: ReadonlyArray<{ metric: string; label: string; title: string }> = [
  { metric: 'sessions', label: 'Visits from search', title: 'Visits that came from a search engine' },
  { metric: 'activeUsers', label: 'People', title: 'People who visited from search' },
  { metric: 'engagementRate', label: 'Engaged', title: COLUMN_TITLE.engagementRate },
  { metric: 'keyEvents', label: 'Key events', title: COLUMN_TITLE.keyEvents },
]

function numberOf(row: AnalyticsRow | null, metric: string): number | null {
  const v = row?.[metric]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function OverviewReport({ report }: { report: AnalyticsOverviewReport }) {
  const currency = report.source.currency_code
  const tiles: StatTile[] = OVERVIEW_TILES.map((t) => {
    const value = numberOf(report.current, t.metric)
    const change = changeNote(isRateMetric(t.metric) ? 'rate' : 'count', report.comparison[t.metric])
    return {
      key: t.metric,
      label: t.label,
      value: value === null ? null : formatMetric(t.metric, value, currency),
      title: value === null ? 'Google withheld this number' : t.title,
      note: change?.note,
      noteTone: change?.tone,
    }
  })
  const range = report.request.date_range
  const dates = daysBetween(range.start_date, range.end_date)
  const byDate = new Map(report.trend.map((r) => [gaDate(r.date), r]))
  // A day Google left out had no search visits, unless the report is limited: then it is unknown.
  const valueOn = (date: string, metric: string) => {
    const row = byDate.get(date)
    if (!row) return report.has_limited_data ? null : 0
    return numberOf(row, metric)
  }
  const sessions = dates.map((d) => valueOn(d, 'sessions'))
  const people = dates.map((d) => valueOn(d, 'activeUsers'))
  const total = numberOf(report.current, 'sessions')
  return (
    <div data-seo-search-analytics-report="overview">
      <StatTiles tiles={tiles} />
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {dateSpan(range.start_date, range.end_date)}, against {dateSpan(report.request.previous_date_range.start_date, report.request.previous_date_range.end_date)}
      </p>
      {report.current === null && report.trend.length === 0 ? (
        <p data-seo-search-analytics-empty="" className="py-10 text-center text-sm text-muted-foreground">
          No visits from search engines in this period.
        </p>
      ) : (
        <TrendChart
          className="mt-4"
          dates={dates}
          series={[
            { key: 'sessions', label: 'Visits', values: sessions, tone: TREND_TONES[0] },
            { key: 'people', label: 'People', values: people, tone: TREND_TONES[1] },
          ]}
          summary={`Visits and people from search engines a day, ${dateSpan(range.start_date, range.end_date)}${total !== null ? `: ${total.toLocaleString()} visits in all` : ''}.`}
        />
      )}
      {report.has_limited_data && <LimitedCaption />}
      <Diagnostics items={report.diagnostics} />
    </div>
  )
}

// ── Tables ───────────────────────────────────────────────────────────────

interface Column {
  key: string
  label: string
  title?: string
  kind: 'page' | 'dimension' | 'metric'
  /** 0: always shown; 1: from a medium card; 2: only on a wide one. */
  tier: 0 | 1 | 2
}

/** The table's columns from the report's own metadata: a host and a path become one page link. */
export function tableColumns(dimensions: readonly string[], metrics: readonly string[]): Column[] {
  const cols: Column[] = []
  const path = dimensions.find((d) => d === 'landingPage' || d === 'pagePath')
  const joined = !!path && dimensions.includes('hostName')
  let firstDim = true
  for (const d of dimensions) {
    if (joined && d === 'hostName') continue
    const kind = joined && d === path ? 'page' : 'dimension'
    cols.push({ key: d, label: columnLabel(d), title: COLUMN_TITLE[d], kind, tier: firstDim ? 0 : 1 })
    firstDim = false
  }
  metrics.forEach((m, i) => cols.push({ key: m, label: columnLabel(m), title: COLUMN_TITLE[m], kind: 'metric', tier: i < 2 ? 0 : i < 4 ? 1 : 2 }))
  return cols
}

function template(cols: readonly Column[], upTo: 0 | 1 | 2): string {
  return cols
    .filter((c) => c.tier <= upTo)
    .map((c, i) => (c.kind === 'metric' ? '5.5rem' : i === 0 ? 'minmax(0,1fr)' : 'minmax(0,9rem)'))
    .join(' ')
}

const TIER_CELL: Record<Column['tier'], string> = { 0: '', 1: 'hidden @xl:block', 2: 'hidden @3xl:block' }
const TABLE_GRID = 'grid items-start gap-2 grid-cols-[var(--seo-cols-0)] @xl:grid-cols-[var(--seo-cols-1)] @3xl:grid-cols-[var(--seo-cols-2)]'

function pageUrl(row: AnalyticsRow, path: string): string | null {
  const host = typeof row.hostName === 'string' ? row.hostName : ''
  if (!host || !path.startsWith('/')) return null
  return `https://${host}${path}`
}

function TableReport({
  report,
  rows,
  loading,
  moreFailed,
  onMore,
}: {
  report: AnalyticsTableReport
  rows: AnalyticsRow[]
  loading: boolean
  moreFailed: boolean
  onMore: () => void
}) {
  const cols = React.useMemo(() => tableColumns(report.request.dimensions, report.request.metrics), [report.request.dimensions, report.request.metrics])
  const style = { '--seo-cols-0': template(cols, 0), '--seo-cols-1': template(cols, 1), '--seo-cols-2': template(cols, 2) } as React.CSSProperties
  const currency = report.source.currency_code
  const range = report.request.date_range
  const restricted = new Set(report.metadata.restricted_metrics.map((m) => m.metric_name))
  const caption = [
    dateSpan(range.start_date, range.end_date),
    report.request.channel === 'organic_search' ? 'visits from search engines only' : 'all visits',
    report.total_row_count > 0 ? count(report.total_row_count, 'row') : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div data-seo-search-analytics-report={report.report}>
      <p className="text-[11px] text-muted-foreground">{caption.charAt(0).toUpperCase() + caption.slice(1)}</p>
      {rows.length === 0 ? (
        <p data-seo-search-analytics-empty="" className="py-10 text-center text-sm text-muted-foreground">
          {report.activity?.status === 'none'
            ? (report.activity.reason ?? 'No sales were recorded in this period.')
            : report.metadata.empty_reason ?? 'Nothing was recorded for this period.'}
        </p>
      ) : (
        <div className="mt-2" style={style}>
          <div aria-hidden className={cn(TABLE_GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
            {cols.map((c) => (
              <span key={c.key} title={c.title} className={cn('truncate', c.kind === 'metric' && 'text-right', TIER_CELL[c.tier])}>
                {c.label}
              </span>
            ))}
          </div>
          <ul>
            {rows.map((row, i) => (
              <li key={i} data-seo-search-analytics-row={i} className={cn(TABLE_GRID, 'rounded-md px-1 py-1 transition-colors hover:bg-muted/40')}>
                {cols.map((c) => {
                  const raw = row[c.key]
                  if (c.kind === 'metric') {
                    const missing = raw === null || raw === undefined
                    return (
                      <span
                        key={c.key}
                        className={cn('pt-px text-right text-xs tabular-nums', c === cols.find((x) => x.kind === 'metric') ? 'text-foreground' : 'text-muted-foreground', TIER_CELL[c.tier])}
                        title={missing ? (restricted.has(c.key) ? 'Google withheld this number for this property' : 'Not reported') : undefined}
                      >
                        {formatMetric(c.key, raw, currency)}
                      </span>
                    )
                  }
                  const text = raw === null || raw === undefined || raw === '' ? '—' : String(raw)
                  if (c.kind === 'page') {
                    const url = pageUrl(row, text)
                    return (
                      <span key={c.key} className={cn('min-w-0', TIER_CELL[c.tier])}>
                        {url ? (
                          <a href={url} target="_blank" rel="noreferrer noopener" title={url} className="block truncate text-xs text-foreground underline-offset-2 hover:underline">
                            {pathOf(url)}
                          </a>
                        ) : (
                          <span className="block truncate text-xs text-foreground" title={text}>
                            {text}
                          </span>
                        )}
                      </span>
                    )
                  }
                  return (
                    <span key={c.key} className={cn('min-w-0 truncate text-xs text-foreground', TIER_CELL[c.tier])} title={text}>
                      {text}
                    </span>
                  )
                })}
              </li>
            ))}
          </ul>
          {(report.page.has_more || moreFailed) && (
            <div className="flex flex-col items-center gap-1 pt-3">
              {moreFailed && <p className="text-xs text-muted-foreground">Could not load more.</p>}
              <button
                type="button"
                data-seo-search-analytics-more=""
                disabled={loading}
                onClick={onMore}
                className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
              >
                {loading ? 'Loading…' : moreFailed ? 'Try again' : 'Show more'}
              </button>
            </div>
          )}
        </div>
      )}
      {report.metadata.has_limited_data && <LimitedCaption />}
      <Diagnostics items={report.diagnostics} />
    </div>
  )
}

// ── Measurement health ───────────────────────────────────────────────────

function HealthReport({ report }: { report: MeasurementHealthReport }) {
  const issues = new Set(report.issues)
  const stream = report.web_streams[0] ?? null
  const items: Array<{ key: string; ok: boolean; text: string; detail?: string }> = [
    {
      key: 'no_web_stream',
      ok: !issues.has('no_web_stream'),
      text: issues.has('no_web_stream') ? MEASUREMENT_ISSUE.no_web_stream.missing : `Your website sends data${report.web_streams.length > 1 ? ` (${count(report.web_streams.length, 'stream')})` : ''}`,
      detail: issues.has('no_web_stream') ? MEASUREMENT_ISSUE.no_web_stream.detail : [stream?.default_uri, stream?.measurement_id].filter(Boolean).join(' · ') || undefined,
    },
    {
      key: 'enhanced_measurement_disabled',
      ok: !issues.has('enhanced_measurement_disabled'),
      text: issues.has('enhanced_measurement_disabled') ? MEASUREMENT_ISSUE.enhanced_measurement_disabled.missing : 'Enhanced measurement is on',
      detail: issues.has('enhanced_measurement_disabled') ? MEASUREMENT_ISSUE.enhanced_measurement_disabled.detail : 'Scrolls, outbound clicks and downloads are counted.',
    },
    {
      key: 'site_search_measurement_disabled',
      ok: !issues.has('site_search_measurement_disabled'),
      text: issues.has('site_search_measurement_disabled') ? MEASUREMENT_ISSUE.site_search_measurement_disabled.missing : 'Site search is measured',
      detail: issues.has('site_search_measurement_disabled') ? MEASUREMENT_ISSUE.site_search_measurement_disabled.detail : undefined,
    },
    {
      key: 'no_key_events_configured',
      ok: !issues.has('no_key_events_configured'),
      text: issues.has('no_key_events_configured') ? MEASUREMENT_ISSUE.no_key_events_configured.missing : `${count(report.key_events.length, 'key event')} set up`,
      detail: issues.has('no_key_events_configured') ? MEASUREMENT_ISSUE.no_key_events_configured.detail : report.key_events.map((k) => k.event_name).join(', ') || undefined,
    },
  ]
  // A check this page does not know yet still shows, in Google's words.
  for (const code of report.issues) {
    if (!MEASUREMENT_ISSUE[code]) items.push({ key: code, ok: false, text: code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) })
  }
  const custom = [report.summary.custom_dimensions > 0 ? count(report.summary.custom_dimensions, 'custom dimension') : null, report.summary.custom_metrics > 0 ? count(report.summary.custom_metrics, 'custom metric') : null].filter(Boolean)
  return (
    <div data-seo-search-analytics-report="measurement_health">
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.key} data-seo-search-health={item.key} data-ok={item.ok ? 'yes' : 'no'} className="flex items-start gap-3 py-2">
            {item.ok ? (
              <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Set up" />
            ) : (
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Missing" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-foreground">{item.text}</span>
              {item.detail && <span className="block truncate text-xs text-muted-foreground" title={item.detail}>{item.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      {custom.length > 0 && <p className="mt-2 text-[11px] text-muted-foreground">Also set up: {custom.join(' · ')}</p>}
    </div>
  )
}

// ── Shared bits ──────────────────────────────────────────────────────────

function LimitedCaption() {
  return (
    <p data-seo-search-limited="" className="mt-2 text-[11px] text-muted-foreground">
      {LIMITED}
    </p>
  )
}

function Diagnostics({ items }: { items: readonly AnalyticsDiagnostic[] }) {
  if (items.length === 0) return null
  return (
    <ul data-seo-search-diagnostics="" className="mt-3 space-y-1">
      {items.map((d, i) => (
        <li key={`${d.code}-${i}`} className="flex items-start gap-2 text-xs text-muted-foreground">
          {d.severity === 'warning' ? (
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
          ) : (
            <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          )}
          <span>{d.message}</span>
        </li>
      ))}
    </ul>
  )
}
