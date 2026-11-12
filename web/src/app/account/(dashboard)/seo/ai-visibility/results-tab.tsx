'use client'

/**
 * A tracker's Results tab: the latest finished check, read from
 * GET …/runs/[id]?scope= (every page of its answers, so each question's
 * marks are whole).
 *
 *   scope           which questions count: those without the brand's name
 *                   (the honest measure, the default), those with it, or all
 *   over time       the share of answers naming the brand per check, with a
 *                   7 / 30 / 90 day range (only with two finished checks)
 *   by assistant    a thin share bar per engine and "named in N of M"
 *   you and others  the brand and each competitor, the same bar, by share
 *   by question     each question with a mark per engine in a fixed order
 *                   (named ✓, not named –, no answer ·, the reason in the
 *                   title); a row opens in place to each assistant's answer
 *                   as a short plain-text excerpt, and "Read the whole
 *                   answer" opens a sheet with the full text (plain text,
 *                   never markdown or HTML), where the brand was named, the
 *                   competitors named and the pages it cited.
 */
import * as React from 'react'
import { ChevronRight, ExternalLink, Loader2 } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { markdownToText } from '@/lib/seo/ai-visibility/evidence'
import { TREND_DAYS } from '@/lib/seo/ai-visibility/limits'
import type {
  AiAnswerDetail,
  AiAnswerRow,
  AiEngine,
  AiPromptScope,
  AiPromptShare,
  AiRunResults,
  AiRunView,
  AiTrackerView,
  AiTrend,
} from '@/lib/seo/ai-visibility/view'
import { AI_ENGINE_LABELS } from '@/lib/seo/shared/ai-visibility'
import { cn } from '@/lib/utils'
import { errorMessage } from '../api'
import { FilterChips } from '../shared/tab-pills'
import { TrendChart } from '../shared/trend-chart'
import { count, relativeWhen } from '../ui-helpers'
import { SCOPE_OPTIONS, answerMark, excerptText, markTitle, orderedEngines, pct, positionWords, urlWords, type AnswerMark } from './ai-helpers'
import { fetchAnswer, fetchRunResults } from './api'

/** Short engine names for the marks' column heads. */
export const ENGINE_SHORT: Record<AiEngine, string> = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  google_ai_overview: 'AI Overview',
  claude: 'Claude',
  perplexity: 'Perplexity',
}

const SECTION = 'text-xs font-medium text-foreground'
const BAR_GRID = 'grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3.5rem] items-center gap-3 @2xl:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_10rem_3.5rem]'
/** Pages of answers read for one check at most (5 engines × 50 questions is 250 answers, 5 pages). */
const MAX_PAGES = 10

/** The check's results and every one of its answers in this scope. */
export function useRunAnswers(runId: string | null, scope: AiPromptScope, version: number) {
  const [results, setResults] = React.useState<AiRunResults | null>(null)
  const [rows, setRows] = React.useState<AiAnswerRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [retry, setRetry] = React.useState(0)
  const asked = React.useRef(0)

  React.useEffect(() => {
    const ask = ++asked.current
    if (!runId) {
      setResults(null)
      setRows([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const first = await fetchRunResults(runId, { scope })
        if (ask !== asked.current) return
        let all = first.rows
        let next = first.next_offset
        for (let page = 1; next !== null && page < MAX_PAGES; page += 1) {
          const more = await fetchRunResults(runId, { scope, offset: next })
          if (ask !== asked.current) return
          all = [...all, ...more.rows]
          next = more.next_offset
        }
        setResults(first)
        setRows(all)
      } catch (err) {
        if (ask === asked.current) setError(errorMessage(err, 'Could not load the results.'))
      } finally {
        if (ask === asked.current) setLoading(false)
      }
    })()
  }, [runId, scope, version, retry])

  return { results, rows, loading, error, retry: () => setRetry((r) => r + 1) }
}

/** The answers by question, then engine. */
export function answersByPrompt(rows: readonly AiAnswerRow[]): Map<string, Map<AiEngine, AiAnswerRow>> {
  const out = new Map<string, Map<AiEngine, AiAnswerRow>>()
  for (const row of rows) {
    const byEngine = out.get(row.prompt_id) ?? new Map<AiEngine, AiAnswerRow>()
    byEngine.set(row.engine, row)
    out.set(row.prompt_id, byEngine)
  }
  return out
}

