/**
 * Where the app rail is on screen: tailwind's `md` (48rem), the rail's own
 * `hidden md:flex`. From there up the page panel beside it is a page's
 * sub-nav (../page-panel/page-panel.tsx), so a page's card draws no
 * navigation of its own there (Liam, 11-11: "did you actually clean up the
 * old one and remove it from the panel complely or did you do something the
 * lazy way?"); below it, the phone's layout, the card's own is the only one.
 *
 * Where CSS can say it (a control that exists only below `md`), the card
 * says it in CSS (`md:hidden`), decided by the browser before the first
 * paint. Where the tree itself differs (Team chat's list and its divider,
 * which must not exist beside the sub-nav: a hidden pane still registered
 * in its resizable group drew the resize cursor over the rail and the
 * panel), this hook says it: read from matchMedia, heard as the window
 * crosses the line, never polled. A card mounts on the client only (the
 * card store is restored there), so its first render already reads the
 * window, never the server's guess.
 *
 * Client-safe: no server imports.
 */
import { useSyncExternalStore } from 'react'

/** Where the app rail shows (tailwind's `md`, the rail's `hidden md:flex`). */
export const RAIL_MEDIA = '(min-width: 48rem)'

function subscribeRailMedia(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(RAIL_MEDIA)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** No media queries to ask (a test's DOM): the rail's own CSS decides alone, so nothing is held back here. */
export function railMediaNow(): boolean {
  if (typeof window === 'undefined') return false
  return typeof window.matchMedia !== 'function' || window.matchMedia(RAIL_MEDIA).matches
}

/** The app rail is on screen (the window at `md` or wider); false on the server. */
export function useRailShown(): boolean {
  return useSyncExternalStore(subscribeRailMedia, railMediaNow, () => false)
}
