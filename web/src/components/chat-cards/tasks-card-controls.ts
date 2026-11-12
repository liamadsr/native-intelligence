/**
 * Between the My Actions page's card and its sub-nav beside the rail (Liam,
 * 11-11: "eventually I want to get to the point where we have one todo icon
 * on the main nav and when you click it the sub-nav would show things like
 * milestone and projects that way it's nested and clean and not at the top
 * level"; app/account/(dashboard)/page-panel/tasks-panel.tsx).
 *
 * The card (card-body.tsx TasksCardBody) says where it is, the panel reads
 * it and moves it: which of the page's views it shows (its view tabs' state,
 * components/views/hooks/use-view.ts), the saved view picked, the place
 * inside the card (Projects, Initiatives… a step in the card's own history,
 * card-history.tsx), and what moves each. The panel lights a row from what
 * the card says, never from its own clicks, so Back and the page's own
 * controls keep it right.
 *
 * Nothing goes the other way: the full-screen card has no view tabs of its
 * own from `md` up (CSS, unified-view-layout.tsx viewTabsBelowMdOnly), so it
 * never waits on the panel to know (Liam, 11-11: "did you actually clean up
 * the old one and remove it from the panel complely or did you do something
 * the lazy way?").
 *
 * Flat cost: one module-level list, written when a card's place changes; no
 * timer.
 *
 * Client-safe: no server imports.
 */
import { useSyncExternalStore } from 'react'
import type { ActionScope } from '@/lib/views/action-scopes'
import type { TasksPlace } from '@/lib/chat-cards/tasks-places'

export type { TasksPlace } from '@/lib/chat-cards/tasks-places'

/** A saved view, as the sub-nav lists it. */
export interface TasksSavedView {
  id: string
  name: string
}

export interface TasksCardControls {
  /** The card's id (its tool call or opened-card id): the front card's, when it is in front. */
  cardId: string
  /** The view tab the card's list is on; null while a saved view is. */
  scope: ActionScope | null
  /** The saved view picked; null: none. */
  viewId: string | null
  /** The person's saved views for actions, as the card's list read them. */
  views: readonly TasksSavedView[]
  /** Where inside the card: null its own list, else a place over it. */
  place: TasksPlace | null
  /** Back to the card's list (a step, when it was elsewhere), on that view. */
  setScope: (scope: ActionScope) => void
  /** Back to the card's list, on that saved view. */
  setView: (viewId: string) => void
  /** To a place inside the card: a step in its history. */
  go: (place: TasksPlace) => void
  /** Put the card full screen (a record opened over the page as its own card is in front). */
  show: () => void
}

let cards: TasksCardControls[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Say where a Tasks card is (again): replaces what it said before, and makes it the latest. */
export function publishTasksCard(controls: TasksCardControls): void {
  cards = [...cards.filter((c) => c.cardId !== controls.cardId), controls]
  notify()
}

/** The card is gone (unmounted). */
export function unpublishTasksCard(cardId: string): void {
  if (!cards.some((c) => c.cardId === cardId)) return
  cards = cards.filter((c) => c.cardId !== cardId)
  notify()
}

/**
 * The Tasks card the panel moves: the one in front when it is one, else the
 * latest that said where it is (a record opened over the page as its own
 * card is in front; its rows put the page's card back first). Null: none.
 * Stable between changes (useSyncExternalStore).
 */
export function tasksCardFor(frontId: string | null): TasksCardControls | null {
  if (frontId) {
    const own = cards.find((c) => c.cardId === frontId)
    if (own) return own
  }
  return cards.length ? cards[cards.length - 1] : null
}

export function subscribeTasksCards(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The Tasks card for the card in front (see tasksCardFor), redrawn when it changes. */
export function useTasksCard(frontId: string | null): TasksCardControls | null {
  return useSyncExternalStore(
    subscribeTasksCards,
    () => tasksCardFor(frontId),
    () => null,
  )
}

/** Tests: no card. */
export function __resetTasksCardsForTests(): void {
  cards = []
}
