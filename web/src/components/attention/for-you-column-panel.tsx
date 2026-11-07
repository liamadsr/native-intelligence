'use client'

/**
 * The chat's For you column, its cards (docs/plans/always-on-agent.md,
 * decision 13): everything the bots count for you, one card each, compact
 * (column-compact-card.tsx; Liam, 2026-10-16: "more like Hard where you just
 * see the action button"): the card's verb as a pill and one sentence, its
 * details, other verbs and full card (AttentionCard, ReviewCard's verbs,
 * QuestionCard) in the focus view a click opens. Grouped under the bot they
 * came from (Liam, 2026-10-14: "grouped under the same agent"): one quiet
 * header per bot (its face, name, and a count when it has more than one; the
 * bots still own them), its cards stacked beneath it newest first, the bots
 * in order of their newest (groupColumnEntries). A flat list like Hard's is
 * one line: render `shown` in one list instead of `groups`. The agent's cards
 * (one face: its area work is its own) each carry a small area label ("Mail")
 * over them.
 * Mounted by
 * chat/for-you-column.tsx, which decides
 * whether there is room and places it in the chat's left gutter; it has no
 * pill of its own (Liam, 10-16: the top bar's toggle opens and closes it).
 * This module is fetched the first time it has cards.
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
 * more" adds a page; the cap counts cards in the grouped order, so a bot cut
 * by it shows its header once, and the next page carries on beneath it), no
 * card animates in or out, and the scroll fades are two booleans that change
 * only as the list reaches or leaves an end.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AgentIcon } from '@/components/agents/agent-icon'
import type { AgentWorkShared } from '@/components/work/agent-work-provider'
import { useCardPickers } from '@/lib/bots/card-pickers'
import { groupColumnEntries, type ColumnEntry, type ColumnSource } from '@/lib/bots/for-you-column'
import { fullRowFailed, pruneFullRows, useFullRows } from '@/lib/work/full-rows'
import { reviewCardOf } from './rail-cards'
import { ColumnCompactCard, type ColumnShown } from './column-compact-card'

/** How many cards are mounted at first, and how many each "Show more" adds. */
export const COLUMN_PAGE = 30

/** How far the soft fade at an end of the list reaches, px. */
const FADE_PX = 18

/** `area`: the area an agent's card came from (one face: for-you-column.ts), as a small label over it. */
type Shown = ColumnShown

