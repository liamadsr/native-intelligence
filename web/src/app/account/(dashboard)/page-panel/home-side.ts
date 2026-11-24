/**
 * Which side of Home's panel shows (docs/plans/hub-panels.md, "One Home";
 * Liam, 11-24: "home's recent is all the things you've interacted with
 * recently … and inbox is where all your notifications are coming in maybe
 * the combined homepage has what we have in team-chat where we have the split
 * between recent and notification or incoming in the sub-navigation"):
 *
 *   recent  what the person touched lately (home-recents.tsx);
 *   inbox   what came to them (inbox-panel.tsx): the Inbox page as it was.
 *
 * Recent on a first visit, then the side last chosen, on this device (as
 * Team chat's All | Recent is: team-chat-panel-prefs.ts). Every way into the
 * Inbox page (`/`, Search, G J, a deep link) puts Home on its Inbox side
 * (rail/selected-place.ts).
 *
 * Client-safe; storage blocked or absent: kept for this page load only.
 */
import { useSyncExternalStore } from 'react'

export type HomeSide = 'recent' | 'inbox'

export const HOME_SIDE_KEY = 'ni:home-panel:side'

const parse = (raw: string | null): HomeSide => (raw === 'inbox' ? 'inbox' : 'recent')

let side: HomeSide | null = null
const listeners = new Set<() => void>()

function read(): HomeSide {
  if (side === null) {
    try {
      side = parse(typeof window === 'undefined' ? null : window.localStorage.getItem(HOME_SIDE_KEY))
    } catch {
      side = 'recent'
    }
  }
  return side
}

function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== HOME_SIDE_KEY) return
  side = null
  for (const l of [...listeners]) l()
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

export function homeSide(): HomeSide {
  return read()
}

export function useHomeSide(): HomeSide {
  return useSyncExternalStore(subscribe, read, () => 'recent')
}

export function setHomeSide(next: HomeSide): void {
  if (read() === next) return
  side = next
  try {
    window.localStorage.setItem(HOME_SIDE_KEY, next)
  } catch {
    // Storage blocked: this page load only.
  }
  for (const l of [...listeners]) l()
}

/** The other side (the S key). */
export const otherHomeSide = (s: HomeSide): HomeSide => (s === 'recent' ? 'inbox' : 'recent')

/** Tests: nothing read. */
export function __resetHomeSideForTests(): void {
  side = null
  listeners.clear()
}
