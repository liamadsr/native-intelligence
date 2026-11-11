/**
 * The public scheduling pages' frame and pieces: a business's booking page
 * (/book/<slug>), a time offer's page (/t/<token>) and a guest's manage page
 * (/b/<token>). One card on the page's background, the footer under it.
 */
import type { ReactNode } from 'react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function SchedulingShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-4 text-foreground sm:p-6 lg:p-8">
      <Card className="w-full max-w-lg">{children}</Card>
      <p className="text-xs text-muted-foreground">Scheduling by Native Intelligence</p>
    </div>
  )
}

/** One time to pick: pressed when it's the one picked. */
export function TimeButton({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      disabled={disabled}
      className={cn(
        'rounded-md border px-3 py-1.5 text-sm tabular-nums transition-colors disabled:opacity-50',
        on ? 'border-foreground bg-foreground text-background' : 'hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}

/** A line the page needs the guest to see: a problem, or news. */
export function SchedulingNotice({ tone = 'error', children, ...rest }: { tone?: 'error' | 'info'; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div
      {...rest}
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-lg px-3 py-2 text-sm',
        tone === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-muted text-foreground',
      )}
    >
      {children}
    </div>
  )
}
