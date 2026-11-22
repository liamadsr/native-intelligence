/**
 * A saved view was made (or changed) outside any useView (a card header's
 * "Save as view" did this until it was removed, Liam, 11-21): every mounted list reloads its saved views
 * (use-view.ts listens), so the card's views menu and the page's tabs show it
 * without a remount. Its own module, so the light card frame can announce it
 * without loading the views hook.
 */
export const VIEWS_CHANGED_EVENT = 'ni:views-changed'

export function announceViewsChanged() {
  window.dispatchEvent(new CustomEvent(VIEWS_CHANGED_EVENT))
}
