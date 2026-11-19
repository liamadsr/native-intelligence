/**
 * Where the call a member is in sits in the app's window, and what it keeps
 * of the window for itself, so the call, the chat, a page in front, the
 * panels and the composer never cover each other (Liam, 11-18: "the call
 * controls and the chat kind of clash … they shouldn't overlap on top of
 * each other").
 *
 * The call holds an edge of the window, and everything else ends where it
 * begins (the same way the page panel and the composer keep theirs:
 * components/chat-cards/front-card.ts PAGE_PANEL_W_VAR, COMPOSER_RESERVE_VAR):
 *
 *   side   open, on a window wide enough: a column down the window's right,
 *          under the top bar. The shell and a full-screen card's layer end
 *          at its left edge (CALL_DOCK_W_VAR). Toasts keep their corner, in
 *          the column: the call is as tall as what it holds, from the top,
 *          and never reaches the last CALL_TOAST_LANE_PX of the window.
 *   band   minimised: a small bar at the bottom right, in a band the shell,
 *          the card's layer, the minimized card's tile and the toasts end
 *          above (CALL_DOCK_B_VAR, CALL_TOAST_B_VAR).
 *   sheet  open on a narrow window, or opened to fill the window (a shared
 *          screen is read there): the whole window, over everything, until
 *          it is minimised or put back at the side. Nothing of the window is
 *          kept, nothing else shows; toasts stand above its row of controls
 *          (CALL_TOAST_B_VAR).
 *
 * Why a reserve and not a z-index: the app's root is its own stacking layer
 * (it is `position: fixed`, src/app/account/(dashboard)/layout.tsx), and a
 * full-screen card's layer is on <body> above it, so no z-index on the call
 * inside the app could put it over a page; and over a page it would cover
 * the page instead.
 *
 * Client-safe: no server imports.
 */

export type CallPlace = 'side' | 'band' | 'sheet'

/** The call's column at the side: its width, and its gutter to the window's edges (the panels' own, space-plan.ts). */
export const CALL_DOCK_WIDTH_PX = 380
export const CALL_DOCK_GUTTER_PX = 12
/** The minimised bar's height, and the band it keeps: the gutter under it and a breath over it. */
export const CALL_BAR_HEIGHT_PX = 48
export const CALL_BAND_PX = CALL_DOCK_GUTTER_PX + CALL_BAR_HEIGHT_PX + 4
/** Under the column at the side: where a toast stands (the corner toasts always had), so one never covers the call's controls. */
export const CALL_TOAST_LANE_PX = 112
/** The sheet's row of controls (44px buttons, its padding): toasts stand above it. */
export const CALL_SHEET_CONTROLS_PX = 72

/**
 * The narrowest window the column stands beside: the app rail (60px), the
 * chat's comfortable width (space-plan.ts MIN_CHAT_PX, 640) and the column
 * with its gutter (392), rounded up. Narrower, an open call is the sheet.
 */
export const CALL_DOCK_MIN_WINDOW_PX = 1100
export const CALL_WIDE_QUERY = `(min-width: ${CALL_DOCK_MIN_WINDOW_PX}px)`

/** On <html> while a call's panel is on screen: what it keeps of the window's right and bottom, px. */
export const CALL_DOCK_W_VAR = '--call-dock-w'
export const CALL_DOCK_B_VAR = '--call-dock-b'
/** On <html> while a call's panel is on screen: how far above the window's bottom the toasts start, px (dashboard-shell.tsx). */
export const CALL_TOAST_B_VAR = '--call-toast-b'
/** On <html> while a call's panel is on screen: its place. */
export const CALL_PLACE_ATTR = 'data-call-place'
/** On <html> while the call is the column at the side: a page in front gives up its wide side padding (show-tool-card.tsx). */
export const CALL_DOCK_ATTR = 'data-call-dock'

export function callPlace({ wide, minimized, full }: { wide: boolean; minimized: boolean; full: boolean }): CallPlace {
  if (minimized) return 'band'
  return wide && !full ? 'side' : 'sheet'
}

/** What a place keeps of the window, px from its right and bottom edges. */
export function callReserve(place: CallPlace): { right: number; bottom: number } {
  if (place === 'side') return { right: CALL_DOCK_WIDTH_PX + CALL_DOCK_GUTTER_PX, bottom: 0 }
  if (place === 'band') return { right: 0, bottom: CALL_BAND_PX }
  return { right: 0, bottom: 0 }
}

/** How far the toasts move up for a place, px. */
export function callToastLift(place: CallPlace): number {
  if (place === 'band') return CALL_BAND_PX
  if (place === 'sheet') return CALL_SHEET_CONTROLS_PX
  return 0
}

/** Say on <html> what the call keeps (null: no call on screen, nothing kept). */
export function writeCallPlace(place: CallPlace | null): void {
  if (typeof document === 'undefined') return
  const html = document.documentElement
  if (!place) {
    html.style.removeProperty(CALL_DOCK_W_VAR)
    html.style.removeProperty(CALL_DOCK_B_VAR)
    html.style.removeProperty(CALL_TOAST_B_VAR)
    html.removeAttribute(CALL_PLACE_ATTR)
    html.removeAttribute(CALL_DOCK_ATTR)
    return
  }
  const { right, bottom } = callReserve(place)
  html.style.setProperty(CALL_DOCK_W_VAR, `${right}px`)
  html.style.setProperty(CALL_DOCK_B_VAR, `${bottom}px`)
  html.style.setProperty(CALL_TOAST_B_VAR, `${callToastLift(place)}px`)
  html.setAttribute(CALL_PLACE_ATTR, place)
  if (place === 'side') html.setAttribute(CALL_DOCK_ATTR, '')
  else html.removeAttribute(CALL_DOCK_ATTR)
}
