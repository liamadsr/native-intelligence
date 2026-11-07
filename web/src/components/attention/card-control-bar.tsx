'use client'

import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { DeckPager } from './rail-cards'

/**
 * The card's bottom control bar — the deck's chrome, moved INSIDE the card.
 *
 * Previously the rail floated a header above the stack ("Agent alerts" + the
 * ‹ 1/2 › stepper). That read as loose furniture hovering over the card. Now
 * every control the card offers lives along its bottom edge, the way an editor
 * puts its controls in a footer strip: the pager sits bottom-LEFT, the primary
 * CTA bottom-RIGHT as a split button whose caret reveals the secondary verbs
 * (dismiss, and anything else a card wants to demote).
 *
 * Layout: pager left, `extra` (card-specific demoted verbs shown inline) then
 * the split button right. The pager renders nothing for a single-card deck, so
 * a lone card shows no dead "1/1".
 */

interface CardControlBarProps {
  pager?: DeckPager
  /** The primary button — already wired with its own label/handler/disabled. */
  primary: ReactNode
  /** Menu items revealed by the caret. When absent, no caret is rendered and
   *  the primary button keeps its own fully-rounded shape. */
  menu?: ReactNode
  /** Inline secondary content placed left of the split button (e.g. "Refine"). */
  extra?: ReactNode
  /** Disables the caret while the card is mid-flight. */
  busy?: boolean
  /** Quiet text at the bar's left, after the pager (the For you column's card age). */
  meta?: ReactNode
  /** A control at the bar's left, after the pager (a work card's place picker). */
  leading?: ReactNode
}

export function CardControlBar({ pager, primary, menu, extra, busy, meta, leading }: CardControlBarProps) {
  const showPager = !!pager && pager.total > 1

  return (
    <div className="flex items-center gap-1.5 border-t border-border/50 px-3 py-2">
      {showPager && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={pager.onPrev}
            disabled={pager.atStart}
            aria-label="Previous card"
            className="flex h-6 w-6 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
          <span className="min-w-[2.25rem] px-0.5 text-center text-[11px] font-semibold tabular-nums text-muted-foreground">
            {pager.position}/{pager.total}
          </span>
          <button
            type="button"
            onClick={pager.onNext}
            disabled={pager.atEnd}
            aria-label="Next card"
            className="flex h-6 w-6 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        </div>
      )}

      {leading && <div className="-ml-1.5 flex min-w-0 shrink items-center">{leading}</div>}

      {meta && <span className="min-w-0 truncate text-[10px] tabular-nums text-muted-foreground/70">{meta}</span>}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {extra}
        {/* Split button: the primary verb stays the obvious target; the caret
            is a separate hit area so a stray click can't fire the action. The
            two halves share one silhouette (inner corners squared off).
            `items-stretch` + a `flex` wrapper keeps the halves the SAME height:
            a plain block wrapper inherits the bar's 24px line-height and grows
            taller than the 24px button inside it, so centering it against the
            caret would offset the two by ~1px and break the shared edge. */}
        <div className="flex items-stretch">
          <div className={cn('flex', menu && '[&>button]:rounded-r-none')}>{primary}</div>
          {menu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  disabled={busy}
                  aria-label="More actions"
                  // text-[11px] matches the primary half (the Button default is
                  // 12px), so both halves share one type scale and baseline.
                  className="h-6 gap-0 rounded-l-none border-l border-primary-foreground/25 px-1.5 text-[11px]"
                >
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              {/* Sized to the CARD, not the app's default menu scale: the
                  control bar runs at 11px, so a 14px/160px-wide menu reads as
                  a different component bolted on. `min-w-0` lets it hug its
                  widest item, and the size-3.5 override tames the menu's own
                  `[&>svg]:size-4` so the icon matches the 11px text. */}
              <DropdownMenuContent
                align="end"
                sideOffset={6}
                className="min-w-0 p-1 [&_[role=menuitem]]:gap-1.5 [&_[role=menuitem]]:px-2 [&_[role=menuitem]]:py-1 [&_[role=menuitem]]:text-[11px] [&_[role=menuitem]>svg]:size-3.5"
              >
                {menu}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </div>
  )
}