export function ResultsTab({
  tracker,
  run,
  version,
  trend,
  trendDays,
  onTrendDays,
}: {
  tracker: AiTrackerView
  /** The latest finished check, or null before the first. */
  run: AiRunView | null
  version: number
  /** The trend, only once there are two finished checks to draw. */
  trend: AiTrend | null
  trendDays: number
  onTrendDays: (days: number) => void
}) {
  const [scope, setScope] = React.useState<AiPromptScope>('neutral')
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())
  const [sheet, setSheet] = React.useState<AiAnswerRow | null>(null)
  const { results, rows, loading, error, retry } = useRunAnswers(run?.id ?? null, scope, version)
  const byPrompt = React.useMemo(() => answersByPrompt(rows), [rows])

  if (!run) {
    return (
      <div data-seo-results-empty="" className="py-10 text-center">
        <p className="text-sm font-medium text-foreground">No answers yet</p>
        <p className="mt-1 text-xs text-muted-foreground">They show here after the first check.</p>
      </div>
    )
  }

  const engines = orderedEngines(run.engines)
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div data-seo-results="" data-seo-scope={scope} className="@container space-y-6">
      <div>
        <FilterChips label="Which questions count" options={SCOPE_OPTIONS} value={scope} onChange={setScope} />
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {scope === 'neutral'
            ? 'Questions without your name are the honest measure: a question that names you gets an answer about you anyway.'
            : scope === 'branded'
              ? 'Questions that name you: how the assistants describe you when asked directly.'
              : 'Every question, with and without your name.'}
        </p>
      </div>

      {trend && trend.runs.length > 0 && (
        <section data-seo-trend-block="">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className={SECTION}>Answers that name you, over time</h2>
            <FilterChips
              label="Range"
              options={TREND_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))}
              value={String(trendDays)}
              onChange={(v) => onTrendDays(Number(v))}
            />
          </div>
          <TrendChart
            dates={trend.runs.map((r) => r.created_at)}
            series={[{ key: 'named', label: 'Named you', values: trend.runs.map((r) => r.mention_rate), tone: 'text-emerald-600 dark:text-emerald-400' }]}
            summary={trendSummary(trend)}
            format={(v) => `${Math.round(v)}%`}
            emptyText={`Fewer than two checks in the last ${trend.days} days`}
          />
        </section>
      )}

      {loading && !results ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading the results" />
        </div>
      ) : error && !results ? (
        <p className="py-10 text-center text-xs text-muted-foreground">
          Could not load the results.{' '}
          <button type="button" onClick={retry} className="text-foreground underline-offset-2 hover:underline">
            Try again
          </button>
        </p>
      ) : results ? (
        <>
          {results.coverage.answered === 0 ? (
            <p data-seo-no-answers="" className="py-6 text-center text-xs text-muted-foreground">
              {results.coverage.expected === 0 ? 'This check asked no questions of this kind.' : 'No assistant answered these questions in this check.'}
            </p>
          ) : (
            <>
              <section data-seo-by-engine="">
                <h2 className={cn(SECTION, 'mb-1.5')}>By assistant</h2>
                <ul className="space-y-0.5">
                  {results.by_engine
                    .filter((e) => engines.includes(e.engine))
                    .sort((a, b) => engines.indexOf(a.engine) - engines.indexOf(b.engine))
                    .map((e) => (
                      <ShareRow
                        key={e.engine}
                        id={e.engine}
                        name={e.label}
                        rate={e.mention_rate}
                        detail={e.answered > 0 ? `named in ${e.mentioned.toLocaleString()} of ${count(e.answered, 'answer')}` : 'no answers came back'}
                      />
                    ))}
                </ul>
              </section>

              {results.brands.length > 1 && (
                <section data-seo-brands="">
                  <h2 className={cn(SECTION, 'mb-1.5')}>You and the others</h2>
                  <ul className="space-y-0.5">
                    {[...results.brands]
                      .sort((a, b) => (b.mention_rate ?? -1) - (a.mention_rate ?? -1) || Number(b.own) - Number(a.own))
                      .map((b) => (
                        <ShareRow
                          key={b.domain}
                          id={b.domain}
                          name={b.name}
                          you={b.own}
                          rate={b.mention_rate}
                          detail={b.answers > 0 ? `named in ${b.mentions.toLocaleString()} of ${count(b.answers, 'answer')}` : 'no answers came back'}
                        />
                      ))}
                  </ul>
                  {results.gaps.length > 0 && (
                    <p data-seo-gaps="" className="mt-1.5 text-[11px] text-muted-foreground">
                      {results.gaps.length === 1 ? 'One question gets' : `${results.gaps.length.toLocaleString()} questions get`} answers that name a competitor and not you.
                    </p>
                  )}
                </section>
              )}
            </>
          )}

          {results.by_prompt.length > 0 && (
            <section data-seo-by-question="">
              <div className="mb-1 flex items-center gap-3 px-1">
                <h2 className={cn(SECTION, 'min-w-0 flex-1')}>By question</h2>
                <span aria-hidden className="flex shrink-0 items-center">
                  {engines.map((e) => (
                    <span key={e} className="w-14 truncate text-center text-[10px] text-muted-foreground" title={AI_ENGINE_LABELS[e]}>
                      {ENGINE_SHORT[e]}
                    </span>
                  ))}
                </span>
                <span className="w-3.5 shrink-0" aria-hidden />
              </div>
              <ul className="divide-y divide-border">
                {results.by_prompt.map((p) => (
                  <QuestionRow
                    key={p.prompt_id}
                    share={p}
                    engines={engines}
                    answers={byPrompt.get(p.prompt_id) ?? new Map()}
                    open={expanded.has(p.prompt_id)}
                    onToggle={() => toggle(p.prompt_id)}
                    onRead={setSheet}
                  />
                ))}
              </ul>
              <p className="mt-2 px-1 text-[11px] text-muted-foreground">
                <span className="text-emerald-600 dark:text-emerald-400">✓</span> named you, – answered without naming you, · no answer
              </p>
            </section>
          )}
        </>
      ) : null}

      <AnswerSheet row={sheet} tracker={tracker} onClose={() => setSheet(null)} />
    </div>
  )
}

