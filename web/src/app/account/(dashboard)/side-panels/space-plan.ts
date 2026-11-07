/**
 * One space plan for the panels around the main chat (Liam, 10-15: "so that
 * they all fit nicely"): the right panel and the For you column each ask for
 * a clear band beside the chat's content, and the content moves as little as
 * it can to give it to them (Liam, 10-16: "it doesn't need to push it out of
 * the way if there's enough space for it to come in… the less movement we
 * have in the app, the better").
 *
 * What a panel must clear is the chat's CONTENT, not the chat strip: the
 * conversation, the composer and the cards inline in the chat all sit in the
 * one centred reading column (tailwind.css `.chat-reading-col`,
 * `min(90% of the strip, --chat-reading-max)`; a card is 125% of its 80%
 * message, the column's full width), so on a wide window there is empty
 * space beside it. Per side, the panel needs its width, its gutter to the
 * window's edge and PANEL_BREATH_PX between it and the content:
 *
 *   room, no move   the free space beside the content already holds it: the
 *                   panel slides into it and the chat does not move at all.
 *   room, a shift   short by S: the content moves away by exactly S. The
 *                   strip gives up 2·S on the panel's side (its margin), so
 *                   the centred column moves S; never the panel's full width.
 *                   Set once per plan change or resize, never animated.
 *   float           beside the panel the chat would keep less than
 *                   MIN_CHAT_PX (its comfortable width; under its cap the
 *                   column also narrows with the strip, 90% of it): the panel
 *                   slides over the chat's edge instead, the chat untouched.
 *                   The desktop app's narrowest window (938px) floats.
 *
 * Both panels: each side's need is measured against its own free space, and
 * a shift away from one side never pushes the content into the other panel
 * (the two needs are solved together). The right panel is asked for first
 * (it is the one opened by hand most), so on a window wide enough for one but
 * not both, it makes room and For you floats; For you makes room alone only
 * where the right panel is closed or cannot.
 *
 * A side that makes room keeps it until the chat beside it would drop
 * ROOM_HYSTERESIS_PX under MIN_CHAT_PX, and a floating side needs the full
 * MIN_CHAT_PX to make room again, so a window resized across the line never
 * flips back and forth.
 * Between "no move" and "a shift" there is no line to flip across: the shift
 * grows from zero with the shortfall.
 */
import { dockMode, dockPush } from '../chat/live-capture-dock-store'

/** The right panel's width (Liam, 10-15: the agents rail was "a bit too narrow"). */
export const RIGHT_PANEL_WIDTH_PX = 360
/** The For you column's width: its cards read best at 272-296px. */
export const FOR_YOU_WIDTH_PX = 296
/** Between a panel and the window's edge. */
export const PANEL_GUTTER_PX = 12
/**
 * How far the top bar's blur reaches below the bar, fading out (dashboard-
 * shell.tsx's DashboardTopBar): the chat scrolls softly under it, and the
 * panels start below it (Liam, 10-16: they sat "under the blurry section").
 */
export const TOP_BAR_FADE_PX = 24
/** Between a panel and the chat's content, at the least. */
export const PANEL_BREATH_PX = 16
/** The least the chat keeps for itself beside the panels. */
export const MIN_CHAT_PX = 640
/** How far under MIN_CHAT_PX a side already making room may go before it floats. */
export const ROOM_HYSTERESIS_PX = 16
/** The slide, in and out (motion-reduce: none). */
export const PANEL_SLIDE_MS = 180

/** A panel and its gutter: what it covers from the window's edge. */
export const RIGHT_RESERVE_PX = RIGHT_PANEL_WIDTH_PX + PANEL_GUTTER_PX
export const LEFT_RESERVE_PX = FOR_YOU_WIDTH_PX + PANEL_GUTTER_PX

/** The reading column's cap (tailwind.css --chat-reading-max): the content's widest by default. */
export const CHAT_CONTENT_MAX_PX = 634
/** The reading column's share of the strip below its cap (tailwind.css --chat-reading-width). */
export const READING_FRACTION = 0.9

export type PanelMode = 'off' | 'room' | 'float'

export interface SpacePlan {
  right: PanelMode
  left: PanelMode
  /** The chat strip's margins, px: what it gives up so its content clears the panels making room (0: no move). */
  insetLeft: number
  insetRight: number
}

export const NO_PANELS: SpacePlan = { right: 'off', left: 'off', insetLeft: 0, insetRight: 0 }

export interface SpaceInput {
  /** The row's width, px (0: not laid out yet). */
  width: number
  /** The right panel is on screen. */
  right: boolean
  /** The For you column is on screen (open, with something to show). */
  left: boolean
  /** The chat's widest content at its cap, px (the reading column, or a wider card in it). */
  content?: number
  /** The live capture's notepad is docked on the strip's left (live-capture-dock.tsx). */
  dock?: boolean
  /** The plan in force now, for the hysteresis. */
  was?: SpacePlan | null
}

