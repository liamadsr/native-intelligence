'use client'

/**
 * A looked-up site's Competitors tab: who else shows up in Google for the
 * searches it ranks for. It needs searches to compare on: one per line,
 * typed or taken from the site's top searches ("Use this site's top
 * searches", up to 100). "Find competitors" is the request (POST
 * …/domain/competitors): it spends unless the same searches were compared in
 * the last 12 hours.
 *
 * A result row: the site (the workspace's own marked and pinned first), the
 * searches it shares, its average position, its visibility and its
 * estimated visits. Re-sorting and hiding a site re-ask with the same
 * searches, which the route serves from storage for free. "Look up site" on
 * a row opens that site's overview (that spends).
 */
import * as React from 'react'
import { Loader2, Swords } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DomainOverview, SerpCompetitorRow, SerpCompetitorSort, SerpCompetitorsResult } from '@/lib/seo/domain/view'
import { describeMarket } from '@/lib/seo/keywords/view'
import { cn } from '@/lib/utils'
import { errorMessage } from '../api'
import { FilterChips } from '../shared/tab-pills'
import { count, relativeWhen } from '../ui-helpers'
import { findCompetitors, paidFailure } from './api'
import { avgPosition, num, parseKeywords, percent, pinOwnSite } from './helpers'
import { NeutralBanner } from './keywords-tab'

const MAX = 100
const GRID = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center gap-2 @xl:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_4.5rem_4.5rem]'
const ESTIMATE = 'An estimate from the search data provider’s own crawl of Google, not the site’s analytics'

const SORTS: ReadonlyArray<{ value: SerpCompetitorSort; label: string }> = [
  { value: 'visibility', label: 'Visibility' },
  { value: 'traffic', label: 'Visits' },
  { value: 'keyword_count', label: 'Searches in common' },
  { value: 'avg_position', label: 'Position' },
]

interface Problem {
  kind: 'limit' | 'field' | 'failed'
  message: string
}

export function useCompetitors(overview: DomainOverview, { onSpent, onOff }: { onSpent: () => void; onOff: (err: unknown) => void }) {
  const [text, setText] = React.useState('')
  const [result, setResult] = React.useState<SerpCompetitorsResult | null>(null)
  const [editing, setEditing] = React.useState(true)
  const [sort, setSort] = React.useState<SerpCompetitorSort>('visibility')
  const [hidden, setHidden] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(false)
  const [problem, setProblem] = React.useState<Problem | null>(null)
  const asked = React.useRef(0)
  const latest = React.useRef({ onSpent, onOff })
  React.useEffect(() => {
    latest.current = { onSpent, onOff }
  })

  const ask = React.useCallback(
    async (keywords: string[], opts: { sort: SerpCompetitorSort; hidden: string[]; refresh?: boolean }) => {
      const n = ++asked.current
      setLoading(true)
      setProblem(null)
      try {
        const next = await findCompetitors({
          keywords,
          market: { location_code: overview.location_code, language_code: overview.language_code },
          sort_by: opts.sort,
          exclude_domains: opts.hidden,
          refresh: opts.refresh,
        })
        if (n !== asked.current) return
        if (!next.from_cache) latest.current.onSpent()
        setResult(next)
        setEditing(false)
      } catch (err) {
        if (n !== asked.current) return
        const failure = paidFailure(err)
        if (failure === 'off') latest.current.onOff(err)
        setProblem({
          kind: failure === 'limit' ? 'limit' : failure === 'field' ? 'field' : 'failed',
          message: failure === 'failed' ? 'Could not find competitors.' : errorMessage(err, 'Could not find competitors.'),
        })
      } finally {
        if (n === asked.current) setLoading(false)
      }
    },
    [overview.location_code, overview.language_code],
  )

  const keywords = React.useMemo(() => parseKeywords(text, MAX), [text])
  const find = () => {
    if (keywords.length === 0) return
    setHidden([])
    void ask(keywords, { sort, hidden: [] })
  }
  const resort = (next: SerpCompetitorSort) => {
    setSort(next)
    if (result) void ask(result.keywords, { sort: next, hidden })
  }
  const hide = (domain: string) => {
    const next = [...hidden, domain]
    setHidden(next)
    if (result) void ask(result.keywords, { sort, hidden: next })
  }
  const showAll = () => {
    setHidden([])
    if (result) void ask(result.keywords, { sort, hidden: [] })
  }
  const refresh = () => {
    if (result) void ask(result.keywords, { sort, hidden, refresh: true })
  }
  const useTop = () => setText(overview.top_keywords.slice(0, MAX).map((k) => k.keyword).join('\n'))
  return { text, setText, keywords, result, editing, setEditing, sort, hidden, loading, problem, find, resort, hide, showAll, refresh, useTop }
}

