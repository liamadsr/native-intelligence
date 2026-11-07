'use client'

/**
 * The outcome chip — the one piece of vocabulary every Evals screen shares.
 *
 * Three states, and they are NOT a traffic light with a spare colour. `scored`
 * is the state that earns the whole component: every gate passed and a soft
 * threshold was missed, which is a suite making progress rather than a suite
 * that broke. Rendering it amber next to a red `failed` is the difference
 * between "keep going" and "you regressed something", and a shared chip is how
 * the index, the suite detail and the run detail stay agreed on which is which.
 *
 * `errored` is the fourth state a TRIAL can be in (a harness failure — the
 * route returned `skipped`, the judge had no credentials, the step ceiling
 * truncated a flush). It is deliberately grey, not red: a harness failure that
 * reads as a prompt regression is exactly the confusion spec §4.3 exists to
 * prevent.
 */

import { cn } from '@/lib/utils'
import type { RunOutcome, TrialOutcome } from '@/lib/evals/types'
import { OUTCOME_LABELS } from './ui-helpers'

/** Anything an `eval_run.outcome` or `eval_trial.outcome` column can hold,
 *  including the null a run that has not finished still has. */
export type ChipOutcome = RunOutcome | TrialOutcome | null | undefined

const OUTCOME_CLASS: Record<RunOutcome | 'errored', string> = {
  passed:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  scored: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  failed: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  // Grey, never red — see the module header.
  errored: 'border-border bg-muted/50 text-muted-foreground',
}

export function OutcomeChip({
  outcome,
  className,
  /** What to show for a run that has no outcome yet. Defaults to a dash rather
   *  than nothing, so a table column keeps its width while a run is queued. */
  pendingLabel = '—',
}: {
  outcome: ChipOutcome
  className?: string
  pendingLabel?: string
}) {
  if (!outcome) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground',
          className,
        )}
      >
        {pendingLabel}
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
        OUTCOME_CLASS[outcome],
        className,
      )}
    >
      {OUTCOME_LABELS[outcome]}
    </span>
  )
}
