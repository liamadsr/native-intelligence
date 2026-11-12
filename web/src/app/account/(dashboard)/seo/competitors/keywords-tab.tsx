'use client'

/**
 * A looked-up site's Keywords tab: the searches it ranks for, a hundred at a
 * time. The first hundred by traffic are the overview's own top keywords, so
 * they show without a call; every other page, sort or filter is asked of
 * POST …/domain/ranked-keywords, which spends unless that page was asked in
 * the last 12 hours (the spend line updates after). Its state lives in the
 * site's view (useRankedKeywords), so a tab switch keeps what was loaded.
 *
 * A row: the search, its position (lower is better), monthly searches,
 * estimated visits, and the page that ranks (dropped first on a narrow card).
 * The rows carry no earlier position, so no change note is drawn.
 */
import * as React from 'react'
import { Loader2, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DomainKeywordRow, DomainOverview } from '@/lib/seo/domain/view'
import { cn } from '@/lib/utils'
import { errorMessage } from '../api'
import { FilterChips } from '../shared/tab-pills'
import { RANKED_PAGE, fetchRankedKeywords, paidFailure } from './api'
import {
  DEFAULT_KEYWORD_CONTROLS,
  EXCLUDE_TERMS_MAX,
  KEYWORD_SORT_OPTIONS,
  MIN_SEARCH_OPTIONS,
  RANK_OPTIONS,
  excludeTerm,
  keywordPath,
  maxRankOf,
  num,
  overviewNextOffset,
  overviewServes,
  type KeywordControls,
} from './helpers'

const GRID = 'grid grid-cols-[minmax(0,1fr)_3.5rem_5rem_4.5rem] items-start gap-2 @2xl:grid-cols-[minmax(0,1fr)_3.5rem_5rem_4.5rem_minmax(0,14rem)]'
const ESTIMATE = 'An estimate from the search data provider’s own crawl of Google, not the site’s analytics'

export interface KeywordsProblem {
  kind: 'limit' | 'field' | 'failed'
  message: string
}

export function useRankedKeywords(
  overview: DomainOverview,
  { canBuy, onSpent, onOff }: { canBuy: boolean; onSpent: () => void; onOff: (err: unknown) => void },
) {
  const [controls, setControls] = React.useState<KeywordControls>(DEFAULT_KEYWORD_CONTROLS)
  const [rows, setRows] = React.useState<DomainKeywordRow[]>(overview.top_keywords)
  const [next, setNext] = React.useState<number | null>(() => overviewNextOffset(overview, RANKED_PAGE))
  const [loading, setLoading] = React.useState(false)
  const [problem, setProblem] = React.useState<KeywordsProblem | null>(null)
  const asked = React.useRef(0)
  const latest = React.useRef({ canBuy, onSpent, onOff })
  React.useEffect(() => {
    latest.current = { canBuy, onSpent, onOff }
  })

  const load = React.useCallback(
    async (c: KeywordControls, offset: number) => {
      const ask = ++asked.current
      setProblem(null)
      if (offset === 0 && overviewServes(c)) {
        setRows(overview.top_keywords)
        setNext(overviewNextOffset(overview, RANKED_PAGE))
        setLoading(false)
        return
      }
      if (!latest.current.canBuy) return
      setLoading(true)
      if (offset === 0) setRows([])
      try {
        const page = await fetchRankedKeywords({
          target: overview.domain,
          market: { location_code: overview.location_code, language_code: overview.language_code },
          offset,
          sort_by: c.sort,
          min_search_volume: c.minSearches,
          max_rank: maxRankOf(c.rank),
          exclude_terms: c.exclude,
        })
        if (ask !== asked.current) return
        if (!page.from_cache) latest.current.onSpent()
        setRows((r) => (offset ? [...r, ...page.rows] : page.rows))
        setNext(page.next_offset)
      } catch (err) {
        if (ask !== asked.current) return
        const failure = paidFailure(err)
        if (failure === 'off') latest.current.onOff(err)
        setProblem({
          kind: failure === 'limit' ? 'limit' : failure === 'field' ? 'field' : 'failed',
          message: failure === 'failed' ? 'Could not load the keywords.' : errorMessage(err, 'Could not load the keywords.'),
        })
      } finally {
        if (ask === asked.current) setLoading(false)
      }
    },
    [overview],
  )

  const current = React.useRef(controls)
  const change = React.useCallback(
    (patch: Partial<KeywordControls>) => {
      const nextControls = { ...current.current, ...patch }
      current.current = nextControls
      setControls(nextControls)
      void load(nextControls, 0)
    },
    [load],
  )
  const more = React.useCallback(() => {
    if (next !== null) void load(current.current, next)
  }, [load, next])
  const retry = React.useCallback(() => void load(current.current, 0), [load])

  return { controls, change, rows, next, loading, problem, more, retry }
}

export type RankedKeywordsState = ReturnType<typeof useRankedKeywords>

