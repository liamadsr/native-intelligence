/**
 * What SCOUT just did to a prospect list — published by the chat panel, read by
 * the list page (C2).
 *
 * This is selection-context.ts run in the opposite direction. There the list
 * page publishes what the user is LOOKING at and the chat reads it; here the
 * chat publishes what its tools DID and the list page reads it. Same reason for
 * an external store rather than context: publisher and reader sit on opposite
 * sides of the tab tree, and a provider spanning both would re-render every tab
 * on every streamed token.
 *
 * The gap this closes: Scout saves fourteen rows to the CRM and enrolls them in
 * a sequence, all inside the chat strip. The list page next to it still shows
 * the pre-save stage counts and still offers the full research gate, because
 * nothing told it anything happened. With this store the page can (a) go quiet
 * about gates while Scout is working the list, (b) refetch when Scout mutates
 * it, and (c) tell the same save/enroll story the page tells for its own saves.
 *
 * Keyed by LIST id, merged across panels: several tabs' chats can each be
 * working the same list, and the reader wants the most recent thing that
 * happened to it — not whichever panel happened to publish last.
 *
 * Lifecycle contract (pinned by the tests):
 *   • A panel publishes one entry per list its conversation has touched.
 *   • `version` bumps ONLY when a not-yet-seen toolCallId lands, so a resumed
 *     conversation replaying its whole transcript through setMessages does not
 *     look like a fresh burst of saves to the page's refetch effect.
 *   • Unmount publishes null for every list that panel touched — a dead panel
 *     must not keep a list looking busy.
 */
'use client'

import { useCallback, useSyncExternalStore } from 'react'

/** Counts from one `save_prospect_entries` or `publish_prospect_list` call,
 *  folded to a single list. */
export interface ScoutSaveEvent {
  toolCallId: string
  /** True for a publish — the rows went into the CRM — false for a save,
   *  which only kept them on the list (migration 259). */
  published: boolean
  saved_companies: number
  saved_people: number
  needs_review: number
  skipped_other: number
  sequenceable_count: number
}

/** One `enroll_contacts_in_sequence` call, attributed to a list. */
export interface ScoutEnrollEvent {
  toolCallId: string
  sequence_id: string
  sequence_name: string | null
  enrolled_count: number
  skipped_count: number
}

/** One `dismiss_prospect_entries` call, folded to a single list. */
export interface ScoutDismissEvent {
  toolCallId: string
  updated: number
}

/**
 * Everything one chat panel knows about what happened to one list. The page
 * reads `version` to decide whether to refetch and `touched` to decide whether
 * to stand down its own gates.
 */
export interface ScoutListActivity {
  listId: string
  /** Bumps on every new event. The page's refetch effect keys on this. */
  version: number
  lastEventAt: number
  /** Scout has used a tool naming this list in this conversation. */
  touched: boolean
  lastSave: ScoutSaveEvent | null
  lastEnroll: ScoutEnrollEvent | null
  lastDismiss: ScoutDismissEvent | null
}

type Listener = () => void

/** listId → (chatSessionId → that panel's contribution). */
const byList = new Map<string, Map<string, ScoutListActivity>>()
/** listId → the subscribed readers for that list. */
const listeners = new Map<string, Set<Listener>>()
/** listId → the merged snapshot last handed to readers (identity-stable). */
const merged = new Map<string, ScoutListActivity>()

function notify(listId: string) {
  const set = listeners.get(listId)
  if (!set) return
  for (const fn of [...set]) fn()
}

/**
 * Recompute the merged view for one list and, if it actually changed, swap the
 * cached snapshot and wake the readers.
 *
 * Merge rule: the contribution with the greatest `lastEventAt` wins outright.
 * Two panels working the same list are two independent stories; interleaving
 * their events would invent a third that neither conversation told.
 */
function recompute(listId: string) {
  const panels = byList.get(listId)
  let winner: ScoutListActivity | null = null
  if (panels) {
    for (const activity of panels.values()) {
      if (!winner || activity.lastEventAt > winner.lastEventAt) winner = activity
    }
  }
  const prev = merged.get(listId) ?? null
  if (winner === null) {
    if (prev === null) return
    merged.delete(listId)
    notify(listId)
    return
  }
  // Identity stability: the reader feeds this into effect dependency arrays, so
  // republishing an equal object would re-run its refetch for nothing.
  if (prev && sameActivity(prev, winner)) return
  merged.set(listId, winner)
  notify(listId)
}

function sameActivity(a: ScoutListActivity, b: ScoutListActivity): boolean {
  return (
    a === b ||
    (a.listId === b.listId &&
      a.version === b.version &&
      a.lastEventAt === b.lastEventAt &&
      a.touched === b.touched &&
      a.lastSave?.toolCallId === b.lastSave?.toolCallId &&
      a.lastEnroll?.toolCallId === b.lastEnroll?.toolCallId &&
      a.lastDismiss?.toolCallId === b.lastDismiss?.toolCallId)
  )
}

/**
 * Publish (or clear) one chat panel's activity for one list.
 *
 * `chatSessionId` is the panel's identity — the same key `useChat` runs under —
 * so a second tab's chat working the same list adds a contribution rather than
 * overwriting the first. Pass `null` to withdraw this panel's contribution
 * (unmount, or the conversation was replaced).
 */
export function publishScoutActivity(
  chatSessionId: string,
  listId: string,
  activity: ScoutListActivity | null,
): void {
  if (!chatSessionId || !listId) return
  if (activity === null) {
    const panels = byList.get(listId)
    if (!panels || !panels.has(chatSessionId)) return
    panels.delete(chatSessionId)
    if (panels.size === 0) byList.delete(listId)
    recompute(listId)
    return
  }
  let panels = byList.get(listId)
  if (!panels) {
    panels = new Map()
    byList.set(listId, panels)
  }
  const prev = panels.get(chatSessionId)
  // The publisher builds a fresh object every memo pass; skip identical ones so
  // an unrelated re-render of the chat panel doesn't wake the list page.
  if (prev && sameActivity(prev, activity)) return
  panels.set(chatSessionId, { ...activity, listId })
  recompute(listId)
}

/** Read the merged activity without subscribing (event handlers, tests). */
export function readScoutActivity(listId: string | null): ScoutListActivity | null {
  if (!listId) return null
  return merged.get(listId) ?? null
}

/**
 * Subscribe a component to one list's Scout activity. A `null` listId (the page
 * isn't showing a list) subscribes to nothing and always reads `null`.
 */
export function useScoutActivity(listId: string | null): ScoutListActivity | null {
  const subscribe = useCallback(
    (onChange: Listener) => {
      if (!listId) return () => {}
      let set = listeners.get(listId)
      if (!set) {
        set = new Set()
        listeners.set(listId, set)
      }
      set.add(onChange)
      return () => {
        set!.delete(onChange)
        if (set!.size === 0) listeners.delete(listId)
      }
    },
    [listId],
  )
  const getSnapshot = useCallback(() => readScoutActivity(listId), [listId])
  // No chat panel exists during the server render, so there is never activity.
  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}

/** Test-only reset so one spec's publishes can't leak into the next. */
export function __resetScoutActivityStore(): void {
  byList.clear()
  listeners.clear()
  merged.clear()
}
