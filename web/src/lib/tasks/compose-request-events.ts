/**
 * "Compose a push for this action, but not HERE" — the board card's hand-off to
 * the action detail panel.
 *
 * Inline compose puts the provider's fields where the action's own properties
 * already are. Every surface has such a place except one: a board CARD is about
 * 250px of column, and the strip's smallest useful line is a Create button, a
 * cancel, and one 168px field — wider than the card before a single dropdown is
 * drawn. Rendering it there would produce a scroller showing one field at a
 * time with its buttons off-screen, which is worse than the pop-up this rework
 * removed rather than better.
 *
 * So the card keeps the same GESTURE (pick a provider in the mark's menu) and
 * relocates the RESULT: the detail panel opens for that action with compose
 * already up in its properties sidebar, which is a real property view with room
 * for the form. Nothing about the compose semantics changes — same fields, same
 * prefill, same overrides — only which panel holds them.
 *
 * WHY AN EVENT rather than a prop. The card's only channel to the panel is
 * `onItemSelect(id, title, event, item)`, threaded through four layers of board
 * (view-board → column → card list → card) and shared with the list view, the
 * calendar and the tab bar. Adding a compose argument to it would put a
 * push-integration concern into the signature every view surface implements.
 * The window bus is what this codebase already uses for exactly this shape of
 * cross-tree request (`dial8:chat-about-proposal`, TASK_DESTINATIONS_CHANGED).
 */

/** Event name. Window-scoped; same tab only, which is all this hand-off spans. */
export const ACTION_COMPOSE_REQUESTED = 'dial8:action-compose-requested'

export interface ActionComposeRequest {
  /** The action to compose a push for. */
  actionId: string
  /** Its title, so the panel can open without waiting for its own fetch. */
  title: string
  /** Which destination the user picked on the card. */
  provider: string
}

/**
 * How long a latched request stays consumable, in milliseconds.
 *
 * Long enough to cover a panel mount that has to round-trip the router and the
 * action fetch; short enough that a request the user abandoned (they picked a
 * provider, the panel never opened, they came back to that action ten minutes
 * later by hand) cannot arm a form they did not ask for on this visit. The
 * window is "one navigation", not "one session".
 */
export const COMPOSE_REQUEST_TTL_MS = 10_000

/**
 * THE MOUNT GAP, and why an event alone cannot cross it.
 *
 * The board card's click has to do two things: open the detail panel, and tell
 * that panel which provider to compose for. Those happen in that order, and the
 * panel's listener is registered in ITS OWN mount effect — which runs after the
 * click that caused the mount. A `dispatchEvent` at click time is therefore
 * delivered to a panel that does not exist yet; the only listeners present are
 * panels for OTHER actions, which correctly ignore it. The click lands nowhere.
 *
 * So the request is also LATCHED here, at module scope, and the panel drains
 * the latch on mount. Two channels, one payload:
 *
 *  - the EVENT serves a panel already mounted for this action (the toolbar is
 *    right there; re-picking a provider must still work without a remount),
 *  - the LATCH serves the panel that mounts because of this very click.
 *
 * Guarded on both id and freshness so a drained-late request cannot arm compose
 * on the wrong action or on a much later visit to the right one.
 */
let pending: { request: ActionComposeRequest; at: number } | null = null

/**
 * Ask whatever owns the action detail panel to open it with compose armed.
 *
 * Fire-and-forget by design: if nothing is listening and nothing mounts (a board
 * rendered outside the dashboard shell) the latch simply expires, which is the
 * same outcome as a panel that cannot open — and strictly better than a card
 * growing a form it cannot show.
 */
export function requestActionCompose(request: ActionComposeRequest): void {
  if (typeof window === 'undefined') return
  pending = { request, at: Date.now() }
  window.dispatchEvent(new CustomEvent(ACTION_COMPOSE_REQUESTED, { detail: request }))
}

/**
 * Take the pending request if it is for `actionId` and still fresh.
 *
 * CONSUMING, not peeking: a request arms compose exactly once. Leaving it in
 * place would re-arm on every remount of the same panel — including the remount
 * that follows a cancel, which would make the form impossible to dismiss.
 *
 * A stale or mismatched entry is left alone rather than cleared: it is not this
 * caller's to discard, and the TTL retires it regardless.
 */
export function consumeActionComposeRequest(actionId: string): ActionComposeRequest | null {
  if (!pending) return null
  if (pending.request.actionId !== actionId) return null
  if (Date.now() - pending.at > COMPOSE_REQUEST_TTL_MS) {
    pending = null
    return null
  }
  const { request } = pending
  pending = null
  return request
}

/**
 * Drop any latched request. For tests, and for a surface that knows the
 * hand-off is moot (the panel closed before it could be drained).
 */
export function clearActionComposeRequest(): void {
  pending = null
}
