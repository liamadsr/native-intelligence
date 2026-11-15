/**
 * The Studio's list changed: a video or a Studio project was made, renamed,
 * moved, filed, taken out, duplicated or archived. Said by the Studio's own
 * calls to its server (./ui/client.ts) when one of them succeeds, and heard by
 * the Studio card (components/chat-cards/pages/studio-card.tsx), which reads
 * the list again then, and only then (no polling: ./studio-list.ts), so the
 * agent knows which Studio project the open video is in.
 *
 * A save of the open video's edit is not a change of the list (it happens
 * after every edit).
 *
 * Flat cost: one counter and a set of listeners. Client-safe.
 */
import { useSyncExternalStore } from 'react'

/**
 * Whether a call to the Studio's server changes its list of videos and
 * Studio projects: anything but a read, to a Studio project (`campaigns…`), a
 * new blank video, or one video's archive, rename, duplicate, status, filing
 * or new format. Not a save of an edit (PUT `projects/<id>`), nor the work
 * inside one video (ops, takes, versions, delivery, checks).
 */
export function changesStudioList(method: string, path: string): boolean {
  const verb = method.toUpperCase()
  if (verb === 'GET' || verb === 'HEAD') return false
  const at = path.split('?')[0]!.replace(/\/+$/, '')
  const m = /\/studio\/(.+)$/.exec(at)
  if (!m) return false
  const rest = m[1]!
  if (/^campaigns(\/|$)/.test(rest)) return !/\/(brand-kit|static-ads|motion-ads|reels)(\/|$)/.test(rest)
  if (rest === 'projects/blank') return true
  if (/^projects\/[^/]+$/.test(rest)) return verb === 'DELETE' || verb === 'PATCH'
  return /^projects\/[^/]+\/(duplicate|rename|status|unfile|formats)$/.test(rest)
}

let revision = 0
const listeners = new Set<() => void>()

/** A call to the Studio's server succeeded: when it changed the list, say so. */
export function noteStudioCall(method: string, path: string): void {
  if (changesStudioList(method, path)) noteStudioChange()
}

/** The Studio's list changed (made, renamed, moved, archived). */
export function noteStudioChange(): void {
  revision += 1
  for (const listener of [...listeners]) listener()
}

export function studioRevision(): number {
  return revision
}

export function subscribeStudioChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** How many times the list changed so far: a new number each time it does. */
export function useStudioRevision(): number {
  return useSyncExternalStore(subscribeStudioChanges, studioRevision, () => 0)
}

/** Tests: back to the start. */
export function __resetStudioChangesForTests(): void {
  revision = 0
  listeners.clear()
}
