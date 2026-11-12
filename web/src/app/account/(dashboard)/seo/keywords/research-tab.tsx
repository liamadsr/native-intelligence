'use client'

/**
 * The Keywords page's Research tab.
 *
 *   The start control   one field, the market, a small Options popover and
 *                       "Find keywords" (the button IS the request: no
 *                       dialog). Enter submits. Disabled, saying why, when
 *                       lookups are off here.
 *   First run           nothing looked up yet: what research does, in plain
 *                       words. Once there are past lookups, a quiet Recent
 *                       list instead, each one reopening its stored result
 *                       for free (GET lookups/[id]).
 *   While it runs       the run rail (a lookup takes a few seconds, up to ~40).
 *   A result            a quiet line (how many, for what, where, when; a
 *                       stored one offers Refresh, which buys again), under
 *                       it, when part of the lookup could not be read, the
 *                       server's note on what is missing (Refresh offered
 *                       then too, to look the whole of it up again), the
 *                       filters and sort (client side, by the helper the
 *                       tools share), then the rows. Selecting rows floats
 *                       the selection island: Save (an optional tag) and,
 *                       for one keyword, Check results.
 *
 * Reads: the recent lookups on mount and after each bought lookup, with a
 * request counter so a slow answer never overwrites a newer one.
 */
