/**
 * The live capture's notepad (live-capture-dock.tsx): its sizes, and how it
 * sits beside the main chat.
 *
 * While a capture records (or records and is paused), its card docks on the
 * LEFT of the main chat (there is one chat: docs/plans/one-chat.md).
 *
 * Client-safe and pure.
 */

/** The notepad's width (px): a side panel, not a page (Liam, 10-09: 380 plus 20%). */
export const DOCK_WIDTH_PX = 456

/** Its margin from the chat area's left edge (px). */
export const DOCK_GUTTER_PX = 12

/** What the dock takes from the chat's left when it pushes the chat over. */
export const DOCK_RESERVED_PX = DOCK_GUTTER_PX + DOCK_WIDTH_PX

/**
 * The narrowest the chat may get beside the dock (px). Narrower, the dock lies
 * over the chat instead of pushing it (still put away with Hide).
 */
export const MIN_CHAT_WIDTH_BESIDE_DOCK = 640

/** The reading column at its widest (tailwind.css --chat-reading-max). */
export const CHAT_COLUMN_MAX_PX = 634

/** The space kept between the card and the chat's reading column (px; Liam, 10-09: 24, then 40, were still tight). */
export const DOCK_CHAT_GAP_PX = 64

/**
 * How far a pushing dock moves the chat area right, in a row `width` px wide:
 * only as far as keeps the centred reading column DOCK_CHAT_GAP_PX clear of the
 * card (Liam, 10-09: "too much space between the chat and the capture"), never
 * more than the card takes, and not at all where the column already clears it.
 * The chat stays wide.
 */
export function dockPush(width: number): number {
  const needed = 2 * (DOCK_RESERVED_PX + DOCK_CHAT_GAP_PX) + CHAT_COLUMN_MAX_PX - width
  return Math.max(0, Math.min(DOCK_RESERVED_PX, Math.ceil(needed)))
}

/**
 * The composer's height at the chat's bottom (rem), which the centred card's
 * bottom stays above on a short window.
 */
export const DOCK_COMPOSER_CLEARANCE_REM = 11

/** The slide in and out (ms): ease-out, none under prefers-reduced-motion. */
export const DOCK_SLIDE_MS = 220

/** How the dock sits beside a chat area `width` px wide: pushing it over, or over it. */
export function dockMode(width: number): 'push' | 'overlay' {
  return width - DOCK_RESERVED_PX >= MIN_CHAT_WIDTH_BESIDE_DOCK ? 'push' : 'overlay'
}

/** The dock's width in a chat area `width` px wide: its own, or what an overlay leaves room for. */
export function dockWidth(width: number): number {
  if (width <= 0) return DOCK_WIDTH_PX
  return Math.max(0, Math.min(DOCK_WIDTH_PX, width - 2 * DOCK_GUTTER_PX))
}

/** The recording state the dock reads (the stable recording subset's fields). */
export interface RecordingFlags {
  captureId: string | null
  isRecording: boolean
  isStarting: boolean
  isPaused: boolean
}

/** The capture that is active now (recording, starting, or paused), or null. */
export interface ActiveLiveCapture {
  captureId: string
  paused: boolean
}

/**
 * Is a capture active? Recording or paused (isRecording stays true while
 * paused), or in its optimistic start (the card opens before the mic is
 * live). A stop's async tail still holds the capture id with isRecording
 * false: the capture has ended for the person, so the dock goes at once.
 */
export function activeLiveCapture(rec: RecordingFlags | null | undefined): ActiveLiveCapture | null {
  if (!rec?.captureId) return null
  if (!rec.isRecording && !rec.isStarting) return null
  return { captureId: rec.captureId, paused: rec.isRecording && rec.isPaused }
}
