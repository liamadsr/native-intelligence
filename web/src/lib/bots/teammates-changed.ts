/**
 * A teammate was made or changed here: its face, its voice (bots-v4 B2), its
 * name or anything else the roster carries (bots-v3 Phase 6: a custom agent's
 * bot, a built face). The crew, the bubble, the bot's page and the desktop
 * overlay's relay draw and voice the bots from the roster the shared agent
 * work source loads (use-agent-work.ts), which reloads on this, so the change
 * shows and sounds straight away instead of on the next reload. The light
 * read never reloads for a push, so nothing else would bring it.
 *
 * Heard in this window (the event) and in the app's other windows (a storage
 * ping: they share storage, and the desktop's main window relays the overlay's
 * bubble from its own roster, whichever window the edit was made in).
 */
export const TEAMMATES_CHANGED_EVENT = 'dial8:teammates-changed'

/** The storage key the app's other windows hear a change on: each ping is a new value, so each one is heard. */
export const TEAMMATES_CHANGED_KEY = 'dial8:teammates-changed'

let pings = 0

/** Tell the roster to reload, here and in the app's other windows. A no-op off the browser. */
export function announceTeammatesChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(TEAMMATES_CHANGED_EVENT))
  try {
    window.localStorage.setItem(TEAMMATES_CHANGED_KEY, `${Date.now()}:${++pings}`)
  } catch {
    // Storage blocked or full: this window has heard it, and the others reload on their own schedule.
  }
}

/**
 * Hear a teammate change: made in this window (the event) or in another of the
 * app's windows (the storage ping, which a window never hears for its own
 * writes). Returns the unsubscribe. A no-op off the browser.
 */
export function onTeammatesChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const here = () => listener()
  const elsewhere = (e: StorageEvent) => {
    if (e.key === TEAMMATES_CHANGED_KEY && e.newValue) listener()
  }
  window.addEventListener(TEAMMATES_CHANGED_EVENT, here)
  window.addEventListener('storage', elsewhere)
  return () => {
    window.removeEventListener(TEAMMATES_CHANGED_EVENT, here)
    window.removeEventListener('storage', elsewhere)
  }
}