import * as React from 'react'
import { KeyRound, Loader2, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { KeywordResearchResult, SeoMarketOptions } from '@/lib/seo/keywords/view'
import { normalizeTags } from '@/lib/seo/keywords/view'
import type { SeoLookupSummary } from '@/lib/seo/lookup-view'
import type { SeoSpendView } from '@/lib/seo/spend-view'
import { cn } from '@/lib/utils'
import { errorMessage } from '../api'
import { CenteredLoader } from '../load-states'
import { SeoDataNotice, buyBlockedReason } from '../shared/data-status'
import { PartialNote, partialNoteText } from '../shared/partial-note'
import { RunRail } from '../shared/run-rail'
import { FilterChips } from '../shared/tab-pills'
import { relativeWhen } from '../ui-helpers'
import { fetchRecentResearch, fetchStoredResearch, isFieldError, researchKeywords, saveKeywords, type ResearchAsk } from './api'
import { FilterField, MarketPicker, SmallSelect } from './controls'
import {
  DEFAULT_OPTIONS,
  INTENT_FILTER_OPTIONS,
  LIMIT_OPTIONS,
  MAX_DIFFICULTY_OPTIONS,
  MIN_VOLUME_OPTIONS,
  MODE_OPTIONS,
  NO_FILTERS,
  RESEARCH_SORT_OPTIONS,
  changedOptions,
  filtersActive,
  marketLabel,
  resultLine,
  savedToast,
  storedToResult,
  visibleRows,
  type Market,
  type ResearchFilterState,
  type ResearchOptions,
} from './keyword-helpers'
import { ISLAND_BUTTON, KeywordGridHeader, KeywordGridRow, SelectionIsland, ShowMore } from './keyword-rows'
import { ProblemBanner, problemOf, type Problem } from './problem'
import type { SerpTarget } from './serp-sheet'

/** Rows drawn at a time; "Show more" draws the next. */
const PAGE = 100

export function ResearchTab({
  markets,
  market,
  onMarket,
  view,
  spendLoading,
  onSpent,
  onCheckResults,
  onSaved,
}: {
  markets: SeoMarketOptions
  market: Market
  onMarket: (next: Market) => void
  view: SeoSpendView | null
  spendLoading: boolean
  /** A lookup was bought, or refused for data being off: read the spend view again. */
  onSpent: () => void
  onCheckResults: (target: SerpTarget) => void
  /** Keywords were saved: the Saved tab reads again. */
  onSaved: () => void
}) {
  const blocked = buyBlockedReason(view)
  const [seed, setSeed] = React.useState('')
  const [options, setOptions] = React.useState<ResearchOptions>(DEFAULT_OPTIONS)
  const [busy, setBusy] = React.useState(false)
  const [running, setRunning] = React.useState<ResearchAsk | null>(null)
  const [fieldError, setFieldError] = React.useState<string | null>(null)
  const [problem, setProblem] = React.useState<{ problem: Problem; ask: ResearchAsk; refresh: boolean } | null>(null)
  const [result, setResult] = React.useState<KeywordResearchResult | null>(null)
  const [ask, setAsk] = React.useState<ResearchAsk | null>(null)
  const [filters, setFilters] = React.useState<ResearchFilterState>(NO_FILTERS)
  const [shown, setShown] = React.useState(PAGE)
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set())
  const [recent, setRecent] = React.useState<SeoLookupSummary[] | null>(null)
  const [recentFailed, setRecentFailed] = React.useState(false)
  const [opening, setOpening] = React.useState<string | null>(null)
  const asked = React.useRef(0)
  const recentAsked = React.useRef(0)

  const loadRecent = React.useCallback(async () => {
    const n = ++recentAsked.current
    setRecentFailed(false)
    try {
      const rows = await fetchRecentResearch()
      if (n === recentAsked.current) setRecent(rows)
    } catch {
      if (n === recentAsked.current) {
        setRecentFailed(true)
        setRecent((r) => r ?? [])
      }
    }
  }, [])

  React.useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  const show = React.useCallback((next: KeywordResearchResult, nextAsk: ResearchAsk) => {
    setResult(next)
    setAsk(nextAsk)
    setFilters((f) => ({ ...NO_FILTERS, sort: next.data_provider === 'google_ads' && f.sort === 'keyword_difficulty' ? 'search_volume' : f.sort }))
    setShown(PAGE)
    setSelected(new Set())
  }, [])

  const run = React.useCallback(
    async (nextAsk: ResearchAsk, refresh: boolean) => {
      const n = ++asked.current
      setBusy(true)
      setRunning(nextAsk)
      setFieldError(null)
      setProblem(null)
      try {
        const next = await researchKeywords(nextAsk, { refresh })
        if (n !== asked.current) return
        show(next, nextAsk)
        if (!next.from_cache) {
          onSpent()
          void loadRecent()
        }
      } catch (err) {
        if (n !== asked.current) return
        if (isFieldError(err)) {
          setFieldError(errorMessage(err, 'Check what you typed.'))
          return
        }
        const p = problemOf(err, 'Could not find keywords just now.')
        setProblem({ problem: p, ask: nextAsk, refresh })
        if (p.tone === 'neutral') onSpent()
      } finally {
        if (n === asked.current) {
          setBusy(false)
          setRunning(null)
        }
      }
    },
    [show, onSpent, loadRecent],
  )

  const submit = () => {
    const text = seed.trim()
    if (busy || !text || blocked) return
    void run({ seed: text, ...market, ...options }, false)
  }

  const reopen = async (lookup: SeoLookupSummary) => {
    setOpening(lookup.id)
    setProblem(null)
    try {
      const { result: stored, ask: storedAsk } = storedToResult(await fetchStoredResearch(lookup.id))
      show(stored, storedAsk)
      setSeed(storedAsk.seed)
    } catch (err) {
      toast.error('Could not open that lookup', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setOpening(null)
    }
  }

  const loading = recent === null || spendLoading
  if (loading && !result) return <CenteredLoader />

  return (
    <div data-kw-research="">
      <StartControl
        seed={seed}
        onSeed={(next) => {
          setSeed(next)
          if (fieldError) setFieldError(null)
        }}
        markets={markets}
        market={market}
        onMarket={onMarket}
        options={options}
        onOptions={setOptions}
        busy={busy}
        blocked={blocked}
        fieldError={fieldError}
        onSubmit={submit}
      />

      {running && (
        <RunRail verb="Finding keywords" clauses={[`“${running.seed}”`, marketLabel(running)]} className="mx-0 mb-0 mt-3" />
      )}
      {problem && (
        <ProblemBanner
          className="mt-3"
          problem={problem.problem}
          onRetry={blocked ? undefined : () => void run(problem.ask, problem.refresh)}
        />
      )}

      {result && ask ? (
        <ResultList
          result={result}
          ask={ask}
          filters={filters}
          onFilters={(next) => {
            setFilters(next)
            setShown(PAGE)
          }}
          shown={shown}
          onShowMore={() => setShown((s) => s + PAGE)}
          selected={selected}
          onSelected={setSelected}
          busy={busy}
          blocked={blocked}
          onRefresh={() => void run(ask, true)}
          onCheckResults={onCheckResults}
          onSaved={onSaved}
        />
      ) : (
        <>
          {view && !view.can_buy ? (
            <SeoDataNotice view={view} what="Keyword data" className="py-10" />
          ) : (recent?.length ?? 0) === 0 && !busy ? (
            <FirstRun />
          ) : null}
          {recent && recent.length > 0 && <RecentList lookups={recent} opening={opening} onOpen={(l) => void reopen(l)} />}
          {recentFailed && (
            <p className="mt-4 text-xs text-muted-foreground">
              Could not load your recent lookups.{' '}
              <button type="button" onClick={() => void loadRecent()} className="text-foreground underline-offset-2 hover:underline">
                Try again
              </button>
            </p>
          )}
        </>
      )}
    </div>
  )
}

function StartControl({
  seed,
  onSeed,
  markets,
  market,
  onMarket,
  options,
  onOptions,
  busy,
  blocked,
  fieldError,
  onSubmit,
}: {
  seed: string
  onSeed: (next: string) => void
  markets: SeoMarketOptions
  market: Market
  onMarket: (next: Market) => void
  options: ResearchOptions
  onOptions: (next: ResearchOptions) => void
  busy: boolean
  blocked: string | null
  fieldError: string | null
  onSubmit: () => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-kw-seed=""
          value={seed}
          disabled={!!blocked}
          title={blocked ?? undefined}
          placeholder="A topic, product or phrase"
          aria-label="A topic, product or phrase"
          aria-invalid={fieldError ? true : undefined}
          spellCheck={false}
          onChange={(e) => onSeed(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onSubmit()
            }
          }}
          className="h-8 min-w-48 flex-1 basis-56 text-sm"
        />
        <div className="flex items-center gap-2">
          <MarketPicker options={markets} value={market} onChange={onMarket} disabled={!!blocked} />
          <OptionsPopover
            options={options}
            onChange={onOptions}
            adsOnly={markets.locations.find((l) => l.code === market.location_code)?.keyword_data === 'google_ads'}
            disabled={!!blocked}
          />
          <Button
            size="sm"
            data-kw-find=""
            className="h-8 shrink-0"
            disabled={busy || !seed.trim() || !!blocked}
            title={blocked ?? 'Look up the searches people make around it'}
            onClick={onSubmit}
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Find keywords
          </Button>
        </div>
      </div>
      {fieldError && (
        <p data-kw-seed-error="" className="text-xs text-destructive">
          {fieldError}
        </p>
      )}
    </div>
  )
}