export type CompetitorsState = ReturnType<typeof useCompetitors>

export function CompetitorsTab({
  state,
  overview,
  blockedReason,
  onLookUp,
}: {
  state: CompetitorsState
  overview: DomainOverview
  blockedReason: string | null
  onLookUp: (domain: string) => void
}) {
  const { result, editing, loading, problem } = state
  const showForm = editing || !result
  return (
    <div data-seo-competitors="" className="@container">
      {showForm ? (
        <CompareForm state={state} overview={overview} blockedReason={blockedReason} />
      ) : (
        <ResultBlock state={state} result={result} blockedReason={blockedReason} onLookUp={onLookUp} />
      )}
      {problem?.kind === 'limit' && <NeutralBanner text={problem.message} />}
      {problem?.kind === 'failed' && (
        <p data-seo-competitors-failed="" className="mt-3 text-xs text-muted-foreground">
          {problem.message}{' '}
          <button type="button" onClick={showForm ? state.find : state.refresh} disabled={loading || !!blockedReason} className="text-foreground underline-offset-2 hover:underline">
            Try again
          </button>
        </p>
      )}
    </div>
  )
}

function CompareForm({ state, overview, blockedReason }: { state: CompetitorsState; overview: DomainOverview; blockedReason: string | null }) {
  const { text, setText, keywords, loading, problem, result } = state
  const fieldError = problem?.kind === 'field' ? problem.message : null
  const top = overview.top_keywords.length
  return (
    <div data-seo-compare-form="" className="max-w-xl space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Swords className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Who else shows up for these searches</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Name the searches to compare on, one per line, and see which sites show up in Google for them: how many they share,
            where they usually rank, and how many visits they’re estimated to get.
          </p>
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="seo-competitors-keywords" className="text-xs text-muted-foreground">
            Searches to compare on
          </label>
          {top > 0 && (
            <Button
              variant="ghost"
              size="sm"
              data-seo-use-top=""
              className="-mr-2 h-7 text-xs text-muted-foreground hover:text-foreground"
              title={`Takes the ${count(Math.min(top, MAX), 'search', 'searches')} that bring this site the most visits`}
              onClick={state.useTop}
            >
              Use this site’s top searches
            </Button>
          )}
        </div>
        <textarea
          id="seo-competitors-keywords"
          data-seo-compare-keywords=""
          value={text}
          rows={5}
          spellCheck={false}
          placeholder="One search per line"
          aria-invalid={fieldError ? true : undefined}
          onChange={(e) => setText(e.target.value)}
          className="block w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        />
        {fieldError ? (
          <p data-seo-compare-error="" className="text-xs text-destructive">
            {fieldError}
          </p>
        ) : (
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {keywords.length > 0 ? `${count(keywords.length, 'search', 'searches')} · at most ${MAX}` : `At most ${MAX} searches`}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        {result && (
          <Button variant="ghost" size="sm" onClick={() => state.setEditing(false)} disabled={loading}>
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          data-seo-find-competitors=""
          disabled={loading || keywords.length === 0 || !!blockedReason}
          title={blockedReason ?? 'Compares these searches: a small charge, unless compared in the last 12 hours'}
          onClick={state.find}
        >
          {loading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Find competitors
        </Button>
      </div>
    </div>
  )
}

function ResultBlock({
  state,
  result,
  blockedReason,
  onLookUp,
}: {
  state: CompetitorsState
  result: SerpCompetitorsResult
  blockedReason: string | null
  onLookUp: (domain: string) => void
}) {
  const rows = pinOwnSite(result.rows)
  const when = relativeWhen(result.fetched_at)
  return (
    <div data-seo-competitors-result="">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="min-w-0 text-xs tabular-nums text-muted-foreground">
          {[`Compared on ${count(result.keywords.length, 'search', 'searches')}`, describeMarket(result.location_code, result.language_code), when ? `Looked up ${when}` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <Button variant="ghost" size="sm" data-seo-change-searches="" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => state.setEditing(true)}>
          Change searches
        </Button>
        {result.from_cache && (
          <Button
            variant="ghost"
            size="sm"
            data-seo-competitors-refresh=""
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            disabled={state.loading || !!blockedReason}
            title={blockedReason ?? 'Compare again with fresh data: a small charge'}
            onClick={state.refresh}
          >
            Refresh
          </Button>
        )}
        {state.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <FilterChips label="Sort competitors" options={SORTS} value={state.sort} onChange={state.resort} />
        {state.hidden.length > 0 && (
          <p data-seo-hidden="" className="text-[11px] text-muted-foreground">
            {count(state.hidden.length, 'site')} hidden ·{' '}
            <button type="button" data-seo-show-all="" onClick={state.showAll} className="text-foreground underline-offset-2 hover:underline">
              Show all
            </button>
          </p>
        )}
      </div>
      {rows.length === 0 ? (
        <p data-seo-competitors-empty="" className="py-10 text-center text-sm text-muted-foreground">
          No competitors found for these searches
        </p>
      ) : (
        <div className="mt-3">
          <div aria-hidden className={cn(GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
            <span>Site</span>
            <span className="text-right" title="How many of these searches it shows up for">
              In common
            </span>
            <span className="hidden text-right @xl:block" title="Its usual place in the results: lower is better">
              Position
            </span>
            <span className="hidden text-right @xl:block" title="Its estimated share of the clicks these searches get">
              Visibility
            </span>
            <span className="text-right" title={ESTIMATE}>
              Visits
            </span>
          </div>
          <ul>
            {rows.map((row) => (
              <CompetitorRow key={row.domain} row={row} blockedReason={blockedReason} busy={state.loading} onLookUp={onLookUp} onHide={state.hide} />
            ))}
          </ul>
          {result.caveats.length > 0 && <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{result.caveats.join(' ')}</p>}
        </div>
      )}
    </div>
  )
}

function CompetitorRow({
  row,
  blockedReason,
  busy,
  onLookUp,
  onHide,
}: {
  row: SerpCompetitorRow
  blockedReason: string | null
  busy: boolean
  onLookUp: (domain: string) => void
  onHide: (domain: string) => void
}) {
  return (
    <li data-seo-competitor-row={row.domain} data-own={row.own_site ? '' : undefined} className={cn(GRID, 'group relative rounded-md px-1 py-1 transition-colors hover:bg-muted/40')}>
      <span className="flex h-5 min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-foreground" title={row.domain}>
          {row.domain}
        </span>
        {row.own_site && <YourSiteChip />}
        <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">
          <button
            type="button"
            data-seo-row-look-up={row.domain}
            disabled={!!blockedReason}
            title={blockedReason ?? `Look up ${row.domain}: a small charge, unless looked up in the last 12 hours`}
            onClick={() => onLookUp(row.domain)}
            className="h-5 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            Look up site
          </button>
          {!row.own_site && (
            <button
              type="button"
              data-seo-row-hide={row.domain}
              disabled={busy}
              title={`Leave ${row.domain} out of this list`}
              onClick={() => onHide(row.domain)}
              className="h-5 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              Hide
            </button>
          )}
        </span>
      </span>
      <span className="text-right text-xs tabular-nums text-muted-foreground">{num(row.keywords_count)}</span>
      <span className="hidden text-right text-xs tabular-nums text-muted-foreground @xl:block">{avgPosition(row.avg_position)}</span>
      <span className="hidden text-right text-xs tabular-nums text-muted-foreground @xl:block">{percent(row.visibility)}</span>
      <span className="text-right text-xs tabular-nums text-foreground" title={ESTIMATE}>
        {num(row.etv)}
      </span>
    </li>
  )
}

export function YourSiteChip() {
  return (
    <span data-seo-own-chip="" className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      Your site
    </span>
  )
}
