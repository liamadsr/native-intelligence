'use client'

/**
 * "A coding chat needs you", for where Recent is not what the person is
 * looking at (docs/plans/one-home.md, "The left side"; Liam, 11-20: the
 * orange dot was on the Code tab, which now starts a new chat). The chat's
 * own row in Recent carries the dot; while Recent is off screen (the panel on
 * Incoming, or closed) the same orange dot is on the way back to it: the
 * switch's Recent side (home-recents.tsx), the panel's button
 * (page-panel-toggle.tsx). Incoming's side does the same with its own dot.
 *
 * What it knows, with no read of its own and no timer:
 *   reviews  coding work waiting on the person's review, live, from the
 *            shell's shared source (chat/for-you-column.tsx);
 *   asks     how many of Recent's coding rows waited on the person at its
 *            last read (Recent says, each time it has rows: setCodingRowsWaiting).
 */
import { useSyncExternalStore } from 'react'
import { useCodeForYouEntries } from '../chat/for-you-column'

let waiting = 0
const listeners = new Set<() => void>()

/** Recent says how many of its coding rows wait on the person (asks or review), as it last read them. */
export function setCodingRowsWaiting(count: number): void {
  if (waiting === count) return
  waiting = count
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const read = () => waiting
const none = () => 0

/** A coding chat waits on the person: an answer, or a review. */
export function useCodingNeedsYou(): boolean {
  const reviews = useCodeForYouEntries().length
  const rows = useSyncExternalStore(subscribe, read, none)
  return reviews > 0 || rows > 0
}

export function __resetCodingAttentionForTests(): void {
  waiting = 0
  listeners.clear()
}
