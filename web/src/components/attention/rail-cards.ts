/**
 * What the attention deck can show (ACTIVITY-AND-REVIEW-DESIGN §4.4): a pending
 * attention card — the personal offer queue a verdict run writes — or a work
 * item waiting on a review, read straight off the ledger. One deck, one
 * cursor, one "Agent alerts" header. The ledger row stays the only record of
 * the review (no second row, nothing to reconcile); the card is just where it
 * shows up, and it leaves the moment the row stops waiting — reviewed here,
 * dismissed here, or resolved on the deliverable's own surface.
 */
import type { AttentionItem } from '@/hooks/use-attention-items'
import { waitingSince } from '@/lib/work/presentation'
import type { WorkItem } from '@/lib/work/types'

export interface ReviewCardItem {
  kind: 'work_review'
  /** Deck identity — prefixed so it can never collide with an attention card's id. */
  id: string
  workspace_id: string
  title: string
  /** When the item started waiting: the deck's sort key, like a card's created_at. */
  created_at: string
  work: WorkItem
  /** You've opened it since it started waiting (a bot's seen part, bots-v4.md Phase 3): it wears "Seen". */
  seen?: boolean
}

export type DeckCard = AttentionItem | ReviewCardItem

export const REVIEW_CARD_ID_PREFIX = 'work:'

export function isReviewCard(card: DeckCard): card is ReviewCardItem {
  return card.kind === 'work_review'
}

export function reviewCardOf(work: WorkItem, { seen = false }: { seen?: boolean } = {}): ReviewCardItem {
  return {
    kind: 'work_review',
    id: `${REVIEW_CARD_ID_PREFIX}${work.id}`,
    workspace_id: work.workspace_id,
    title: work.title,
    created_at: waitingSince(work),
    work,
    ...(seen ? { seen: true } : {}),
  }
}

/**
 * The deck's browse state, handed DOWN to the top card so the pager can live
 * inside the card's own control bar instead of a floating header above the
 * stack. The deck still owns the cursor; the card only renders it and calls
 * back. `total <= 1` means there is nothing to page through — the card hides
 * the control entirely rather than showing a dead "1/1".
 */
export interface DeckPager {
  /** 1-based position of the top card. */
  position: number
  total: number
  onPrev: () => void
  onNext: () => void
  atStart: boolean
  atEnd: boolean
}
