/**
 * Between the Team chat page's card and its sub-nav beside the rail (Liam,
 * 11-11: "make the team-chat one look like this";
 * app/account/(dashboard)/page-panel/team-chat-panel.tsx).
 *
 * The card (views/team-chat-view.tsx, a card's TeamChatView) says what it
 * has and where it is: its conversations (channels, direct messages and,
 * where calling is on, meetings), each with its title, its unread and
 * mentions, how loud it is, its team's name and its DM's other person, as
 * the view's own list draws them, kept current by the view's realtime; the
 * conversation on screen; and what moves it (open a conversation, the
 * view's own New channel and New message dialogs). The panel reads it and
 * moves it; it lights a row from what the card says, never from its own
 * clicks.
 *
 * Nothing goes the other way: the card draws no list of its own where the
 * panel can be (full screen from `md` up, decided by the card itself from
 * the window, team-chat-view.tsx), so it never waits on the panel to know
 * (Liam, 11-11: "did you actually clean up the old one and remove it from
 * the panel complely or did you do something the lazy way?").
 *
 * Kept after the card goes (Liam, 11-11: "it goes away completely and
 * reappears every time" … "only on first load"): the last conversations a
 * card said, per workspace, so the sub-nav lists them at once on the next
 * visit, before a card is back (a page falls out of the pages kept mounted,
 * card-store.ts LIVE_CARDS, and its view loads its list again), and a view
 * just mounted says them as its own until its read lands (`pending`).
 *
 * Flat cost: one module-level list and one entry per workspace, written when
 * a card's list changes; no timer, no fetch of its own.
 *
 * Client-safe: no server imports.
 */
import { useSyncExternalStore } from 'react'
import type { TeamChatChannel } from '@/lib/team-chat/types'

/** One conversation as the card's own list draws it. */
export interface TeamChatPanelConversation {
  channel: TeamChatChannel
  /** As the view titles it: a channel's name, a DM's other person ("… (you)" for a note to self), a meeting's name. */
  title: string
  /** A team channel's team, by name (null: the whole workspace's, or a team not known here). */
  teamName: string | null
  /** A private team's channel (a lock, not a #). */
  privateTeam: boolean
  /** A DM's other person, for their avatar (photo, else initials). */
  person: { name: string; url: string | null } | null
}

export interface TeamChatCardControls {
  /** The card's id (its tool call or opened-card id): the front card's, when it is in front. */
  cardId: string
  /** The workspace the conversations are in (favorites are kept per workspace). */
  workspaceId: string | null
  /** Every conversation the view lists, in the server's order (latest activity first). */
  conversations: readonly TeamChatPanelConversation[]
  /** The conversation on screen in the card; null: none. */
  openId: string | null
  /** Open that conversation in the card (the view's own openChannel). */
  open: (id: string) => void
  /** The view's New channel dialog; with a team, that team picked in it. */
  newChannel: (teamId: string | null) => void
  /** The view's New message dialog. */
  newDm: () => void
  /**
   * The view's New meeting link dialog, where calling is on; null where it is
   * off (no Meetings section then, as the page lists none).
   */
  newMeeting: (() => void) | null
  /** Put the card full screen (another card is in front). */
  show: () => void
  /**
   * The view's own list isn't read yet: `conversations` are the last ones
   * this workspace's card said (lastTeamChat), kept until its read lands.
   */
  pending?: boolean
}

/** What a workspace's card last said of its list: its conversations, and whether calling (Meetings) was on. */
export interface TeamChatLast {
  conversations: readonly TeamChatPanelConversation[]
  meetings: boolean
}

let cards: TeamChatCardControls[] = []
const last = new Map<string, TeamChatLast>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Say what a team chat card has (again): replaces what it said before, and makes it the latest. */
export function publishTeamChatCard(controls: TeamChatCardControls): void {
  cards = [...cards.filter((c) => c.cardId !== controls.cardId), controls]
  // Its own read (not the kept list it was given): kept for the workspace's next visit.
  if (controls.workspaceId && !controls.pending) {
    const was = last.get(controls.workspaceId)
    const meetings = !!controls.newMeeting
    if (was?.conversations !== controls.conversations || was.meetings !== meetings) {
      last.set(controls.workspaceId, { conversations: controls.conversations, meetings })
    }
  }
  notify()
}

/** The last conversations a card of this workspace said (kept after it goes), or null: none yet here. */
export function lastTeamChat(workspaceId: string | null): TeamChatLast | null {
  return workspaceId ? (last.get(workspaceId) ?? null) : null
}

/** lastTeamChat, redrawn when a card says more. */
export function useLastTeamChat(workspaceId: string | null): TeamChatLast | null {
  return useSyncExternalStore(
    subscribeTeamChatCards,
    () => lastTeamChat(workspaceId),
    () => null,
  )
}

/** The card is gone (unmounted). */
export function unpublishTeamChatCard(cardId: string): void {
  if (!cards.some((c) => c.cardId === cardId)) return
  cards = cards.filter((c) => c.cardId !== cardId)
  notify()
}

/**
 * The team chat card the panel moves: the one in front when it is one, else
 * the latest that said what it has. Null: none. Stable between changes
 * (useSyncExternalStore).
 */
export function teamChatCardFor(frontId: string | null): TeamChatCardControls | null {
  if (frontId) {
    const own = cards.find((c) => c.cardId === frontId)
    if (own) return own
  }
  return cards.length ? cards[cards.length - 1] : null
}

export function subscribeTeamChatCards(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The team chat card for the card in front (see teamChatCardFor), redrawn when it changes. */
export function useTeamChatCard(frontId: string | null): TeamChatCardControls | null {
  return useSyncExternalStore(
    subscribeTeamChatCards,
    () => teamChatCardFor(frontId),
    () => null,
  )
}

/** Tests: no card. */
export function __resetTeamChatCardsForTests(): void {
  cards = []
  last.clear()
}