/** Mode, how many, close variants: out of the way, the defaults untouched unless opened. */
function OptionsPopover({
  options,
  onChange,
  adsOnly,
  disabled,
}: {
  options: ResearchOptions
  onChange: (next: ResearchOptions) => void
  adsOnly: boolean
  disabled: boolean
}) {
  const changed = changedOptions(options)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-kw-options=""
          disabled={disabled}
          className={cn('h-8 shrink-0 gap-1.5 px-2 text-xs', changed > 0 ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
          title="How to look"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Options
          {changed > 0 && <span className="text-[10px] tabular-nums opacity-70">{changed}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3" data-kw-options-panel="">
        {adsOnly && <p className="text-[11px] leading-relaxed text-muted-foreground">This country has one source of keyword data, so the kind of search does not apply.</p>}
        <div className="space-y-1.5">
          <p id="kw-mode" className="text-xs text-muted-foreground">
            Which searches
          </p>
          <div role="radiogroup" aria-labelledby="kw-mode" className="flex flex-col">
            {MODE_OPTIONS.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={options.mode === m.value}
                data-kw-mode={m.value}
                disabled={adsOnly}
                title={m.hint}
                onClick={() => onChange({ ...options, mode: m.value })}
                className={cn(
                  'flex w-full items-center rounded-lg px-2 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  options.mode === m.value ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                {m.label}
                {m.value === 'auto' && <span className="ml-auto text-[11px] text-muted-foreground">recommended</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">How many</p>
          <FilterChips
            label="How many keywords"
            options={LIMIT_OPTIONS.map((n) => ({ value: String(n), label: n.toLocaleString() }))}
            value={String(options.result_limit)}
            onChange={(v) => onChange({ ...options, result_limit: Number(v) as ResearchOptions['result_limit'] })}
          />
          <p className="text-[11px] text-muted-foreground">More keywords cost a little more.</p>
        </div>
        <label className={cn('flex items-start gap-2 text-xs', adsOnly ? 'cursor-not-allowed opacity-50' : 'cursor-pointer text-foreground')}>
          <Checkbox
            data-kw-group=""
            checked={options.group_keywords}
            disabled={adsOnly}
            onCheckedChange={(v) => onChange({ ...options, group_keywords: v === true })}
            className="mt-px h-3.5 w-3.5"
          />
          <span>
            Keep close variants
            <span className="block text-[11px] text-muted-foreground">Spellings and plurals that share one number</span>
          </span>
        </label>
      </PopoverContent>
    </Popover>
  )
}

function FirstRun() {
  return (
    <div data-kw-first-run="" className="mx-auto flex max-w-lg flex-col items-center gap-3 px-1 py-14 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
        <KeyRound className="h-4 w-4" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Find the words people search for</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Type what you sell or write about and get the searches people make around it on Google, with how many people
          search each one a month and how hard each is to reach the first page for. Each lookup is bought; the same one
          again within a day is free.
        </p>
      </div>
    </div>
  )
}

function RecentList({ lookups, opening, onOpen }: { lookups: SeoLookupSummary[]; opening: string | null; onOpen: (lookup: SeoLookupSummary) => void }) {
  return (
    <div data-kw-recent="" className="mt-5">
      <p className="px-px text-[11px] font-medium text-muted-foreground">Recent</p>
      <ul className="mt-1 divide-y divide-border">
        {lookups.map((lookup) => {
          const when = relativeWhen(lookup.fetched_at)
          return (
            <li key={lookup.id} data-kw-recent-row={lookup.id}>
              <button
                type="button"
                disabled={opening !== null}
                onClick={() => onOpen(lookup)}
                title="Open this lookup again (free)"
                className="group flex w-full items-center gap-3 py-2 text-left disabled:cursor-wait"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-foreground group-hover:underline">{lookup.label ?? 'Keyword research'}</span>
                {opening === lookup.id ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  when && <span className="shrink-0 text-xs text-muted-foreground">{when}</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ResultList({
  result,
  ask,
  filters,
  onFilters,
  shown,
  onShowMore,
  selected,
  onSelected,
  busy,
  blocked,
  onRefresh,
  onCheckResults,
  onSaved,
}: {
  result: KeywordResearchResult
  ask: ResearchAsk
  filters: ResearchFilterState
  onFilters: (next: ResearchFilterState) => void
  shown: number
  onShowMore: () => void
  selected: ReadonlySet<string>
  onSelected: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>
  busy: boolean
  blocked: string | null
  onRefresh: () => void
  onCheckResults: (target: SerpTarget) => void
  onSaved: () => void
}) {
  const full = result.data_provider !== 'google_ads'
  const rows = React.useMemo(() => visibleRows(result.rows, filters), [result.rows, filters])
  const page = rows.slice(0, shown)
  const market: Market = { location_code: result.location_code, language_code: result.language_code }
  const when = relativeWhen(result.fetched_at)
  const active = filtersActive(filters)
  const toggle = (keyword: string) =>
    onSelected((prev) => {
      const next = new Set(prev)
      if (next.has(keyword)) next.delete(keyword)
      else next.add(keyword)
      return next
    })
  const pageKeys = page.map((r) => r.keyword)
  const allChecked = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k))
  const check = (keyword: string) => onCheckResults({ keyword, ...market })

  return (
    <div data-kw-result={result.lookup_id ?? ''} className={cn('mt-4', selected.size > 0 && 'pb-14')}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <p data-kw-result-line="" className="min-w-0 flex-1 truncate tabular-nums">
          {resultLine(result, rows.length)}
          {when && <span>{` · Looked up ${when}`}</span>}
        </p>
        {(result.from_cache || !!partialNoteText(result.partial)) && (
          <Button
            variant="ghost"
            size="sm"
            data-kw-refresh=""
            className="-my-1 h-7 shrink-0 text-xs"
            disabled={busy || !!blocked}
            title={blocked ?? `Buy this lookup again for fresh numbers (${ask.seed})`}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        )}
      </div>
      <PartialNote partial={result.partial} className="mt-1" />

      {result.rows.length === 0 ? (
        <p data-kw-none="" className="py-10 text-center text-sm text-muted-foreground">
          No keywords came back for “{result.seed}”. Try a shorter or broader phrase.
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <FilterField value={filters.text} onChange={(text) => onFilters({ ...filters, text })} placeholder="Filter keywords" attr="data-kw-filter-text" className="w-44" />
            <SmallSelect label="Searches a month" attr="data-kw-filter-volume" value={filters.minVolume} options={MIN_VOLUME_OPTIONS} onChange={(minVolume) => onFilters({ ...filters, minVolume })} />
            {full && (
              <SmallSelect label="Difficulty" attr="data-kw-filter-difficulty" value={filters.maxDifficulty} options={MAX_DIFFICULTY_OPTIONS} onChange={(maxDifficulty) => onFilters({ ...filters, maxDifficulty })} />
            )}
            {full && (
              <SmallSelect label="Intent" attr="data-kw-filter-intent" value={filters.intent} options={INTENT_FILTER_OPTIONS} onChange={(intent) => onFilters({ ...filters, intent })} />
            )}
            <SmallSelect
              label="Sort"
              attr="data-kw-sort"
              className="ml-auto"
              value={filters.sort}
              options={RESEARCH_SORT_OPTIONS.filter((o) => full || !o.needsDifficulty)}
              onChange={(sort) => onFilters({ ...filters, sort })}
            />
          </div>

          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p data-kw-no-match="" className="text-sm text-muted-foreground">
                No keywords match.
              </p>
              {active && (
                <button
                  type="button"
                  data-kw-clear-filters=""
                  onClick={() => onFilters({ ...NO_FILTERS, sort: filters.sort })}
                  className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="mt-3">
              <KeywordGridHeader
                full={full}
                allChecked={allChecked}
                someChecked={selected.size > 0}
                onToggleAll={() => onSelected(allChecked ? new Set() : new Set([...selected, ...pageKeys]))}
              />
              <ul>
                {page.map((row) => (
                  <KeywordGridRow
                    key={row.keyword}
                    rowId={row.keyword}
                    row={row}
                    full={full}
                    checked={selected.has(row.keyword)}
                    selecting={selected.size > 0}
                    onToggle={() => toggle(row.keyword)}
                    action={
                      <button
                        type="button"
                        data-kw-row-check=""
                        disabled={!!blocked}
                        title={blocked ?? `See who shows on Google for “${row.keyword}” now`}
                        onClick={() => check(row.keyword)}
                        className="h-5 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Check results
                      </button>
                    }
                  />
                ))}
              </ul>
              {rows.length > shown && <ShowMore loading={false} onClick={onShowMore} attr="data-kw-more" />}
            </div>
          )}
        </>
      )}

      <SelectionIsland
        count={selected.size}
        total={rows.length}
        onClear={() => onSelected(new Set())}
        onSelectAll={() => onSelected(new Set(rows.map((r) => r.keyword)))}
      >
        <SaveButton
          rows={result.rows.filter((r) => selected.has(r.keyword))}
          market={market}
          onSaved={() => {
            onSelected(new Set())
            onSaved()
          }}
        />
        {selected.size === 1 && (
          <Button
            variant="outline"
            size="sm"
            data-kw-island-check=""
            className={ISLAND_BUTTON}
            disabled={!!blocked}
            title={blocked ?? 'See who shows on Google for it now'}
            onClick={() => check([...selected][0])}
          >
            Check results
          </Button>
        )}
      </SelectionIsland>
    </div>
  )
}

/** "Save · 3": a small popover with an optional tag, then the save (free). */
function SaveButton({ rows, market, onSaved }: { rows: KeywordResearchResult['rows']; market: Market; onSaved: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [tag, setTag] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const save = async () => {
    if (saving || rows.length === 0) return
    setSaving(true)
    try {
      const out = await saveKeywords({ rows, ...market, tags: normalizeTags([tag]) })
      toast(savedToast(out.added, out.already_saved))
      setOpen(false)
      setTag('')
      onSaved()
    } catch (err) {
      toast.error('Could not save those keywords', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setSaving(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-kw-save="" className={ISLAND_BUTTON}>
          Save · {rows.length.toLocaleString()}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-64 space-y-2 p-3" data-kw-save-panel="">
        <label htmlFor="kw-save-tag" className="block text-xs text-muted-foreground">
          Tag (optional)
        </label>
        <Input
          id="kw-save-tag"
          data-kw-save-tag=""
          autoFocus
          value={tag}
          placeholder="e.g. linen"
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void save()
            }
          }}
          className="h-8 text-sm"
        />
        <div className="flex justify-end">
          <Button size="sm" data-kw-save-confirm="" className="h-7 text-xs" disabled={saving} onClick={() => void save()}>
            {saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Save {rows.length === 1 ? 'keyword' : `${rows.length.toLocaleString()} keywords`}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
