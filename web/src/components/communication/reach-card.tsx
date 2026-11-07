'use client'

/**
 * The agent panel's setup card, shared by its Phone and Slack tabs
 * (phone-section.tsx, slack-card.tsx) so they look like one design: a card
 * centred in the tab, a serif heading and one line under it, full-width
 * controls, one black action, and quiet centred links at the foot.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function ReachCard({ className, children, ...rest }: { className?: string; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div className={cn('mx-auto w-full max-w-sm rounded-2xl border bg-background p-6 text-center shadow-sm', className)} {...rest}>
      {children}
    </div>
  )
}

export function ReachHeading({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn('font-serif text-2xl font-medium leading-tight tracking-tight text-foreground', className)}>{children}</h2>
}

export function ReachLead({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('mt-1.5 text-balance text-sm text-muted-foreground', className)}>{children}</p>
}

/** The card's one black action, full width. */
export const REACH_PRIMARY =
  'flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-foreground text-[15px] font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

/** A value to copy (a number, a code), full width, outlined. */
export const REACH_PILL =
  'flex h-11 w-full items-center justify-center gap-2.5 rounded-xl border text-[15px] font-medium tabular-nums transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** The card's foot: a hairline, then quiet centred text and links. */
export function ReachFoot({ children }: { children: ReactNode }) {
  return <div className="mt-6 w-full space-y-1.5 border-t pt-4 text-xs text-muted-foreground">{children}</div>
}

export const REACH_LINK = 'underline underline-offset-4 transition-colors hover:text-foreground disabled:opacity-50'
