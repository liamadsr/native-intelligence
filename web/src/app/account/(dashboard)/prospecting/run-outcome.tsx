'use client'

/**
 * What a finished run says for itself (§9 + §10, "Empty and failure states").
 *
 * Every terminal status gets its own sentence and its own affordance, because
 * the four are genuinely different situations and a shared "Run finished" line
 * would flatten the one that matters most:
 *
 *   completed          → the ledger sentence, built from `counts` — for a
 *                        DISCOVERY run only. A finished account-card or people
 *                        run renders NOTHING: the rows it wrote and the tab
 *                        count ("9 people") already say it, and a banner that
 *                        repeats the tab is the kind of thing Liam asked to
 *                        have removed.
 *   completed, 0 new   → "Nothing new this round…" (an EXHAUSTED ICP, not a
 *                        failure — the fix is editing the ICP, so that is what
 *                        the copy points at)
 *   budget_exhausted   → "Stopped early" + [Resume]
 *   failed             → the engine's own error text + [Retry]
 *   canceled           → "Cancelled — 9 kept", because the results survive and
 *                        a user who cancelled needs to be told they were not
 *                        thrown away
 *
 * THE LEDGER SENTENCE IS THE POINT. "24 candidates · 6 already in this list ·
 * 2 you dismissed · 4 already in your CRM · 12 new" is dedup made checkable in
 * one line — the same argument as the skipped row, at a glance instead of on
 * expand. Zero-valued clauses are dropped so a clean run reads "24 candidates ·
 * 24 new" rather than dragging four zeroes behind it.
 *
 * AND THE SAME FIVE STATES SAY DIFFERENT THINGS PER RUN KIND. An
 * `account_card` run discovers nothing and a `people` run's yield lives in
 * `people_found`, so the discovery ledger would report "0 candidates · 0 new"
 * on a run that just researched eighteen companies — the most alarming
 * possible way to describe a success. `targetedSummary` is that fork, and it
 * is applied to budget_exhausted, failed and canceled alike, because a partial
 * result has to be reported in the units it was produced in.
 *
 * `budget_exhausted` IS NOT STYLED AS AN ERROR. §9 is explicit that it is an
 * outcome: the run did what it was told, stopped where it was told to stop, and
 * kept everything. Painting it red would teach users to fear their own cap.
 */

import { AlertTriangle, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  ProspectingRunCounts,
  ProspectingRunKind,
  ProspectingRunProgress,
} from '@/lib/prospecting/types'
import { MONTHLY_CAP_ERROR } from '@/lib/prospecting/spend'
import type { RunPayload, SpendPayload } from './api'
import { formatResetDate } from './spend-meter'
import { peopleYieldLabel, readCounts, readProgress } from './ui-helpers'

/**
 * What a `budget_exhausted` run says when the WORKSPACE ceiling stopped it
 * rather than the run's own cap.
 *
 * The two share a status and nothing else. A per-run cap is the number the
 * user typed on the consent screen thirty seconds earlier, so "Stopped at your
 * $2.00 cap — 9 companies found" plus [Resume] [Raise cap] is exactly right.
 * The monthly ceiling is a WORKSPACE fact the user may never have seen, spent
 * partly by colleagues, and neither Resume nor Raise cap can do anything about
 * it — pressing Resume would queue a run that preflight refuses again, and
 * Raise cap would raise the wrong number, quietly widening the per-run budget
 * for a run that never gets to spend it.
 *
 * So this branch says the ceiling and the DATE IT LIFTS, and offers nothing.
 * "Try again on Oct 1" is the only true action available.
 *
 * Exported for its own test: the string is assembled from a constant, a run
 * column and a server timestamp, and it is the one sentence standing between a
 * user and a refusal they cannot otherwise explain.
 */
export function monthlyCapMessage(spend: SpendPayload | null): string {
  const resets = formatResetDate(spend?.resets_at)
  return resets
    ? `Prospecting is paused for this month — back on ${resets}`
    : 'Prospecting is paused for this month'
}