function trendSummary(trend: AiTrend): string {
  const points = trend.runs.filter((r) => r.mention_rate !== null)
  if (points.length === 0) return 'No finished checks to draw yet.'
  const first = points[0].mention_rate!
  const last = points[points.length - 1].mention_rate!
  return `The share of answers naming you over ${count(points.length, 'check')} in the last ${trend.days} days, from ${Math.round(first)}% to ${Math.round(last)}%.`
}

/** One engine or brand with its share of answers naming it, as a thin bar. */
function ShareRow({ id, name, rate, detail, you }: { id: string; name: string; rate: number | null; detail: string; you?: boolean }) {
  const shown = pct(rate)
  return (
    <li data-seo-share-row={id} className={cn(BAR_GRID, 'rounded-md px-1 py-1 hover:bg-muted/40')}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-xs text-foreground" title={name}>
          {name}
        </span>
        {you && (
          <span data-seo-you="" className="inline-flex shrink-0 items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
            You
          </span>
        )}
      </span>
      <span className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={shown ? `${name}: ${shown} of answers` : `${name}: no answers`}>
        {rate !== null && rate > 0 && <span className="block h-full rounded-full bg-emerald-500 dark:bg-emerald-400" style={{ width: `${Math.min(100, rate)}%`, minWidth: 2 }} />}
      </span>
      <span className="hidden truncate text-right text-[11px] tabular-nums text-muted-foreground @2xl:block">{detail}</span>
      <span className="text-right text-xs font-medium tabular-nums text-foreground" title={detail}>
        {shown ?? '—'}
      </span>
    </li>
  )
}

const MARK_GLYPH: Record<AnswerMark, string> = { named: '✓', not_named: '–', no_answer: '·', waiting: '…' }
const MARK_TONE: Record<AnswerMark, string> = {
  named: 'font-semibold text-emerald-600 dark:text-emerald-400',
  not_named: 'text-muted-foreground',
  no_answer: 'font-bold text-muted-foreground',
  waiting: 'text-muted-foreground',
}

export function Mark({ engine, row }: { engine: AiEngine; row: AiAnswerRow | null | undefined }) {
  const mark = answerMark(row)
  const title = markTitle(engine, row)
  return (
    <span data-seo-mark={engine} data-seo-mark-value={mark} title={title} aria-label={title} className={cn('w-14 text-center text-sm leading-none tabular-nums', MARK_TONE[mark])}>
      {MARK_GLYPH[mark]}
    </span>
  )
}

