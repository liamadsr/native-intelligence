'use client'

/**
 * The "Beta" pill that sits beside the Prospecting title.
 *
 * It exists in one file rather than being typed twice because it appears on
 * BOTH prospecting surfaces — the lists index header and a list's detail
 * header — and the whole point of the label is that a user recognises the same
 * mark in the same place on both pages. Two hand-rolled copies drift within a
 * release and then the pill reads as two different things.
 *
 * THE REGISTER IS DELIBERATELY MUTED, and that is not timidity. Prospecting's
 * saturated colour is already spoken for by the fit-tier chip (`fit-chip.tsx`),
 * where colour carries a verdict about a company and has to survive a scan of
 * 200 rows. "Beta" is a fact about the PAGE, not about anything on it; giving
 * it a colour would put it in the same visual language as a scored candidate
 * and make it compete with the one chip that must win. So it borrows the exact
 * neutral of the purpose chip already in the list-detail header — same
 * `rounded-full border-border bg-muted/40 px-1.5 py-0.5 text-[10px]
 * text-muted-foreground` — which is why the two sit together without looking
 * like two systems.
 *
 * `bg-muted/40` and `text-muted-foreground` are theme tokens, so the pill is
 * dark-mode safe for free; nothing here hard-codes a light-mode grey.
 *
 * The title is the honest version of what a beta label is FOR: it invites the
 * bug report rather than just disclaiming. `aria-label` is set because the
 * short visible string is uppercased by CSS and the label is what a screen
 * reader should hear.
 */

import { cn } from '@/lib/utils'

export const BETA_PILL_TITLE = 'Prospecting is in beta — tell us what breaks'

export function BetaPill({ className }: { className?: string }) {
  return (
    <span
      title={BETA_PILL_TITLE}
      aria-label="Beta"
      data-beta-pill=""
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
        className,
      )}
    >
      Beta
    </span>
  )
}
