'use client'

/**
 * The SEO pages' run rail: one line while something runs in the background
 * (a rank check, an AI visibility check, a map scan), in the look of
 * prospecting/run-rail.tsx and the audit's own rail.
 *
 *   ◉ Checking rankings · 42 of 120 keywords · example.com            [Stop]
 *
 * No percentage: a count that stopped moving says "stalled" by itself.
 * Zero-valued clauses are the caller's to drop.
 */
import { Loader2 } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function RunRail({
  verb,
  clauses = [],
  stopping = false,
  onStop,
  stopLabel = 'Stop',
  className,
}: {
  /** What is happening, as a verb phrase ("Checking rankings"). */
  verb: string
  /** Counted details after it, already worded ("42 of 120 keywords"). */
  clauses?: readonly string[]
  stopping?: boolean
  /** Absent: the run can't be stopped from here, and no button shows. */
  onStop?: () => void
  stopLabel?: string
  className?: string
}) {
  return (
    <div data-seo-run-rail="" className={cn('mx-5 mb-2 flex items-center gap-3 rounded-md border border-border bg-muted/20 px-3 py-2', className)}>
      <ThinkingOrb state="searching" size={20} theme="auto" className="-my-1 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 truncate text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{verb}</span>
        {clauses.map((clause, index) => (
          <span key={index}>
            <span aria-hidden className="text-muted-foreground/40">
              {' · '}
            </span>
            <span className="tabular-nums">{clause}</span>
          </span>
        ))}
      </p>
      {onStop && (
        <Button variant="ghost" size="sm" data-seo-stop="" className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground" disabled={stopping} onClick={onStop}>
          {stopping && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {stopping ? 'Stopping…' : stopLabel}
        </Button>
      )}
    </div>
  )
}