export function KeywordsTab({ state, blockedReason }: { state: RankedKeywordsState; blockedReason: string | null }) {
  const { controls, change, rows, next, loading, problem } = state
  const [term, setTerm] = React.useState('')
  const off = !!blockedReason
  const addTerm = () => {
    const t = excludeTerm(term, controls.exclude)
    setTerm('')
    if (!t || controls.exclude.length >= EXCLUDE_TERMS_MAX) return
    change({ exclude: [...controls.exclude, t] })
  }
  const fieldError = problem?.kind === 'field' ? problem.message : null
  return (
    <div data-seo-keywords="" className="@container">
      <div
        className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', off && 'pointer-events-none opacity-50')}
        title={blockedReason ?? 'Sorting or filtering looks the keywords up again: a small charge, unless asked in the last 12 hours'}
        aria-disabled={off || undefined}
      >
        <FilterChips label="Sort keywords" options={KEYWORD_SORT_OPTIONS} value={controls.sort} onChange={(sort) => change({ sort })} />
        <span aria-hidden className="h-4 w-px bg-border" />
        <FilterChips label="Position" options={RANK_OPTIONS} value={controls.rank} onChange={(rank) => change({ rank })} />
        <Select value={String(controls.minSearches)} onValueChange={(v) => change({ minSearches: Number(v) })}>
          <SelectTrigger data-seo-min-searches="" aria-label="Fewest searches a month" className="h-7 w-auto gap-1.5 rounded-lg border-0 px-2.5 text-xs text-muted-foreground shadow-none hover:bg-muted/60 hover:text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {MIN_SEARCH_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={String(o.value)} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-2 space-y-1">
        <div className={cn('flex flex-wrap items-center gap-1.5', off && 'opacity-50')}>
          <Input
            data-seo-exclude=""
            value={term}
            disabled={off || controls.exclude.length >= EXCLUDE_TERMS_MAX}
            title={blockedReason ?? (controls.exclude.length >= EXCLUDE_TERMS_MAX ? `At most ${EXCLUDE_TERMS_MAX} words` : 'Leave out searches with this word, like the site’s own name')}
            placeholder="Leave out searches with…"
            aria-label="Leave out searches with this word"
            aria-invalid={fieldError ? true : undefined}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTerm()
              }
            }}
            className="h-7 w-56 text-xs"
          />
          {controls.exclude.map((t) => (
            <span key={t} data-seo-excluded={t} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {t}
              <button
                type="button"
                aria-label={`Show searches with ${t} again`}
                title="Show these searches again"
                disabled={off}
                onClick={() => change({ exclude: controls.exclude.filter((x) => x !== t) })}
                className="-mr-0.5 rounded-full hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        {fieldError && (
          <p data-seo-keywords-error="" className="text-xs text-destructive">
            {fieldError}
          </p>
        )}
      </div>

      {problem?.kind === 'limit' && <NeutralBanner text={problem.message} />}

      {rows.length === 0 && loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 && problem?.kind === 'failed' ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-muted-foreground">{problem.message}</p>
          <button type="button" onClick={state.retry} className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">
            Try again
          </button>
        </div>
      ) : rows.length === 0 && !problem ? (
        <p data-seo-keywords-empty="" className="py-10 text-center text-sm text-muted-foreground">
          No searches match.
        </p>
      ) : rows.length > 0 ? (
        <div className="mt-3">
          <div aria-hidden className={cn(GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
            <span>Search</span>
            <span className="text-right" title="Where the site shows in Google’s results: lower is better">
              Position
            </span>
            <span className="text-right" title="Average searches a month">
              Searches
            </span>
            <span className="text-right" title={ESTIMATE}>
              Visits
            </span>
            <span className="hidden pl-3 @2xl:block">Page</span>
          </div>
          <ul>
            {rows.map((row, i) => (
              <KeywordRow key={`${row.keyword}-${i}`} row={row} />
            ))}
          </ul>
          {next !== null && (
            <div className="flex flex-col items-center gap-1 pt-3">
              <button
                type="button"
                data-seo-keywords-more=""
                disabled={loading || off}
                title={blockedReason ?? 'Loads the next hundred: a small charge, unless asked in the last 12 hours'}
                onClick={state.more}
                className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Show more'}
              </button>
              {problem?.kind === 'failed' && <p className="text-xs text-muted-foreground">Could not load more keywords.</p>}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function KeywordRow({ row }: { row: DomainKeywordRow }) {
  const path = keywordPath(row)
  return (
    <li data-seo-keyword-row={row.keyword} className={cn(GRID, 'rounded-md px-1 py-1 transition-colors hover:bg-muted/40')}>
      <span className="min-w-0 truncate text-xs text-foreground" title={row.keyword}>
        {row.keyword}
      </span>
      <span className="text-right text-xs tabular-nums text-muted-foreground" title={row.position === null ? 'Not known' : undefined}>
        {num(row.position)}
      </span>
      <span className="text-right text-xs tabular-nums text-muted-foreground">{num(row.search_volume)}</span>
      <span className="text-right text-xs tabular-nums text-foreground" title={ESTIMATE}>
        {num(row.traffic)}
      </span>
      <span className="hidden min-w-0 pl-3 @2xl:block">
        {row.url ? (
          <a href={row.url} target="_blank" rel="noreferrer noopener" title={row.url} className="block truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {path}
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </span>
    </li>
  )
}

/** A 402's sentence: not an error, the page stays usable. */
export function NeutralBanner({ text }: { text: string }) {
  return (
    <p data-seo-limit="" className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      {text}
    </p>
  )
}
