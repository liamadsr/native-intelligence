/**
 * Open the `/` palette from outside the chat box (the top bar's search
 * button: top-bar/search-button.tsx), as `/` pressed outside a text field
 * does (docs/plans/slash-search.md). The main chat's composer answers
 * OPEN_SEARCH_EVENT (chat/chat-input.tsx): it opens the palette, or closes
 * it when it's already open.
 *
 * With a `source` (the button), the button is seen to travel there: it lifts
 * off and the palette's box grows out of it in the middle of the page, the
 * flight For you's Reply takes into the composer (card-reply-flight.ts). No
 * composer to answer (none on screen, or one in voice mode): no palette, and
 * the held copy is let go at once. `/` and ⌘K pressed anywhere take the same
 * flight out of the button (launchSearchFlight, chat-input.tsx), and a
 * dismissed palette flies back into it (flySearchBack).
 *
 * Client-safe: no server imports.
 */
import { SEARCH_FLIGHT_KEY, SEARCH_FLIGHT_MS, SEARCH_SETTLE_MS, cancelFlight, flyBack, launchFlight } from './card-reply-flight'

/** Asks the main chat's composer to open (or close) the `/` palette. Cancelled (preventDefault) by the one that answers. */
export const OPEN_SEARCH_EVENT = 'dial8:open-search'

/** The top bar's search button, where it shows. */
export function searchButton(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('[data-search-button]')
}

/** Hold a copy of `source` (the search button) for the palette to land: the search flight, at its own pace. */
export function launchSearchFlight(source: HTMLElement | null): void {
  if (source) launchFlight(SEARCH_FLIGHT_KEY, source, { ms: SEARCH_FLIGHT_MS, settleMs: SEARCH_SETTLE_MS, keepCorners: true })
}

/** The palette dismissed: its box (`box`) flies back into the search button, the way it came. */
export function flySearchBack(box: HTMLElement | null): void {
  flyBack(box, searchButton(), { ms: SEARCH_FLIGHT_MS, settleMs: SEARCH_SETTLE_MS, keepCorners: true })
}

/** Open the palette, flying from `source` when given. False when no composer answered. */
export function openSearch(source?: HTMLElement | null): boolean {
  if (typeof window === 'undefined') return false
  launchSearchFlight(source ?? null)
  const answered = !window.dispatchEvent(new Event(OPEN_SEARCH_EVENT, { cancelable: true }))
  if (!answered) cancelFlight(SEARCH_FLIGHT_KEY)
  return answered
}
