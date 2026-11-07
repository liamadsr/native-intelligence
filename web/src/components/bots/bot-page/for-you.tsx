'use client'

/**
 * For you, on a bot's page (docs/plans/bots-v4.md, "A bot's page" and Phase 3,
 * "Everything waiting, settled at the bot"): everything its teammate has
 * waiting on you. What's new first, in the order its bot calls for them
 * (bubbleItems: its waiting rows you haven't opened, then its cards, a run's
 * cards folded into one), then what still waits on you that you've seen
 * (seenItems: rows you've opened since they last started waiting), marked Seen.
 *
 * Settled here (decision 4), as in its bubble:
 *
 *   the deck   its cards and its reviews as the real cards, the Needs you
 *              deck narrowed to this bot (AttentionDeck, narrow, `surface:
 *              'bot_page'`): a card's project, priority, due-date and assignee
 *              pills (their lists loaded once for the page: card-pickers.ts),
 *              the picker for an update with no target, Accept, Start and
 *              Dismiss; a review's Review (Mail, the document, the
 *              PR), Reviewed and Dismiss, a seen one marked Seen. New first,
 *              then seen. The accept flourish plays on after its card has
 *              gone. "Refine in chat" talks to this bot, in the page's chat
 *              (`onRefine`), never the main chat. Every verb is the shared
 *              source's, so it leaves the bubble and Needs you too.
 *   the rows   the rest (a review the page doesn't hold whole yet), as rows
 *              that open their item on this page (Phase 2), new then seen.
 *              A question is asked in the chat, never here (P13).
 *   mentions   a card another bot raised that proposes this one for the work
 *              (decision 9, agent-work-lanes.ts cardMentions): read-only,
 *              "From Triage", with no dot and no count; it opens its run's
 *              item, where the raiser's verbs are.
 *
 * Read off the shell's shared source (its counts, cards and open rows) and the
 * page's own rows (useBotWork: whole rows, with titles), the page's first.
 */
import { useCallback, useMemo, useState } from 'react'
import { ChevronRight, StickyNote } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AttentionDeck } from '@/components/attention/attention-deck'
import { reviewCardOf, type DeckCard } from '@/components/attention/rail-cards'
import { useAgentWorkShared } from '@/components/work/agent-work-provider'
import { WorkRow } from '@/components/work/work-rows'
import type { AttentionItem } from '@/hooks/use-attention-items'
import { bubbleItems, seenItems, type BubbleCard, type BubbleItem, type BubbleRow } from '@/lib/bots/bubble-items'
import { useCardPickers } from '@/lib/bots/card-pickers'
import { resolveItem, type OpenTeammateSource } from '@/lib/bots/open-teammate'
import { cardLookupRows, cardMentions, cardOwnerKeys, laneLabel, teammateKey, type OwnerCounts } from '@/lib/work/agent-work-lanes'
import type { CardRunRow } from '@/lib/work/queries'
import { relativeTime, waitingSince } from '@/lib/work/presentation'
import type { EntityChip } from '@/lib/work/touch-summary'
import { treeRootId } from '@/lib/work/tree'
import type { WorkItem } from '@/lib/work/types'
import { BOT_PAGE_CARD_BODY_MAX, BotPageCard, BotPageEmpty } from './bot-page-card'
import type { BotPageOpen } from './use-bot-page-open'

export interface ForYouItems {
  /** What's new, as its bot calls for them (bubbleItems). */
  fresh: BubbleItem[]
  /** What still waits on you that you've seen (seenItems). */
  seen: BubbleItem[]
}

/**
 * What For you lists for a teammate: its new items, then its seen ones.
 * Nothing is in both. Delivered work only (P13): a run parked on a question
 * asks in its run's chat and the home thread, and the shared source's cards
 * (`attention.items`) already leave the chat's approvals and questions out.
 */
export function forYouItems(
  teammateId: string,
  counts: ReadonlyMap<string, OwnerCounts>,
  rows: readonly BubbleRow[],
  cards: readonly BubbleCard[],
  cardRows: readonly CardRunRow[] = [],
): ForYouItems {
  const delivered = (item: BubbleItem) => item.kind !== 'row' || item.row.status !== 'needs_input'
  return {
    fresh: bubbleItems(teammateId, counts, rows, cards, cardRows).filter(delivered),
    seen: seenItems(teammateId, rows).filter(delivered),
  }
}

