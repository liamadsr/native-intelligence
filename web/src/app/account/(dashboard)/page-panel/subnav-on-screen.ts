/**
 * Which page's sub-nav is on screen beside the rail now (page-panel.tsx
 * PagePanelHost says), so a page's card hides its own navigation only while
 * its page's sub-nav is really there (Liam, 11-11: the cards draw no
 * navigation of their own from `md` up, the sub-nav being the one place).
 * The breakpoint alone was not enough: with a live capture docked on the
 * left (no panel), with the panel closed by its button, or for a Mail card
 * opened from Recent, For you or a notification (home stays selected, Recent
 * shows), the card had no folders, channels or view tabs at all.
 *
 *   undefined   not decided yet (before the host's first say, no card in
 *               front, a refresh's first commits, the selected place still
 *               settling on the card in front, a page change while the last
 *               panel is held): the
 *               card keeps today's look, its own navigation hidden from `md`
 *               up, so nothing shows then goes (Liam, 11-11: "when I refresh
 *               the page the teams chat chanels and people names show in the
 *               panel first then they go away").
 *   a PageKey   that page's panel is on screen (home's is Recent: no card's).
 *   null        none: the capture's notepad holds the left, the panel is
 *               closed, below `md`, or the place has no panel.
 *
 * The host sets it in a layout effect, so it settles before paint. Flat
 * cost: one value, a render only for the cards whose answer changes.
 *
 * Client-safe: no server imports.
 */
import { useSyncExternalStore } from 'react'
import type { PageKey } from './page-panel-types'

let onScreen: PageKey | null | undefined = undefined
const listeners = new Set<() => void>()

/** The host's say (page-panel.tsx): the page whose sub-nav is on screen, null for none, undefined while undecided. */
export function setSubnavOnScreen(next: PageKey | null | undefined): void {
  if (next === onScreen) return
  onScreen = next
  for (const listener of [...listeners]) listener()
}

export function subnavOnScreen(): PageKey | null | undefined {
  return onScreen
}

export function subscribeSubnavOnScreen(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether `page`'s sub-nav covers its card's navigation now: undecided, or that page's on screen. Never for no page. */
export function subnavCovers(page: PageKey | null, now: PageKey | null | undefined = onScreen): boolean {
  if (page === null) return false
  return now === undefined || now === page
}

/**
 * A page's card: whether its page's sub-nav is its navigation now (hide its
 * own from `md` up), or not (show its own). The server's answer, and the
 * answer before the host has said, is yes: today's look.
 */
export function useOwnSubnavShown(page: PageKey | null): boolean {
  return useSyncExternalStore(
    subscribeSubnavOnScreen,
    () => subnavCovers(page),
    () => page !== null,
  )
}

export function __resetSubnavOnScreenForTests(): void {
  onScreen = undefined
  listeners.clear()
}
