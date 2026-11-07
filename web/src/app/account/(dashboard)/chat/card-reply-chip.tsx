'use client'

/**
 * The For you card the person pressed Reply on (src/lib/chat/card-reply.ts),
 * waiting above the main chat's composer for their next message, and the
 * same card above that message once it's sent (CardReplyQuote).
 *
 * One card, one size (Liam, 10-18: "uniform … so that when it goes in the
 * chat the size is still consistent"): CardQuote draws both, at the chat's
 * own measure, the message bubble's corners, padding and text size, with the
 * card's verb pill scaled to that line and its round icon from the column
 * (sentence-icon.tsx). One max width in both places, so a sentence cuts with
 * its ellipsis at the same point in the composer and in the thread.
 *
 * The chip: flush with the composer's left edge (8px in from the column,
 * as ChatInput's box is), 8px above it, in the composer's glass, so the two
 * read as one thing while the rest goes soft (CardReplyBackdrop). × (on
 * hover or focus, always on a touch screen) takes it off. It rides the
 * message they send (chat-panel.tsx submitTurn).
 * Positioned and lifted (`relative z-10`): the composer dock's frosted strip
 * (chat-panel.tsx, absolute, painted after the in-flow composer zone) blurs
 * the thread behind it, never the chip. It arrives flying from the card
 * Reply was pressed on (card-reply-flight.ts), landing before its first paint.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS_BACKDROP_CLASS } from '@/components/attention/column-focus-view'
import { SentenceIcon } from '@/components/attention/sentence-icon'
import { dismissReplyingCard, useReplyFocus } from '@/lib/chat/card-reply-focus'
import { landCardReplyFlight } from '@/lib/chat/card-reply-flight'
import { skyActivity } from '@/lib/sky/sky-activity'
import type { CardReplyRef } from '@/lib/chat/card-reply'
import { ThreadHook } from './thread-hook'

/** The sky-activity hold kept while the chat's Reply blur is up. */
export const REPLY_SKY_HOLD = 'card-reply-focus'

/** The composer's placeholder while a card waits. */
export const CARD_REPLY_PLACEHOLDER = 'Reply to message'

/**
 * Said under the chip when the person's words answered the agent's question
 * instead (an answer carries no context, so the card stayed for the next one).
 */
export const CARD_REPLY_HELD_NOTE = 'Your answer went to its question; the card will go with your next message'

/**
 * The card's box, the same in the composer and the thread: the message
 * bubble's corners (22px) and the chat's text size, 8px round a 28px line (a
 * one-line bubble's height), at most 26rem wide. The hairline and fill are
 * the chat's quiet material; the composer's chip adds its glass.
 */
export const CARD_QUOTE_CLASS =
  'inline-flex min-w-0 max-w-[min(100%,26rem)] items-center gap-2 rounded-[22px] border border-border/60 bg-background/80 py-2 pl-2 pr-4 text-[16px] leading-6 shadow-sm shadow-black/[0.03] dark:border-white/10'

/** The card's verb at the quote's size: the column's pill (card-skin.ts VERB_PILL_CLASS) scaled to the line. */
const QUOTE_VERB_PILL_CLASS =
  'inline-flex h-7 shrink-0 items-center rounded-[10px] border border-border/70 bg-background px-2.5 text-[14px] font-medium leading-none text-foreground shadow-sm shadow-black/[0.04] dark:border-white/10 dark:bg-white/[0.06]'

/** The card itself: its verb, its icon, its sentence (one line, cut), and what the host adds at its end. */
export function CardQuote({
  card,
  label,
  className,
  children,
}: {
  card: CardReplyRef
  /** Read before the card by a screen reader ("Replying to", "In reply to"). */
  label: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div data-card-quote="" className={cn(CARD_QUOTE_CLASS, className)}>
      <span aria-hidden className={QUOTE_VERB_PILL_CLASS}>
        {card.verb}
      </span>
      <SentenceIcon icon={card.icon} size="md" />
      <span className="min-w-0 truncate text-foreground/85" title={card.sentence}>
        <span className="sr-only">
          {label}: {card.verb}{' '}
        </span>
        {card.sentence}
      </span>
      {children}
    </div>
  )
}

export function CardReplyChip({
  card,
  onRemove,
  note,
}: {
  card: CardReplyRef
  onRemove: () => void
  /** A line under the chip (CARD_REPLY_HELD_NOTE), or nothing. */
  note?: string | null
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const { kind, id } = card
  // The card Reply was pressed on flies in and turns into this one (card-reply-flight.ts).
  useLayoutEffect(() => landCardReplyFlight({ kind, id }, rootRef.current?.querySelector<HTMLElement>('[data-card-quote]') ?? null), [kind, id])
  return (
    // Flush with the composer's box in the same column, so the two read as one: ChatInput's
    // root keeps its box `px-2` in from the column (Liam, 10-19: the chip stuck out past it).
    // `ph-no-capture`: a draft card's sentence quotes the email's subject.
    <div ref={rootRef} data-card-reply-chip={card.id} className="ph-no-capture relative z-10 mb-2 px-2">
      <CardQuote
        card={card}
        label="Replying to"
        // The composer's glass; the × sits in the end padding.
        className="group/chip border-border/70 pr-1.5 backdrop-blur-xl"
      >
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove the card from this message"
          data-card-reply-remove=""
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[opacity,color,background-color] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
            'opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
          )}
        >
          <X className="h-4 w-4" />
        </button>
      </CardQuote>
      {note && (
        <p role="status" data-card-reply-note="" className="mt-1 px-2 text-[11px] text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  )
}

/**
 * The card a sent message replied to, above the person's words in the thread
 * (the message's metadata: card-reply.ts cardReplyMetadata): the same card as
 * the chip, right-aligned and set in from the bubble's edge, with the ┐ hook
 * (thread-hook.tsx) down to the words it went with. No backdrop blur (the
 * thread scrolls over the sky: a blur per quote would redraw on every scroll).
 */
export function CardReplyQuote({ card }: { card: CardReplyRef }) {
  return (
    // `ph-no-capture`: as the chip (a draft card's sentence quotes the subject).
    <div data-card-reply-quote={card.id} className="ph-no-capture relative mr-10 flex min-w-0 max-w-[calc(100%-2.5rem)] self-end">
      <CardQuote card={card} label="In reply to" />
      <ThreadHook shape="down-from-right" />
    </div>
  )
}

/**
 * While a card waits as the chat's Reply chip, everything but the composer
 * and the For you column goes soft behind the For you focus view's own blur
 * (Liam, 10-16: the header and the workspace pill too, "the same thing as
 * when you click on one of the For you items"). In the shell, over the top
 * bar; the composer and the column are raised over it while
 * CARD_REPLY_FOCUS_ATTR is set (card-reply-focus.ts). A press on it takes the
 * chip off; the sky holds still behind it (a full-window backdrop-filter is
 * costly over the moving sky in WebKit).
 */
export function CardReplyBackdrop() {
  const on = useReplyFocus()
  useEffect(() => {
    if (!on) return
    skyActivity.setHold(REPLY_SKY_HOLD, true)
    return () => skyActivity.setHold(REPLY_SKY_HOLD, false)
  }, [on])
  if (!on) return null
  return (
    <div
      aria-hidden
      data-card-reply-backdrop=""
      onMouseDown={dismissReplyingCard}
      className={cn('absolute inset-0 z-[45]', FOCUS_BACKDROP_CLASS)}
    />
  )
}