/** The rows For you reads: the page's own (whole rows) first, then any the shell holds that it doesn't yet. */
export function forYouRows(own: readonly WorkItem[], shared: readonly BubbleRow[]): BubbleRow[] {
  const have = new Set(own.map((r) => r.id))
  return [...own, ...shared.filter((r) => !have.has(r.id))]
}

/** A row the page holds whole (its title and deliverables), waiting on your review: a review card. */
function isWholeReview(row: BubbleRow): row is WorkItem {
  return row.status === 'needs_review' && 'title' in row && 'deliverables' in row
}

/** How For you splits its items: the deck's cards (new, then seen), and the rows listed under it (new, then seen). */
export interface ForYouLayout {
  deck: DeckCard[]
  rows: Array<{ item: Extract<BubbleItem, { kind: 'row' }>; seen: boolean }>
  /** Which item each deck card is from (a run's cards share theirs). */
  itemOf: ReadonlyMap<string, BubbleItem>
}

/** The real cards (a card, a run's cards, a whole review), in order; the rest as rows. */
export function forYouLayout({ fresh, seen }: ForYouItems): ForYouLayout {
  const deck: DeckCard[] = []
  const rows: ForYouLayout['rows'] = []
  const itemOf = new Map<string, BubbleItem>()
  const place = (item: BubbleItem, isSeen: boolean) => {
    if (item.kind === 'card' || item.kind === 'batch') {
      for (const card of item.kind === 'card' ? [item.card] : item.cards) {
        deck.push(card as AttentionItem)
        itemOf.set(card.id, item)
      }
      return
    }
    if (isWholeReview(item.row)) {
      const review = reviewCardOf(item.row, { seen: isSeen })
      deck.push(review)
      itemOf.set(review.id, item)
      return
    }
    rows.push({ item, seen: isSeen })
  }
  for (const item of fresh) place(item, false)
  for (const item of seen) place(item, true)
  return { deck, rows, itemOf }
}

