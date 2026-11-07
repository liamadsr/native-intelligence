/**
 * A saved view was made (or changed) outside any useView, e.g. a chat card's
 * "Save as view" in its header: every mounted list reloads its saved views
 * (use-view.ts listens), so the card's views menu and the page's tabs show it
 * without a remount. Its own module, so the light card frame can announce it
 * without loading the views hook.
 */
export const VIEWS_CHANGED_EVENT = 'dial8:views-changed'

export function announceViewsChanged() {
  window.dispatchEvent(new CustomEvent(VIEWS_CHANGED_EVENT))
}
