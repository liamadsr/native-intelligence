'use client'

/**
 * What a lookup that did not go through says, in one place:
 *
 *   limit / off   the month's limit is reached, or search data is off here:
 *                 not an error, the neutral line (the page stays usable)
 *   failed        anything else (the provider was busy, did not answer):
 *                 the amber banner with the backend's sentence and Try again
 *
 * A 400 is not here: it is said beside the field that caused it.
 */
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { errorCode, errorMessage } from '../api'
import { DATA_OFF_CODES } from './api'

export interface Problem {
  tone: 'neutral' | 'failed'
  message: string
  /** Search data turned out to be off: the caller reads the spend view again. */
  dataOff: boolean
}

export function problemOf(err: unknown, fallback: string): Problem {
  const code = errorCode(err) ?? ''
  const message = errorMessage(err, fallback)
  if (code === 'SPEND_LIMIT_REACHED') return { tone: 'neutral', message, dataOff: false }
  if (DATA_OFF_CODES.has(code)) return { tone: 'neutral', message, dataOff: true }
  return { tone: 'failed', message: code === 'UNKNOWN' || !code ? fallback : message, dataOff: false }
}

export function ProblemBanner({ problem, onRetry, retryLabel = 'Try again', className }: { problem: Problem; onRetry?: () => void; retryLabel?: string; className?: string }) {
  if (problem.tone === 'neutral') {
    return (
      <p data-kw-problem="neutral" className={cn('rounded-md border border-border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground', className)}>
        {problem.message}
      </p>
    )
  }
  return (
    <div data-kw-problem="failed" className={cn('flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground', className)}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
      <p className="min-w-0 flex-1">{problem.message}</p>
      {onRetry && (
        <Button variant="ghost" size="sm" className="-my-1 h-7 shrink-0 text-xs" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  )
}