export function ForYou({
  teammateId,
  name,
  rows: own,
  chips,
  open,
  onRefine,
}: {
  teammateId: string
  name: string
  /** The page's own rows (useBotWork). */
  rows: readonly WorkItem[]
  chips: Record<string, EntityChip[]>
  open: BotPageOpen
  /** "Refine in chat" on one of its cards: the page's chat with this bot (the card, and the item it's from). */
  onRefine?: (card: AttentionItem, item: BubbleItem | null) => void
}) {
  const { work, attention, counts } = useAgentWorkShared()
  const rows = useMemo(() => forYouRows(own, work.rows ?? []), [own, work.rows])
  const items = useMemo(
    () => forYouItems(teammateId, counts, rows, attention.items, work.cardRows),
    [teammateId, counts, rows, attention.items, work.cardRows],
  )
  const layout = useMemo(() => forYouLayout(items), [items])
  // Where a card's run is (resolveItem): the rows held, and the rows cards point at.
  const source = useMemo<OpenTeammateSource>(
    () => ({ rows, cardRows: work.cardRows, cards: attention.items, counts }),
    [rows, work.cardRows, attention.items, counts],
  )
  const titles = useMemo(() => new Map(rows.map((r) => [r.id, 'title' in r ? r.title : null])), [rows])
  // Cards another bot raised that propose this one for the work (decision 9): read-only, uncounted.
  const lookup = useMemo(() => cardLookupRows(rows, work.cardRows), [rows, work.cardRows])
  const mentions = useMemo(
    () => attention.items.filter((c) => cardMentions(c, lookup).includes(teammateId)),
    [attention.items, lookup, teammateId],
  )
  const raiserName = useCallback(
    (card: BubbleCard): string | null => {
      const key = cardOwnerKeys(card, lookup)[0]
      if (!key) return null
      if (key.startsWith('tm:')) return work.roster.find((t) => `tm:${t.id}` === key)?.name?.trim() || 'Teammate'
      return key.startsWith('lane:') ? laneLabel(key.slice('lane:'.length)) : null
    },
    [lookup, work.roster],
  )
  const total = items.fresh.length + items.seen.length
  // What this bot asks in the chat (P13): a run parked on a question, a card it raised there.
  const asking = useMemo(
    () =>
      rows.some((r) => r.ai_team_member_id === teammateId && r.status === 'needs_input') ||
      attention.asks.some((c) => cardOwnerKeys(c, lookup).includes(teammateKey(teammateId))),
    [rows, attention.asks, lookup, teammateId],
  )

  // The flourish plays on after the last card went (the deck stays mounted till it ends).
  const [resolving, setResolving] = useState(false)
  const onResolvingChange = useCallback((active: boolean) => setResolving(active), [])
  const showDeck = layout.deck.length > 0 || resolving
  const deckWorkspaces = useMemo(() => layout.deck.flatMap((c) => (c.kind === 'work_review' ? [] : [c.workspace_id])), [layout.deck])
  const pickerFor = useCardPickers(deckWorkspaces)
  const refine = useMemo(
    () => (onRefine ? (card: AttentionItem) => onRefine(card, layout.itemOf.get(card.id) ?? null) : undefined),
    [onRefine, layout.itemOf],
  )

  const listRow = ({ item, seen }: ForYouLayout['rows'][number]) => {
    const r = item.row as WorkItem
    const rootId = treeRootId(r)
    return (
      <WorkRow
        key={item.id}
        item={r}
        tone="needs"
        stamp={`waiting ${relativeTime(waitingSince(r))}`}
        workspaceName={null}
        onOpen={() => open.row(r)}
        chips={chips[r.id]}
        onOpenEntity={(c) => open.entity(r, c)}
        // A handoff listed on its own names the run it was part of.
        nest={{ depth: 0, partOf: rootId !== r.id ? (titles.get(rootId) ?? null) : null }}
        seen={seen}
      />
    )
  }

  return (
    <BotPageCard section="for-you" title="For you" hint="What’s new, then what you’ve seen" count={total}>
      {total === 0 && !resolving ? (
        // Never "nothing waiting" while it asks you something in the chat.
        <BotPageEmpty>{asking ? `What ${name} is asking you waits in your chat.` : `Nothing from ${name} is waiting on you.`}</BotPageEmpty>
      ) : (
        <div className="flex flex-col gap-2">
          {showDeck && (
            <div data-bot-page-deck="">
              <AttentionDeck
                items={layout.deck}
                pickerFor={pickerFor}
                onEdit={attention.editCard}
                onAccept={attention.accept}
                onStart={attention.start}
                onDismiss={attention.dismiss}
                onReviewed={work.reviewed}
                onDismissReview={work.dismissReview}
                onResolvingChange={onResolvingChange}
                onRefine={refine}
                surface="bot_page"
                narrow
              />
            </div>
          )}
          {layout.rows.length > 0 && (
            <ul data-bot-page-for-you="" className={cn('space-y-1.5 overflow-y-auto', BOT_PAGE_CARD_BODY_MAX)}>
              {layout.rows.map(listRow)}
            </ul>
          )}
        </div>
      )}
      {mentions.length > 0 && (
        <ul data-bot-page-mentions="" className="mt-2 space-y-1.5" aria-label="From other agents">
          {mentions.map((card) => {
            const place = resolveItem(card.id, source)
            return (
              <Mention
                key={card.id}
                card={card}
                from={raiserName(card)}
                onOpen={place ? () => open.item(place.workItemId, place.workspaceId, card.title || 'A card', place.teammateId) : undefined}
              />
            )
          })}
        </ul>
      )}
    </BotPageCard>
  )
}

/**
 * A card another bot raised that names this one for the work (decision 9):
 * read-only here, with who raised it ("From Triage"), no verbs, no dot, no
 * count. It opens its run's item when the source can place that run, where
 * its raiser's verbs are.
 */
function Mention({ card, from, onOpen }: { card: BubbleCard; from: string | null; onOpen?: () => void }) {
  return (
    <li data-bot-page-mention={card.id} className="rounded-lg border border-border/60 bg-muted/20">
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        title={onOpen ? undefined : 'Its run isn’t known yet, so it can’t open here'}
        className={cn('flex w-full min-w-0 items-start gap-2.5 px-2.5 py-2 text-left', !onOpen && 'cursor-default')}
      >
        <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <StickyNote className="h-3 w-3" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs font-medium text-foreground">{card.title || 'A card'}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{relativeTime(card.created_at)}</span>
          </div>
          <p data-bot-page-mention-from="" className="mt-0.5 text-[11px] text-muted-foreground">
            {from ? `From ${from}` : 'From another agent'}
          </p>
        </div>
        {onOpen && <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
      </button>
    </li>
  )
}
