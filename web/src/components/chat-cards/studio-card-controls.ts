/**
 * Between the Studio page's card and its sub-nav beside the rail
 * (app/account/(dashboard)/page-panel/studio-panel.tsx), as the Tasks and
 * Team chat cards have theirs (./tasks-card-controls.ts,
 * ./team-chat-card-controls.ts).
 *
 * The card (./pages/studio-card.tsx) says where the Studio is: the video
 * open in it, that video's title as the Studio has it now (a rename shows at
 * once), and which of its pages is on screen (its Studio project's overview,
 * or its Overview, Storyboard, Cast or Edit). The sub-nav lights its rows
 * from that, never from its own clicks, and moves the Studio by asking the
 * card (`go`): the card hands the ask to the Studio, which opens it and says
 * where it is, as when the person moves inside it. So nothing echoes: a
 * place the Studio itself reported is never handed back to it as a request
 * (the card's own rule, see its header).
 *
 * Nothing goes the other way: the card decides by itself whether it draws its
 * own rail (only while the sub-nav is not on screen,
 * page-panel/subnav-on-screen.ts).
 *
 * Flat cost: one module-level list, written when the Studio's place changes;
 * no timer, no fetch.
 *
 * Client-safe: no server imports.
 */
import { useSyncExternalStore } from 'react'

/** A video's pages, and `project` for the overview of the Studio project it is in (studio-root.tsx StudioPage). */
export type StudioCardPage = 'project' | 'overview' | 'storyboard' | 'cast' | 'edit'

export interface StudioCardControls {
  /** The card's id (its tool call or opened-card id): the front card's, when it is in front. */
  cardId: string
  /** The workspace the Studio is open in. */
  workspaceId: string | null
  /** The video open in the Studio; null: none yet (still opening, or none in the workspace). */
  videoId: string | null
  /** Its title as the Studio has it now; null: not known yet. */
  title: string | null
  /** Which of its pages is on screen; null: not known yet (the Studio is still opening). */
  page: StudioCardPage | null
  /** Open that video in the Studio, on that page (null: the page it was last on). */
  go: (videoId: string, page: StudioCardPage | null) => void
  /** Put the card full screen (another card is in front). */
  show: () => void
}

let cards: StudioCardControls[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Say where a Studio card is (again): replaces what it said before, and makes it the latest. */
export function publishStudioCard(controls: StudioCardControls): void {
  cards = [...cards.filter((c) => c.cardId !== controls.cardId), controls]
  notify()
}

/** The card is gone (unmounted). */
export function unpublishStudioCard(cardId: string): void {
  if (!cards.some((c) => c.cardId === cardId)) return
  cards = cards.filter((c) => c.cardId !== cardId)
  notify()
}

/**
 * The Studio card the sub-nav moves: the one in front when it is one, else
 * the latest that said where it is (a record opened over the page is in
 * front; a row puts the Studio's card back first). Null: none. Stable between
 * changes (useSyncExternalStore).
 */
export function studioCardFor(frontId: string | null): StudioCardControls | null {
  if (frontId) {
    const own = cards.find((c) => c.cardId === frontId)
    if (own) return own
  }
  return cards.length ? cards[cards.length - 1] : null
}

export function subscribeStudioCards(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The Studio card for the card in front (see studioCardFor), redrawn when it changes. */
export function useStudioCard(frontId: string | null): StudioCardControls | null {
  return useSyncExternalStore(
    subscribeStudioCards,
    () => studioCardFor(frontId),
    () => null,
  )
}

/** Tests: no card. */
export function __resetStudioCardsForTests(): void {
  cards = []
}