/**
 * What a completed run of each kind actually says.
 *
 * The discovery ledger sentence ("24 candidates · 6 already in this list · …")
 * is meaningless for the other two kinds: an account-card run discovers
 * nothing, so every clause in it is zero, and a people run's own number lives
 * in `people_found`. Rendering the discovery sentence for them would report
 * "0 candidates · 0 new" on a run that just researched eighteen companies —
 * the single most alarming way to describe a success.
 *
 * The people line states PARTIALITY by construction (§7 Stage 4): the yield is
 * genuinely 1–3 per company and often zero, so "Found 3 of the 5 roles you
 * asked for" is the honest headline rather than a shortfall to be hidden.
 */
export function targetedSummary(
  kind: ProspectingRunKind,
  progress: ProspectingRunProgress,
): string {
  if (kind === 'people') {
    const yieldLine = peopleYieldLabel(progress.people_found, progress.people_target)
    const searchedCount = progress.accounts_done || progress.accounts_total
    // "searched 0 companies" beside a real yield is a contradiction the engine
    // produces whenever it wrote `people_*` without an account tally — the
    // clause is dropped rather than rendered as a claim that cannot be true.
    const searched =
      searchedCount > 0
        ? `searched ${searchedCount} ${searchedCount === 1 ? 'company' : 'companies'}`
        : ''
    if (yieldLine && searched) return `${yieldLine} · ${searched}`
    if (yieldLine) return yieldLine
    return searched ? searched.charAt(0).toUpperCase() + searched.slice(1) : 'No people found'
  }
  const done = progress.accounts_done
  const total = progress.accounts_total
  if (total > 0 && done < total) {
    return `Researched ${done} of ${total} ${total === 1 ? 'company' : 'companies'}`
  }
  return `Researched ${done} ${done === 1 ? 'company' : 'companies'}`
}

/**
 * The completed-run ledger line, zero clauses dropped.
 *
 * Exported for its own test: this string is the feature's central claim in one
 * sentence, and it is assembled from two jsonb blobs that the engine writes
 * independently — exactly the shape that silently degrades to "0 candidates ·
 * 0 new" when a key gets renamed.
 */
export function completedSummary(
  progress: ProspectingRunProgress,
  counts: ProspectingRunCounts,
): string {
  const parts = [
    `${progress.found} ${progress.found === 1 ? 'candidate' : 'candidates'}`,
  ]
  if (counts.this_list > 0) parts.push(`${counts.this_list} already in this list`)
  if (counts.dismissed_global > 0) parts.push(`${counts.dismissed_global} you dismissed`)
  if (counts.crm > 0) parts.push(`${counts.crm} already in your CRM`)
  parts.push(`${progress.new} new`)
  return parts.join(' · ')
}