export function ForYouColumnPanel({
  entries,
  shared,
  style,
}: {
  /** What the bots bring you, newest first (forYouColumnEntries). */
  entries: readonly ColumnEntry[]
  shared: AgentWorkShared
  /** Where the column stands (its host's gutter maths). */
  style?: CSSProperties
}) {
  const { work } = shared
  const [limit, setLimit] = useState(COLUMN_PAGE)
  // Each bot's entries together (the bots in order of their newest), then the cap over cards.
  const ordered = useMemo(() => groupColumnEntries(entries).flatMap((g) => g.entries), [entries])
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

  // The ones on show that can't show: a review whose read failed, or no longer waiting.
  const unshowable = useMemo(
    () =>
      windowed.filter((e) => {
        if (e.kind !== 'review') return false
        const row = whole.get(e.id)
        return row ? row.status !== 'needs_review' : fullRowFailed(e.row)
      }),
    [windowed, whole],
  )

  // The cards on show under their bots (contiguous: `ordered` keeps each bot's
  // together), each header counting its bot's entries less the ones that
  // can't show.
  const groups = useMemo(() => {
    const totals = new Map<string, number>()
    for (const e of ordered) totals.set(e.source.teammateId, (totals.get(e.source.teammateId) ?? 0) + 1)
    for (const e of unshowable) totals.set(e.source.teammateId, (totals.get(e.source.teammateId) ?? 0) - 1)
    const out: Array<{ source: ColumnSource; count: number; cards: Shown[] }> = []
    for (const s of shown) {
      const last = out[out.length - 1]
      if (last && last.source.teammateId === s.source.teammateId) last.cards.push(s)
      else out.push({ source: s.source, count: totals.get(s.source.teammateId) ?? 1, cards: [s] })
    }
    return out
  }, [ordered, unshowable, shown])

  // Each card's workspace's lists for its pills: the one set AgentInfraHost loads for the page.
  const cardWorkspaces = useMemo(() => shown.flatMap((s) => (s.kind === 'card' ? [s.card.workspace_id] : [])), [shown])
  const pickerFor = useCardPickers(cardWorkspaces)

  // The soft fades: on at an end only while there is more past it.
  const scrollerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [fades, setFades] = useState({ top: false, bottom: false })
  const readFades = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const top = el.scrollTop > 2
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2
    setFades((was) => (was.top === top && was.bottom === bottom ? was : { top, bottom }))
  }, [])
  useLayoutEffect(() => {
    readFades()
    const el = scrollerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(readFades)
    observer.observe(el)
    // The content too: a card growing (its details, wrapped pills) moves the bottom end.
    if (listRef.current) observer.observe(listRef.current)
    return () => observer.disconnect()
  }, [readFades, shown.length])

  const rest = ordered.length - windowed.length
  // Nothing whole to show (reviews still being read): nothing at all.
  if (shown.length === 0) return null

  // No mask at all while neither end has more past it (nothing to composite).
  const mask =
    fades.top || fades.bottom
      ? `linear-gradient(to bottom, transparent 0, #000 ${fades.top ? FADE_PX : 0}px, #000 calc(100% - ${fades.bottom ? FADE_PX : 0}px), transparent 100%)`
      : undefined

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
        ref={scrollerRef}
        onScroll={readFades}
        data-for-you-scroller=""
        // Which ends fade (none: neither has more past it).
        data-for-you-fades={fades.top && fades.bottom ? 'both' : fades.top ? 'top' : fades.bottom ? 'bottom' : undefined}
        // Click-through like the column: only the cards and buttons in it take the pointer (a wheel over a card still scrolls it).
        className="pointer-events-none -mx-1 min-h-0 w-[calc(100%+0.5rem)] overflow-y-auto overscroll-contain px-1 pb-1 scrollbar-hide-deep [overflow-anchor:none]"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        <ul ref={listRef} className="flex flex-col gap-4">
          {groups.map((g) => (
            <li key={g.source.teammateId} data-for-you-group={g.source.teammateId} className="flex min-w-0 flex-col gap-1.5">
              <GroupHeader source={g.source} count={g.count} />
              <ul className="flex min-w-0 flex-col gap-2">
                {g.cards.map((s) => (
                  <li key={s.id} data-for-you-card={s.id} className="flex min-w-0 flex-col gap-1">
                    {s.area && (
                      <span data-for-you-area="" className="truncate pl-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {s.area}
                      </span>
                    )}
                    {/* The card takes the pointer (the column around it doesn't). */}
                    <div data-for-you-card-box="" className="pointer-events-auto relative min-w-0">
                      <ColumnCompactCard entry={s} shared={shared} pickerFor={pickerFor} />
                    </div>
                  </li>
                ))}
              </ul>
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

/**
 * An agent's header over its cards, quiet (the cards are the list): the agent mark and
 * name, and how many it has for you when that's more than one, on a faint
 * solid backing with no edge or lift (still legible on the sky).
 */
function GroupHeader({ source, count }: { source: ColumnSource; count: number }) {
  return (
    <span
      data-for-you-source={source.teammateId}
      className="inline-flex h-5 max-w-full items-center gap-1 self-start rounded-full bg-card/70 pl-0.5 pr-2 text-[11px] font-medium text-muted-foreground dark:bg-neutral-900/70"
    >
      <span aria-hidden className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
        <AgentIcon className="h-3 w-3" />
      </span>
      <span data-for-you-group-name="" className="truncate">
        {source.name}
      </span>
      {count > 1 && (
        <span data-for-you-group-count="" className="shrink-0 tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </span>
  )
}
