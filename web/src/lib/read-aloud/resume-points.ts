/**
 * Where a paused reading picks up again: read-aloud's pause and resume, shared
 * by every reader. Each reading has a key: a chat reply its message id
 * (@/hooks/use-read-aloud), a section in rendered markdown or the note editor
 * its section key, a Listen item `doc:` / `email:` / `brief:` … (all three
 * through ./section-player).
 *
 * The released desktop has no pause, only cancel. So a pause is a cancel plus a
 * note here: the index of the sentence the reading stopped in (the one
 * speaking, or else the first one not yet done). Playing that key again speaks
 * from the start of that sentence: the reader works the sentences out again
 * (the content may have changed) and starts at min(i, n − 1). A true
 * mid-sentence pause would need a desktop command.
 *
 * A run TAKES its key's point when it starts, and from then on carries its own
 * place. So a true stop (voice mode, a new chat turn, a capture or dictation
 * starting, the page going away) leaves no point, and neither does a reading
 * that runs to its end: the next play starts from the top. Starting one
 * reading while another plays pauses that one, which keeps its point, so a
 * click never throws a place away.
 *
 * The most recent pause is `lastPausedKey`. Only that reading shows as paused
 * without a hover (a section's button and dimmed bar, a chat reply's pinned
 * actions row), so paused markers never pile up. Older points are just
 * remembered: playing their key resumes them all the same.
 *
 * In memory for this page load only, and bounded to the MAX_RESUME_POINTS keys
 * paused most recently.
 */

import { useSyncExternalStore } from 'react'

export const MAX_RESUME_POINTS = 50

/** key → the sentence to resume from. Oldest first: a pause moves its key last. */
const points = new Map<string, number>()
let lastPaused: string | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const listener of [...listeners]) listener()
}

/** A reading of `key` paused in sentence `index`: remember it, as the most
 *  recent pause. */
export function setResumePoint(key: string, index: number): void {
  points.delete(key)
  points.set(key, Math.max(0, Math.floor(index)))
  if (points.size > MAX_RESUME_POINTS) {
    const oldest = points.keys().next().value
    if (oldest !== undefined) points.delete(oldest)
  }
  lastPaused = key
  notify()
}

/** Where a reading of `key` was paused, or null. */
export function getResumePoint(key: string): number | null {
  return points.get(key) ?? null
}

/** `key` starts playing: its point (null when it has none), which the store
 *  forgets, since the run carries its place from here. */
export function takeResumePoint(key: string): number | null {
  const point = points.get(key)
  if (point === undefined) return null
  points.delete(key)
  if (lastPaused === key) lastPaused = null
  notify()
  return point
}

/** The key paused most recently, while it still has its point. */
export function getLastPausedKey(): string | null {
  return lastPaused
}

export function subscribeResumePoints(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Where `key` was paused, live (null: it plays from the top). */
export function useResumePoint(key: string): number | null {
  return useSyncExternalStore(
    subscribeResumePoints,
    () => getResumePoint(key),
    () => null,
  )
}

/** Whether `key` is the most recent pause (see the header), live. */
export function useIsLastPaused(key: string): boolean {
  return useSyncExternalStore(
    subscribeResumePoints,
    () => lastPaused === key,
    () => false,
  )
}

/** Tests only: no points. */
export function __resetResumePointsForTests(): void {
  if (points.size === 0 && lastPaused === null) return
  points.clear()
  lastPaused = null
  notify()
}