export function RunOutcome({
  run,
  busy = false,
  /** The workspace ceiling, for the `monthly_cap` branch's reset date. Null is
   *  fine — the copy falls back to the constant and drops the date clause. */
  spend = null,
  onResume,
  onRetry,
  onDismiss,
  onEditIcp,
}: {
  run: RunPayload
  busy?: boolean
  spend?: SpendPayload | null
  /** Start another run — the common case is simply wanting another slice. */
  onResume: () => void
  onRetry: () => void
  onDismiss: () => void
  /** The exhausted-ICP state's one-click route to the thing that would fix it. */
  onEditIcp: () => void
}) {
  const progress = readProgress(run.progress)
  const counts = readCounts(run.counts)

  const tone: 'neutral' | 'warning' =
    run.status === 'failed' ? 'warning' : 'neutral'

  let headline: React.ReactNode
  let actions: React.ReactNode = null

  // The three kinds report DIFFERENT numbers, and the discovery ledger reads
  // as a catastrophe on the other two (see `targetedSummary`). `kind` is a
  // real column on the run, so nothing has to be inferred from the progress
  // blob's shape.
  const targeted = run.kind === 'account_card' || run.kind === 'people'

  if (run.status === 'completed' && targeted) {
    // Nothing to add. The people tab's count and the rows the run wrote are
    // the result; "People finished · Found all 9 roles" beside "9 people" is
    // the same fact twice.
    return null
  } else if (run.status === 'completed' && progress.new === 0) {
    headline = (
      <>
        <span className="font-medium text-foreground">Nothing new this round.</span> Your list
        already has everything this ICP finds — try editing it.
      </>
    )
    actions = (
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onEditIcp}>
        Edit the ICP
      </Button>
    )
  } else if (run.status === 'completed') {
    headline = (
      <>
        <span className="font-medium text-foreground">Round {progress.round}</span> ·{' '}
        {completedSummary(progress, counts)}
      </>
    )
  } else if (run.status === 'budget_exhausted' && run.error === MONTHLY_CAP_ERROR) {
    // The WORKSPACE ceiling, not this run's cap. No Resume, no Raise cap —
    // see `monthlyCapMessage` for why both would be lies.
    headline = (
      <>
        <span className="font-medium text-foreground">{monthlyCapMessage(spend)}</span>
        {/* Whatever the run managed before preflight refused is still kept —
            a monthly refusal on a RESUMED run has real partial results. */}
        {!targeted && progress.new > 0 && (
          <> — {progress.new} {progress.new === 1 ? 'company' : 'companies'} kept.</>
        )}
        {targeted && progress.accounts_done > 0 && (
          <> — {targetedSummary(run.kind, progress).toLowerCase()}.</>
        )}
      </>
    )
  } else if (run.status === 'budget_exhausted') {
    headline = (
      <>
        <span className="font-medium text-foreground">Stopped early</span>{' '}
        {/* What was KEPT, in the units this kind actually produced. A people
            run parked at its cap has found people, not companies, and telling
            it "0 companies found" is how a partial success reads as a
            failure. */}
        — {targeted
          ? targetedSummary(run.kind, progress).toLowerCase()
          : `${progress.new} ${progress.new === 1 ? 'company' : 'companies'} found`}
        .
      </>
    )
    actions = (
      <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={onResume}>
        Resume
      </Button>
    )
  } else if (run.status === 'failed') {
    headline = (
      <>
        <span className="font-medium text-foreground">The run failed.</span>{' '}
        {run.error || 'Something went wrong.'}
        {targeted
          ? progress.accounts_done > 0 && ` ${targetedSummary(run.kind, progress).toLowerCase()}.`
          : progress.new > 0 && ` ${progress.new} kept.`}
      </>
    )
    actions = (
      <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy} onClick={onRetry}>
        <RotateCw className="mr-1 h-3 w-3" />
        Retry
      </Button>
    )
  } else if (run.status === 'canceled') {
    headline = (
      <>
        <span className="font-medium text-foreground">Cancelled</span> —{' '}
        {targeted ? targetedSummary(run.kind, progress).toLowerCase() : `${progress.new} kept`}.
      </>
    )
  } else {
    // queued / running / needs_input / canceling never reach here (the rail
    // owns live runs), so there is nothing honest to say about them.
    return null
  }

  return (
    <div
      className={cn(
        'mx-5 mb-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed',
        tone === 'warning'
          ? 'border-amber-500/40 bg-amber-500/5 text-muted-foreground'
          : 'border-border bg-muted/20 text-muted-foreground',
      )}
    >
      {tone === 'warning' && (
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
      )}
      <p className="min-w-0 flex-1">{headline}</p>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      <Button
        variant="ghost"
        size="icon"
        className="-my-1 h-6 w-6 shrink-0 text-muted-foreground"
        onClick={onDismiss}
        aria-label="Dismiss run result"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  )
}
