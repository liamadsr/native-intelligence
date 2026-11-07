'use client'

/**
 * An agent's plan as a compact checklist (docs/plans/always-on-agent.md §4b):
 * one line per step, its state as the mark. Drawn under the main chat's reply
 * (the `update_plan` tool card) and in a job's detail panel (the Plan section).
 *
 * `live`: the step in progress spins; once the work has settled it sits still.
 */
import { Check, Circle, CircleDot, CircleSlash, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { planProgress, type PlanStep } from '@/lib/work/plan'

const STATUS_LABEL: Record<PlanStep['status'], string> = {
  pending: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  skipped: 'Skipped',
}

function StepMark({ status, live }: { status: PlanStep['status']; live: boolean }) {
  if (status === 'done') return <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
  if (status === 'skipped') return <CircleSlash className="h-3 w-3 text-muted-foreground/60" />
  if (status === 'in_progress') {
    return live ? (
      <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
    ) : (
      <CircleDot className="h-3 w-3 text-blue-500" />
    )
  }
  return <Circle className="h-3 w-3 text-muted-foreground/50" />
}

export function PlanChecklist({ steps, live = true, className }: { steps: readonly PlanStep[]; live?: boolean; className?: string }) {
  return (
    <ol data-plan-checklist="" className={cn('space-y-1', className)}>
      {steps.map((s, i) => (
        <li key={`${i}-${s.text}`} data-plan-step={s.status} className="flex items-start gap-2 text-xs">
          <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-label={STATUS_LABEL[s.status]} title={STATUS_LABEL[s.status]}>
            <StepMark status={s.status} live={live} />
          </span>
          <span
            className={cn(
              'min-w-0',
              s.status === 'in_progress' && 'font-medium text-foreground',
              s.status === 'pending' && 'text-foreground/80',
              s.status === 'done' && 'text-muted-foreground',
              s.status === 'skipped' && 'text-muted-foreground/70 line-through',
            )}
          >
            {s.text}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** "Plan · 3 of 5": an older plan, superseded in the same reply. */
export function PlanSummaryLine({ steps }: { steps: readonly PlanStep[] }) {
  const { finished, total } = planProgress(steps)
  return (
    <p data-plan-summary="" className="text-[11px] text-muted-foreground">
      Plan · {finished} of {total}
    </p>
  )
}
