'use client'

/**
 * A section of a bot's page as a card of its own (docs/plans/bots-v4.md, "A
 * bot's page"; Liam, Oct 7: the work on the right "like little floating
 * sections", as in the Claude Code app's side panel). Every section of the
 * work column wears it: For you, Working on, Done lately and About, and any
 * section added later (Conversations, the item view's parts).
 *
 *   frame   a rounded surface standing off the window's frosted page, with a
 *           hairline edge and the HUD's soft elevation (hud-surface-shadow,
 *           tailwind.css). Light: the card colour, nearly opaque, with a faint
 *           dark edge. Dark: a lifted step above the page with a light edge, so
 *           it reads as a piece standing off it (glass.ts's way), not a dark
 *           box on it. No blur of its own: the window's glass is the page's
 *           one filter (content-windows.tsx).
 *   header  small and quiet: its title, its count when it has one, a hint
 *           (truncated; whole as a tooltip), and an action at its end when it
 *           has one (Notices' "Mark all read").
 *   body    inset from the edges; its rows keep their own rounding inside the
 *           card's (8 px inside 16 px). `bounded`: a long list scrolls inside
 *           the card, at most BOT_PAGE_CARD_BODY_MAX tall, so the column (which
 *           scrolls as a whole) keeps room around it. `fill`: the card takes
 *           the column's height and its body the rest, for a view that scrolls
 *           itself (an item open on the page, Phase 2: its panel).
 *
 * Its `aria-label` is its title (a landmark, as the lanes have it), and
 * `data-bot-page-section` names which section it is.
 */
import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The card's surface, light and dark. */
export const BOT_PAGE_CARD = [
  'rounded-2xl border hud-surface-shadow',
  'border-black/[0.06] bg-card/90',
  'dark:border-white/[0.08] dark:bg-white/[0.04]',
].join(' ')

/**
 * How tall a bounded card's list grows before it scrolls inside the card:
 * about five rows, and under half the window, so the column always has room
 * outside it to scroll by (the desktop app's scrollers don't hand a scroll on).
 */
export const BOT_PAGE_CARD_BODY_MAX = 'max-h-[min(22rem,45vh)]'

export function BotPageCard({
  section,
  title,
  hint,
  count,
  bounded = false,
  fill = false,
  action,
  className,
  children,
}: {
  /** Which section it is (`data-bot-page-section`): 'for-you', 'about', … */
  section: string
  title: string
  hint?: string
  /** Shown after the title when above zero. */
  count?: number
  /** A long list scrolls inside the card instead of growing it. */
  bounded?: boolean
  /** The card takes its column's height, its body the rest (for content that scrolls itself). */
  fill?: boolean
  /** A small button at the header's end. */
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section
      aria-label={title}
      data-bot-page-section={section}
      className={cn(BOT_PAGE_CARD, 'flex min-w-0 flex-col pb-2', fill && 'min-h-0 flex-1 overflow-hidden', className)}
    >
      <header className="flex min-w-0 items-baseline gap-2 px-3.5 pb-2 pt-3">
        <h2 className="shrink-0 text-xs font-medium text-foreground/80">
          {title}
          {typeof count === 'number' && count > 0 ? <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">{count}</span> : null}
        </h2>
        {hint && (
          <span title={hint} className="min-w-0 truncate text-[11px] text-muted-foreground/70">
            {hint}
          </span>
        )}
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </header>
      <div
        data-bot-page-section-body=""
        className={cn('min-w-0 px-2', bounded && `${BOT_PAGE_CARD_BODY_MAX} overflow-y-auto`, fill && 'flex min-h-0 flex-1 flex-col')}
      >
        {children}
      </div>
    </section>
  )
}

/** A section with nothing in it: one quiet line, kept compact (the card is its box). */
export function BotPageEmpty({ children }: { children: ReactNode }) {
  return (
    <p data-bot-page-empty="" className="flex items-center gap-1.5 px-1.5 pb-1 text-[11px] text-muted-foreground">
      <Inbox className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}
