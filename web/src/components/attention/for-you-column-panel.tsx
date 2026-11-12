'use client'

/**
 * For you's cards (docs/plans/always-on-agent.md,
 * decision 13): everything the bots count for you, one card each, compact
 * (column-compact-card.tsx; Liam, 2026-10-16: "more like Hard where you just
 * see the action button"): the card's verb as a pill and one sentence, its
 * details, other verbs and full card (AttentionCard, ReviewCard's verbs,
 * QuestionCard) in the focus view a click opens. One flat list, newest
 * first, with no headers (Liam, 11-09: the per-agent headers and area labels
 * over the cards made it inconsistent): where a card came from is a tag on
 * the card itself (column-compact-card.tsx columnTag: the area the agent's
 * card came from, "Captures", "CRM", else the bot's name).
 * The side panel's For you view (Liam, 11-11: "move the for you cards to
 * the right hand side panel… you can't see both at the same time"): mounted
 * by chat/for-you-column.tsx ForYouView inside side-panels/side-panels.tsx,
 * which places it in the panel's 360px, down to the panel's bottom, and
 * shows and hides it; it has no button of its own (the top bar's For you
 * button opens and closes it). This module is fetched the first time it
 * shows.
 *
 * Every verb is the shared source's (AgentWorkProvider: useAttentionItems'
 * accept, start, draft, dismiss and editCard; the ledger's reviewed and
 * dismissReview), with their optimistic removal, so a card settled here
 * leaves its bot's bubble and page in the same render, and one settled there
 * leaves here. A review's card needs its whole row: read through the cache
 * the bubble uses (lib/work/full-rows.ts), only for the ones on show, so a
 * row it has read is never read again; the column prunes from it what no
 * longer waits. Each shows once its read lands. Its count leaves out the ones
 * on show that can't be shown (a review whose read failed, or no longer
 * waiting). Only delivered work is here (P13): approvals and questions ask in
 * the chat (chat-ask-card.tsx).
 *
 * Flat cost: at most `limit` cards are mounted (COLUMN_PAGE, then "Show N
 * more" adds a page), no
 * card animates in or out, and the scroll fades are two booleans that change
 * only as the list reaches or leaves an end (scroll-fades.ts, shared with the
 * page panel's recents).
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { AgentWorkShared } from '@/components/work/agent-work-provider'
import { useCardPickers } from '@/lib/bots/card-pickers'
import { uniqueColumnEntries, type ColumnEntry } from '@/lib/bots/for-you-column'
import { pruneFullRows, useFullRows } from '@/lib/work/full-rows'
import { reviewCardOf } from './rail-cards'
import { ColumnCompactCard, type ColumnShown } from './column-compact-card'
import { useScrollFades } from './scroll-fades'

/** How many cards are mounted at first, and how many each "Show more" adds. */
export const COLUMN_PAGE = 30

/** `area`: the area an agent's card came from (one face: for-you-column.ts), its tag. */
type Shown = ColumnShown

export function ForYouColumnPanel({
  entries,
  shared,
  style,
}: {
  /** What the bots bring you, newest first (forYouColumnEntries). */
  entries: readonly ColumnEntry[]
  shared: AgentWorkShared
  /** Where the cards stand in their host's box (the side panel's For you view fills it). */
  style?: CSSProperties
}) {
  const { work } = shared
  const [limit, setLimit] = useState(COLUMN_PAGE)
  // Newest first (as the bots brought them), each thing once, then the cap over cards.
  const ordered = useMemo(() => uniqueColumnEntries(entries), [entries])
  const windowed = useMemo(() => ordered.slice(0, limit), [ordered, limit])

  // The reviews on show, whole (their title and deliverables): read once, shared with the bubble.
  const reviewRows = useMemo(() => windowed.flatMap((e) => (e.kind === 'review' ? [e.row] : [])), [windowed])
  const whole = useFullRows(reviewRows)
  // What no longer waits (in the shell's open rows) goes from the shared cache.
  const openRows = work.rows
  useEffect(() => pruneFullRows(openRows), [openRows])

  const shown = useMemo<Shown[]>(() => {
    const out: Shown[] = []
    for (const e of windowed) {
      if (e.kind === 'card' || e.kind === 'draft') {
        out.push(e)
        continue
      }
      // As the bubble: a review card once its whole row is held and still waiting.
      const row = whole.get(e.id)
      if (!row || row.status !== 'needs_review') continue
      out.push({ kind: 'review', id: e.id, at: e.at, card: reviewCardOf(row, { seen: e.seen }), source: e.source, ...(e.area ? { area: e.area } : {}) })
    }
    return out
  }, [windowed, whole])

  // Each card's workspace's lists for its pills: the one set AgentInfraHost loads for the page.
  const cardWorkspaces = useMemo(() => shown.flatMap((s) => (s.kind === 'card' ? [s.card.workspace_id] : [])), [shown])
  const pickerFor = useCardPickers(cardWorkspaces)

  // The soft fades: on at an end only while there is more past it.
  const fades = useScrollFades(shown.length)

  const rest = ordered.length - windowed.length
  // Nothing whole to show (reviews still being read): nothing at all.
  if (shown.length === 0) return null

  return (
    <section
      aria-label="For you"
      data-for-you-column=""
      // `ph-no-capture`: a draft card quotes the email's recipient, subject and
      // brief; session replay blocks the column (its focus view portals out
      // and carries its own).
      className="ph-no-capture pointer-events-none absolute flex min-h-0 flex-col items-start gap-2 font-sans"
      style={style}
    >
      <div
        ref={fades.scrollerRef}
        onScroll={fades.onScroll}
        data-for-you-scroller=""
        // Which ends fade (none: neither has more past it).
        data-for-you-fades={fades.which}
        // Click-through like the column: only the cards and buttons in it take the pointer (a wheel over a card still scrolls it).
        className="pointer-events-none -mx-1 min-h-0 w-[calc(100%+0.5rem)] overflow-y-auto overscroll-contain px-1 pb-1 scrollbar-hide-deep [overflow-anchor:none]"
        style={fades.style}
      >
        <ul ref={fades.contentRef} className="flex flex-col gap-2">
          {shown.map((s) => (
            <li key={s.id} data-for-you-card={s.id} className="flex min-w-0 flex-col">
              {/* The card takes the pointer (the column around it doesn't). */}
              <div data-for-you-card-box="" className="pointer-events-auto relative min-w-0">
                <ColumnCompactCard entry={s} shared={shared} pickerFor={pickerFor} />
              </div>
            </li>
          ))}
        </ul>
        {rest > 0 && (
          <button
            type="button"
            data-for-you-more=""
            onClick={() => setLimit((n) => n + COLUMN_PAGE)}
            className="pointer-events-auto mt-3 inline-flex h-7 w-full items-center justify-center rounded-full border border-border/60 bg-background/70 text-xs font-medium text-muted-foreground backdrop-blur-md transition-colors hover:bg-background/85 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none dark:border-white/10"
          >
            Show {Math.min(COLUMN_PAGE, rest)} more
          </button>
        )}
      </div>
    </section>
  )
}