const EPSILON = 1e-6

/** Where the content's edges sit from the strip's left, in a strip this wide. */
function spanOf(strip: number, content: number, dock: boolean): { lo: number; hi: number } {
  // The notepad moves the chat area over by its push (dockPush), the same sums it does.
  const push = dock && dockMode(strip) === 'push' ? dockPush(strip) : 0
  const area = strip - push
  const width = Math.min(READING_FRACTION * area, content)
  const mid = push + area / 2
  return { lo: mid - width / 2, hi: mid + width / 2 }
}

/**
 * The strip's margins that keep the content clear of the sides making room,
 * moving it least: the widest strip whose content fits between them (each
 * side's clearance measured on its own; the narrower the strip, the less of
 * it a centred column takes), placed as near the content's own place as that
 * fit allows. One side short: that side's margin alone, twice the shortfall,
 * so the centred column moves just the shortfall. Null where nothing fits.
 */
function fit(width: number, rightRoom: boolean, leftRoom: boolean, content: number, dock: boolean) {
  const a = leftRoom ? LEFT_RESERVE_PX + PANEL_BREATH_PX : -Infinity
  const b = rightRoom ? width - RIGHT_RESERVE_PX - PANEL_BREATH_PX : Infinity
  // Where the strip's left margin may be for a strip this wide, in whole
  // pixels, or null where none clears both.
  const margins = (strip: number): [number, number] | null => {
    const at0 = spanOf(strip, content, dock)
    const lo = Math.max(0, Math.ceil(a - at0.lo - EPSILON))
    const hi = Math.min(width - strip, Math.floor(b - at0.hi + EPSILON))
    return lo <= hi ? [lo, hi] : null
  }
  let strip = width
  if (!margins(width)) {
    if (!margins(0)) return null
    // The widest strip that fits (a narrower one always fits too).
    let fits = 0
    let fails = width
    while (fails - fits > 1) {
      const mid = (fits + fails) >> 1
      if (margins(mid)) fits = mid
      else fails = mid
    }
    strip = fits
  }
  const [lo, hi] = margins(strip)!
  // As near the content's own place (no panels) as it can stay.
  const own = spanOf(width, content, dock)
  const at0 = spanOf(strip, content, dock)
  const left = Math.min(hi, Math.max(lo, Math.round((own.lo + own.hi - at0.lo - at0.hi) / 2)))
  return { insetLeft: left, insetRight: width - strip - left }
}

/**
 * Where each panel goes in a row `width` px wide, and what the chat strip
 * gives up for them. Zero width (not laid out yet): every shown panel
 * floats, so nothing jumps before the first measure.
 */
export function planSpace({ width, right, left, content = CHAT_CONTENT_MAX_PX, dock = false, was = null }: SpaceInput): SpacePlan {
  if (!right && !left) return NO_PANELS
  const floatAll: SpacePlan = { right: right ? 'float' : 'off', left: left ? 'float' : 'off', insetLeft: 0, insetRight: 0 }
  if (!(width > 0)) return floatAll
  const attempt = (rightRoom: boolean, leftRoom: boolean): SpacePlan | null => {
    // The chat keeps MIN_CHAT_PX beside the panels making room; sides
    // already making room hold it a little longer (the hysteresis).
    const held = (!rightRoom || was?.right === 'room') && (!leftRoom || was?.left === 'room')
    const beside = width - (rightRoom ? RIGHT_RESERVE_PX : 0) - (leftRoom ? LEFT_RESERVE_PX : 0)
    if (beside < (held ? MIN_CHAT_PX - ROOM_HYSTERESIS_PX : MIN_CHAT_PX)) return null
    const insets = fit(width, rightRoom, leftRoom, content, dock)
    if (!insets) return null
    return { right: right ? (rightRoom ? 'room' : 'float') : 'off', left: left ? (leftRoom ? 'room' : 'float') : 'off', ...insets }
  }
  return (
    (right && left ? attempt(true, true) : null) ??
    (right ? attempt(true, false) : null) ??
    (left ? attempt(false, true) : null) ??
    floatAll
  )
}

/** How far the plan moves the chat's content, px: + right, − left (half the margins' difference). */
export function contentShift(plan: SpacePlan): number {
  return (plan.insetLeft - plan.insetRight) / 2
}

/** The plan's modes as a string, for a state that changes only when they do. */
export function planKeyOf(plan: SpacePlan): string {
  return `${plan.left}:${plan.right}`
}
