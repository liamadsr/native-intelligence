'use client'

/**
 * Live results for one keyword: who shows on Google for it now, in a sheet
 * (prospecting/list-detail.tsx's side sheet). Opening it IS the request
 * ("Check results" says so, and the spend line is on the page): POST serp,
 * then, while reads are still coming (partial or collecting), GET serp/[id]
 * every 3 s for free (./use-serp-poll.ts).
 *
 * A result: its best position (the reads are merged; "seen in 2 of 3 reads"
 * in its `title`), its title linking out and where it is (domain and path),
 * the snippet muted. Text from other sites is plain text, never HTML. The
 * page's other features (people also ask, a local pack) are named in one
 * quiet line under the results.
 *
 * A check with every read in and nothing found is kept for a few hours: it
 * reads as a calm "Nothing found for this search yet" under when it was
 * checked, with Refresh (which buys a new check), never as a failure. Only a
 * check dropped because every read failed (a 404 while polling) says
 * "Nothing came back".
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { SerpItem, SerpResult } from '@/lib/seo/keywords/view'
import { RunRail } from '../shared/run-rail'
import { count, relativeWhen } from '../ui-helpers'
import { checkSerp } from './api'
import { featureLabel, marketLabel, resultHref, resultWhere, seenIn, type Market } from './keyword-helpers'
import { ProblemBanner, problemOf, type Problem } from './problem'
import { useSerpPoll } from './use-serp-poll'

export interface SerpTarget extends Market {
  keyword: string
}

export function SerpSheet({
  target,
  onClose,
  blockedReason,
  onSpent,
}: {
  target: SerpTarget | null
  onClose: () => void
  /** Why buying is off now (a stored check still opens), or null. */
  blockedReason: string | null
  /** A check was bought (or refused for data being off): read the spend view again. */
  onSpent: () => void
}) {
  const [result, setResult] = React.useState<SerpResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [problem, setProblem] = React.useState<Problem | null>(null)
  const [gone, setGone] = React.useState(false)
  const asked = React.useRef(0)
  const onSpentRef = React.useRef(onSpent)
  onSpentRef.current = onSpent

  const run = React.useCallback(async (t: SerpTarget, refresh: boolean) => {
    const ask = ++asked.current
    setBusy(true)
    setProblem(null)
    setGone(false)
    if (refresh) setResult(null)
    try {
      const next = await checkSerp({ keyword: t.keyword, location_code: t.location_code, language_code: t.language_code, refresh })
      if (ask !== asked.current) return
      setResult(next)
      if (!next.from_cache) onSpentRef.current()
    } catch (err) {
      if (ask !== asked.current) return
      const p = problemOf(err, 'Could not check the results just now.')
      setProblem(p)
      if (p.dataOff || p.tone === 'neutral') onSpentRef.current()
    } finally {
      if (ask === asked.current) setBusy(false)
    }
  }, [])

  React.useEffect(() => {
    asked.current++
    setResult(null)
    setProblem(null)
    setGone(false)
    setBusy(false)
    if (target) void run(target, false)
  }, [target, run])

  const live = !!result && result.status !== 'complete'
  useSerpPoll(
    result?.lookup_id ?? null,
    live,
    (next) => setResult(next),
    () => setGone(true),
  )

  const organic = (result?.items ?? []).filter((item) => item.type === 'organic' && item.best_position !== null)
  const features = Array.from(new Set((result?.items ?? []).filter((item) => item.type !== 'organic').map((item) => featureLabel(item.type))))
  const when = result ? relativeWhen(result.fetched_at) : ''

  return (
    <Sheet open={!!target} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent side="right" data-kw-serp="" className="flex h-full w-full max-w-[520px] flex-col gap-0 border-l border-border p-0 sm:max-w-[520px]">
        <SheetHeader className="flex h-12 shrink-0 flex-row items-center gap-2 space-y-0 border-b border-border px-4 pr-12 text-left">
          <SheetTitle className="min-w-0 truncate text-sm font-semibold" title={target?.keyword}>
            {target?.keyword ?? 'Results'}
          </SheetTitle>
          <SheetDescription className="shrink-0 truncate text-xs text-muted-foreground">{target ? marketLabel(target) : ''}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {busy && !result ? (
            <RunRail verb="Reading Google’s results" clauses={['this can take up to a minute']} className="mx-0" />
          ) : problem ? (
            <ProblemBanner problem={problem} onRetry={target && !blockedReason ? () => void run(target, false) : undefined} />
          ) : gone ? (
            <div data-kw-serp-gone="" className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-muted-foreground">Nothing came back for this search.</p>
              {target && (
                <Button variant="outline" size="sm" disabled={!!blockedReason} title={blockedReason ?? 'Buys a new check'} onClick={() => void run(target, true)}>
                  Check again
                </Button>
              )}
            </div>
          ) : result ? (
            <>
              {live ? (
                <RunRail
                  verb="More reads coming…"
                  clauses={[`${result.reads_in} of ${count(result.reads_total, 'read')} in`]}
                  className="mx-0"
                />
              ) : (
                <div data-kw-serp-status="complete" className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <p className="min-w-0 flex-1 truncate">
                    {[organic.length > 0 ? `Top ${count(organic.length, 'result')}` : null, when ? `Checked ${when}` : null].filter(Boolean).join(' · ')}
                  </p>
                  {(result.from_cache || organic.length === 0) && target && (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-kw-serp-refresh=""
                      className="-my-1 h-7 shrink-0 text-xs"
                      disabled={busy || !!blockedReason}
                      title={blockedReason ?? 'Buys a new check of the results'}
                      onClick={() => void run(target, true)}
                    >
                      {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                      Refresh
                    </Button>
                  )}
                </div>
              )}
              {organic.length === 0 ? (
                !live && (
                  <p data-kw-serp-empty="" className="py-10 text-center text-sm text-muted-foreground">
                    Nothing found for this search yet.
                  </p>
                )
              ) : (
                <ol className="divide-y divide-border">
                  {organic.map((item, index) => (
                    <SerpRow key={`${item.domain}-${item.url}-${index}`} item={item} reads={result.reads_total} />
                  ))}
                </ol>
              )}
              {features.length > 0 && (
                <p data-kw-serp-features="" className="mt-3 text-[11px] text-muted-foreground">
                  Also on the page: {features.join(' · ')}
                </p>
              )}
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SerpRow({ item, reads }: { item: SerpItem; reads: number }) {
  const href = resultHref(item)
  const where = resultWhere(item)
  const title = item.title ?? where
  return (
    <li data-kw-serp-row={item.best_position ?? ''} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2 py-2">
      <span className="pt-px text-right text-sm tabular-nums text-muted-foreground" title={seenIn(item, reads)}>
        {item.best_position}
      </span>
      <span className="min-w-0">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer noopener" title={title} className="block truncate text-sm text-foreground underline-offset-2 hover:underline">
            {title}
          </a>
        ) : (
          <span className="block truncate text-sm text-foreground">{title}</span>
        )}
        <span className="block truncate text-xs text-muted-foreground" title={where}>
          {where}
        </span>
        {item.description && <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.description}</span>}
      </span>
    </li>
  )
}
