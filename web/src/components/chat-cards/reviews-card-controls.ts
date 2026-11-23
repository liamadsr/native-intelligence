/**
 * Between the Reviews page's card and its sub-nav beside the rail
 * (docs/plans/github-reviews.md, "Reviews on the app's own list";
 * app/account/(dashboard)/page-panel/reviews-panel.tsx), as My Actions'
 * card and panel talk (tasks-card-controls.ts): the card says which section
 * (Review requests, Authored, Assigned, Involves) and which state (Open,
 * Closed, All) it shows, the panel lights its rows from that and moves the
 * card. Nothing goes the other way: from `md` up the card has no section
 * tabs of its own.
 *
 * Client-safe: no server imports.
 */
import { useSyncExternalStore } from 'react'
import type { ReviewSection, ReviewStateFilter } from '@/lib/github/reviews'

export interface ReviewsCardControls {
  cardId: string
  section: ReviewSection
  state: ReviewStateFilter
  setSection: (section: ReviewSection) => void
  setState: (state: ReviewStateFilter) => void
  /** Put the card in front (a record opened over the page as its own card is there). */
  show: () => void
}

let cards: ReviewsCardControls[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function publishReviewsCard(controls: ReviewsCardControls): void {
  cards = [...cards.filter((c) => c.cardId !== controls.cardId), controls]
  notify()
}

export function unpublishReviewsCard(cardId: string): void {
  if (!cards.some((c) => c.cardId === cardId)) return
  cards = cards.filter((c) => c.cardId !== cardId)
  notify()
}

/** The Reviews card the panel moves: the one in front, else the latest. */
export function reviewsCardFor(frontId: string | null): ReviewsCardControls | null {
  if (frontId) {
    const own = cards.find((c) => c.cardId === frontId)
    if (own) return own
  }
  return cards.length ? cards[cards.length - 1] : null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useReviewsCard(frontId: string | null): ReviewsCardControls | null {
  return useSyncExternalStore(
    subscribe,
    () => reviewsCardFor(frontId),
    () => null,
  )
}

/** Tests: no card. */
export function __resetReviewsCardsForTests(): void {
  cards = []
}