function QuestionRow({
  share,
  engines,
  answers,
  open,
  onToggle,
  onRead,
}: {
  share: AiPromptShare
  engines: AiEngine[]
  answers: Map<AiEngine, AiAnswerRow>
  open: boolean
  onToggle: () => void
  onRead: (row: AiAnswerRow) => void
}) {
  const late = [...answers.values()].some((a) => a.late)
  const bodyId = `seo-ai-question-${share.prompt_id}`
  return (
    <li data-seo-question-row={share.prompt_id}>
      <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle} className="group flex w-full items-center gap-3 rounded-md px-1 py-2 text-left hover:bg-muted/40">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate text-xs text-foreground group-hover:underline" title={share.prompt}>
            {share.prompt}
          </span>
          {late && (
            <span data-seo-late="" title="An answer came in after the check finished" className="inline-flex shrink-0 items-center rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
              late
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center">
          {engines.map((e) => (
            <Mark key={e} engine={e} row={answers.get(e)} />
          ))}
        </span>
        <ChevronRight aria-hidden className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
      </button>
      {open && (
        <div id={bodyId} data-seo-question-body={share.prompt_id} className="space-y-3 pb-4 pl-1 pr-6">
          {engines.map((e) => {
            const row = answers.get(e)
            return row ? <AnswerExcerpt key={e} row={row} onRead={() => onRead(row)} /> : null
          })}
          {answers.size === 0 && <p className="text-xs text-muted-foreground">No answers for this question in this check.</p>}
        </div>
      )}
    </li>
  )
}

/** What one assistant said, in short: its verdict, the competitors it named, a clamped excerpt. */
function AnswerExcerpt({ row, onRead }: { row: AiAnswerRow; onRead: () => void }) {
  const answered = row.answer_status === 'answered'
  const [detail, setDetail] = React.useState<AiAnswerDetail | null>(null)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (!answered) return
    let alive = true
    fetchAnswer(row.id)
      .then((d) => {
        if (alive) setDetail(d)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [row.id, answered])

  const verdict = answered
    ? row.brand_mentioned
      ? [positionWords(row.brand_position) ?? 'Named you', row.brand_cited ? 'cited your site' : null].filter(Boolean).join(' · ')
      : row.brand_cited
        ? 'Cited your site without naming you'
        : 'Didn’t name you'
    : markTitle(row.engine, row).replace(`${AI_ENGINE_LABELS[row.engine]}: `, '').replace(/^./, (c) => c.toUpperCase())
  const excerpt = detail ? excerptText(detail.answer_markdown) : ''
  return (
    <div data-seo-answer={row.id} className="space-y-1">
      <p className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
        <span className="font-medium text-foreground">{AI_ENGINE_LABELS[row.engine]}</span>
        <span className={row.brand_mentioned ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>{verdict}</span>
        {row.competitors_named.length > 0 && <span className="text-muted-foreground">· names {row.competitors_named.join(', ')}</span>}
        {row.late && <span className="text-muted-foreground">· came in late</span>}
      </p>
      {answered &&
        (excerpt ? (
          <p data-seo-answer-excerpt="" className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
            {excerpt}
          </p>
        ) : failed ? (
          <p className="text-xs text-muted-foreground">Could not load this answer.</p>
        ) : !detail ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-label="Loading the answer" />
        ) : null)}
      {answered && (
        <button type="button" data-seo-read-answer={row.id} onClick={onRead} className="-ml-2 h-6 rounded-lg px-2 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground">
          Read the whole answer
        </button>
      )}
    </div>
  )
}

/** The answer's plain text with the brand's mentions marked (offsets from the route, over the same plain text). */
export function highlightSegments(text: string, spans: ReadonlyArray<{ start: number; end: number }>): Array<{ text: string; mark: boolean }> {
  const sorted = [...spans].filter((s) => s.end > s.start && s.start >= 0 && s.end <= text.length).sort((a, b) => a.start - b.start)
  const out: Array<{ text: string; mark: boolean }> = []
  let at = 0
  for (const s of sorted) {
    if (s.start < at) continue
    if (s.start > at) out.push({ text: text.slice(at, s.start), mark: false })
    out.push({ text: text.slice(s.start, s.end), mark: true })
    at = s.end
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false })
  return out
}

/** One answer in full (the prospecting list's sheet look), read with ?full=1. */
function AnswerSheet({ row, tracker, onClose }: { row: AiAnswerRow | null; tracker: AiTrackerView; onClose: () => void }) {
  const [detail, setDetail] = React.useState<AiAnswerDetail | null>(null)
  const [error, setError] = React.useState(false)
  const id = row?.id ?? null

  React.useEffect(() => {
    if (!id) return
    let alive = true
    setDetail(null)
    setError(false)
    fetchAnswer(id, true)
      .then((d) => {
        if (alive) setDetail(d)
      })
      .catch(() => {
        if (alive) setError(true)
      })
    return () => {
      alive = false
    }
  }, [id])

  const text = detail?.answer_markdown ? markdownToText(detail.answer_markdown) : ''
  const own = detail?.brands.find((b) => b.own) ?? null
  const spans = own ? (detail?.mentions.find((m) => m.domain === own.domain)?.spans ?? []) : []
  const others = detail?.brands.filter((b) => !b.own && (b.mentioned || b.cited)) ?? []

  return (
    <Sheet
      open={row !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <SheetContent
        side="right"
        aria-label="The whole answer"
        aria-describedby={undefined}
        data-seo-answer-sheet=""
        className="flex h-full w-full max-w-[520px] flex-col gap-0 border-l border-border p-0 sm:max-w-[520px]"
      >
        <SheetHeader className="flex h-12 shrink-0 flex-row items-center gap-2 space-y-0 border-b border-border px-4 text-left">
          <SheetTitle className="truncate text-sm font-semibold">{row ? `${AI_ENGINE_LABELS[row.engine]}’s answer` : 'Answer'}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {row && (
            <div className="space-y-4">
              <div>
                <p className="text-[11px] text-muted-foreground">The question</p>
                <p className="mt-0.5 text-xs text-foreground">{row.prompt}</p>
              </div>
              {!detail && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading the answer" />}
              {error && <p className="text-xs text-muted-foreground">Could not load this answer.</p>}
              {detail && (
                <>
                  <div className="space-y-1 text-xs">
                    <p data-seo-sheet-brand="" className={own?.mentioned ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                      {own?.mentioned
                        ? `${positionWords(own.position) ?? 'Named'}${spans.length > 1 ? `, ${spans.length.toLocaleString()} times` : ''}${own.cited ? ', and it cites your site' : ''}.${spans.length ? ' Marked below.' : ''}`
                        : own?.cited
                          ? `${tracker.brand_name} isn’t named, but the answer cites your site.`
                          : `${tracker.brand_name} isn’t named.`}
                    </p>
                    {others.length > 0 && (
                      <p data-seo-sheet-competitors="" className="text-muted-foreground">
                        Also names{' '}
                        {others.map((b, i) => (
                          <span key={b.domain}>
                            {i > 0 ? ', ' : ''}
                            <span className="text-foreground">{b.name}</span>
                            {b.position ? ` (${positionWords(b.position)?.replace('Named ', '')})` : ''}
                          </span>
                        ))}
                      </p>
                    )}
                    {row.collected_at && <p className="text-[11px] text-muted-foreground">Answered {relativeWhen(row.collected_at)}{row.model_name ? ` by ${row.model_name}` : ''}</p>}
                  </div>
                  {text ? (
                    <div data-seo-answer-text="" className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/20 px-3 py-2.5 text-xs leading-relaxed text-foreground">
                      {highlightSegments(text, spans).map((seg, i) =>
                        seg.mark ? (
                          <mark key={i} className="rounded-sm bg-emerald-500/20 px-0.5 text-foreground dark:bg-emerald-400/20">
                            {seg.text}
                          </mark>
                        ) : (
                          <React.Fragment key={i}>{seg.text}</React.Fragment>
                        ),
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">The answer had no text.</p>
                  )}
                  {detail.truncated && <p className="text-[11px] text-muted-foreground">The answer was longer than we keep; this is its start.</p>}
                  {detail.sources.length > 0 && (
                    <div>
                      <p className="text-[11px] font-medium text-foreground">Pages it cited</p>
                      <ul data-seo-sheet-sources="" className="mt-1 space-y-1">
                        {detail.sources.map((s) => (
                          <li key={`${s.position}-${s.url}`} className="flex min-w-0 items-baseline gap-2 text-xs">
                            <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{s.position}</span>
                            <a href={s.url} target="_blank" rel="noreferrer noopener" title={s.url} className="group flex min-w-0 items-baseline gap-1 text-foreground underline-offset-2 hover:underline">
                              <span className="min-w-0 truncate">{s.title || urlWords(s.url)}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 self-center text-muted-foreground" aria-hidden />
                            </a>
                            {s.title && <span className="hidden min-w-0 shrink truncate text-[11px] text-muted-foreground sm:inline">{s.domain}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
