/**
 * Between the Mail page's card and its sub-nav beside the rail (Liam, 11-11:
 * "see and select all the accounts … the inbox, faves, sent … and any tags
 * that are available for email"; app/account/(dashboard)/page-panel/mail-panel.tsx).
 *
 * The card (email-layout.tsx, a card's EmailLayout) says where it is, the
 * panel reads it and moves it: the folder (a step in the card's history, as
 * its folder Select's), the mailboxes it lists (the state its account
 * dropdown sets: all, or some), the tag it is filtered to, and the folders'
 * counts it already read. The panel lights rows from what the card says,
 * never from its own clicks, so Back and the page's own controls keep it
 * right.
 *
 * Nothing goes the other way: the full-screen card has no account dropdown
 * or folder Select of its own from `md` up (CSS, email-layout.tsx), so it
 * never waits on the panel to know (Liam, 11-11: "did you actually clean up
 * the old one and remove it from the panel complely or did you do something
 * the lazy way?"). The panel clears the tag it set when it leaves
 * (mail-panel.tsx).
 *
 * Flat cost: one module-level list, written when a card's state changes; no
 * timer.
 *
 * Client-safe: no server imports.
 */
import { useSyncExternalStore } from 'react'
import type { FolderCounts } from '@/components/email/mail-folders'

export interface MailCardControls {
  /** The card's id (its tool call or opened-card id): the front card's, when it is in front. */
  cardId: string
  /** The folder the card is on (inbox, review, starred…). */
  folder: string
  /** The mailboxes it lists: null all of them, else those ids. */
  accounts: string[] | null
  /** The tag its list is filtered to; null: none. */
  labelId: string | null
  /** The folders' counts the card read (Inbox's unread, To review, Drafts…). */
  counts: FolderCounts
  /** To that folder: a step in the card's history (as its folder Select); clears the tag. */
  setFolder: (folder: string) => void
  /** List those mailboxes (null: all), as the account dropdown does. */
  setAccounts: (accounts: string[] | null) => void
  /** Filter the list to a tag; null clears it. */
  setLabel: (labelId: string | null) => void
  /** Put the card full screen (another card is in front). */
  show: () => void
}

let cards: MailCardControls[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Say where a mail card is (again): replaces what it said before, and makes it the latest. */
export function publishMailCard(controls: MailCardControls): void {
  cards = [...cards.filter((c) => c.cardId !== controls.cardId), controls]
  notify()
}

/** The card is gone (unmounted). */
export function unpublishMailCard(cardId: string): void {
  if (!cards.some((c) => c.cardId === cardId)) return
  cards = cards.filter((c) => c.cardId !== cardId)
  notify()
}

/**
 * The mail card the panel moves: the one in front when it is one, else the
 * latest that said where it is. Null: none. Stable between changes
 * (useSyncExternalStore).
 */
export function mailCardFor(frontId: string | null): MailCardControls | null {
  if (frontId) {
    const own = cards.find((c) => c.cardId === frontId)
    if (own) return own
  }
  return cards.length ? cards[cards.length - 1] : null
}

export function subscribeMailCards(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The mail card for the card in front (see mailCardFor), redrawn when it changes. */
export function useMailCard(frontId: string | null): MailCardControls | null {
  return useSyncExternalStore(
    subscribeMailCards,
    () => mailCardFor(frontId),
    () => null,
  )
}

/** Tests: no card. */
export function __resetMailCardsForTests(): void {
  cards = []
}
