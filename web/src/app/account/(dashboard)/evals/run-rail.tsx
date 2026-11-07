'use client'

/**
 * The eval run rail — the prospecting `run-rail.tsx` idiom applied to a run of
 * `eval_run`.
 *
 *   `Cases 3` · `Attempts 7/12` · `grading`
 *   ≈$0.08 so far
 *
 * WHY NO PERCENTAGE: a run's unit is trials, and "7 of 12" is checkable while
 * "58%" is not. A stalled run is then visible as a number that stopped moving
 * rather than as a bar sitting at 90%.
 *
 * Every number comes from `eval_run.progress` (`RunProgress`: cases_total,
 * trials_total, trials_done, stage) — the same payload the poll already
 * returns. Nothing here asks the server for a field it does not already write.
 */

import { Loader2 } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { EvalRunRow } from '@/lib/evals/types'
import { formatCost, MODE_LABELS } from './ui-helpers'

/** `progress` is `RunProgress | Record<string, never>` — a run that has not
 *  reached its first step carries the empty object, so every field is read
 *  defensively rather than destructured. */
function readProgress(progress: EvalRunRow['progress']): {
  casesTotal: number
  trialsTotal: number
  trialsDone: number
  stage: string | null
} {
  const p = progress as Partial<{
    cases_total: number
    trials_total: number
    trials_done: number
    stage: string
  }>
  return {
    casesTotal: typeof p.cases_total === 'number' ? p.cases_total : 0,
    trialsTotal: typeof p.trials_total === 'number' ? p.trials_total : 0,
    trialsDone: typeof p.trials_done === 'number' ? p.trials_done : 0,
    stage: typeof p.stage === 'string' && p.stage !== '' ? p.stage : null,
  }
}

export function EvalRunRail({
  run,
  /** False for a settled run whose rail is still on screen as a summary — the
   *  orb and the Cancel button both come down. */
  live,
  canceling = false,
  onCancel,
}: {
  run: EvalRunRow
  live: boolean
  canceling?: boolean
  onCancel?: () => void
}) {
  const { casesTotal, trialsTotal, trialsDone, stage } = readProgress(run.progress)

  /** Which segment is moving. Attempts is active until every trial is in, then
   *  the stage segment carries the run through grading. */
  const attemptsDone = trialsTotal > 0 && trialsDone >= trialsTotal
  const segments: { id: string; label: string; value: string; state: 'done' | 'active' | 'later' }[] =
    [
      {
        id: 'cases',
        label: 'Cases',
        value: casesTotal > 0 ? String(casesTotal) : '—',
        state: 'done',
      },
      {
        id: 'attempts',
        label: 'Attempts',
        value: trialsTotal > 0 ? `${trialsDone}/${trialsTotal}` : 'starting',
        state: attemptsDone ? 'done' : live ? 'active' : 'later',
      },
      {
        id: 'stage',
        label: 'Stage',
        value: stage ?? 'queued',
        state: live && attemptsDone ? 'active' : attemptsDone ? 'done' : 'later',
      },
    ]

  return (
    <div className="mb-4 mt-4 rounded-md border border-border bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          {segments.map((segment, index) => (
            <span key={segment.id} className="flex items-center gap-1.5">
              {index > 0 && (
                <span aria-hidden className="text-muted-foreground/40">
                  {' · '}
                </span>
              )}
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                  segment.state === 'active'
                    ? 'border-border bg-background text-foreground'
                    : segment.state === 'done'
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'border-border/50 bg-transparent text-muted-foreground',
                )}
              >
                {segment.state === 'active' && (
                  <ThinkingOrb
                    state="searching"
                    size={20}
                    theme="auto"
                    className="-my-1 shrink-0"
                    aria-hidden
                  />
                )}
                {/* The space lives INSIDE the label: a flex gap is not text, so
                    `Attempts` + `7/12` would read as "Attempts7/12". */}
                <span>{segment.label} </span>
                <span className="font-medium tabular-nums">{segment.value}</span>
              </span>
            </span>
          ))}
        </div>

        {live && onCancel && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
            disabled={canceling}
            onClick={onCancel}
          >
            {canceling && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {canceling ? 'Cancelling…' : 'Cancel'}
          </Button>
        )}
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        {MODE_LABELS[run.mode]} run
        {' · '}≈<span className="tabular-nums">{formatCost(run.cost_usd)}</span> so far
      </p>
    </div>
  )
}
