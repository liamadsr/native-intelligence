/**
 * One space plan for the panels beside the main chat (Liam, 10-15: "so that
 * they all fit nicely"): each panel asks for a clear band beside the chat's
 * content, and the content moves as little as it can to give it to it
 * (Liam, 10-16: "it doesn't need to push it out of the way if there's enough
 * space for it to come in… the less movement we have in the app, the
 * better").
 *
 *   right  the side panel (side-panels.tsx): its sections or the For you
 *          cards, one view at a time (Liam, 11-11: "move the for you cards
 *          to the right hand side panel… you can't see both at the same
 *          time"). Opened by hand: where it can't make room it floats.
 *   left   the page panel (page-panel/page-panel.tsx), beside the
 *          navigation (Liam, 11-11: "a floating panel next to the
 *          navigation that's going to show you all the recent pages, docs,
 *          chats, or anything else that needs your attention"), opened
 *          and closed by its button right of Search (Liam, 11-11). As the
 *          device remembered it, it never floats over the chat: where the
 *          row has no room for it beside the chat's MIN_CHAT_PX (with the
 *          right panel as planned), it isn't shown at all (`off`). Opened
 *          by hand this session (`leftFloat`), it floats there instead, as
 *          the right panel does: a press always shows something. A page's
 *          sub-nav with its card in front (`leftPinned`) is never off while
 *          it is open: that card draws no navigation of its own from `md`
 *          up (Liam, 11-11: "did you actually clean up the old one and
 *          remove it from the panel complely or did you do something the
 *          lazy way?"), so the sub-nav is the card's one navigation. It
 *          makes room where the row has it, else floats (the card in front
 *          starts after it either way, page-panel.tsx), and it comes before
 *          the right panel: where both can't make room, the right panel
 *          floats (under the full-screen card it isn't painted anyway).
 *
 * The live capture's notepad, docked on the chat's left
 * (live-capture-dock.tsx), moves the content over, and that counts here
 * (`dock`); while it is docked the page panel isn't asked for (the notepad
 * holds the left).
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
 *   float / off     beside the panel the chat would keep less than
 *                   MIN_CHAT_PX (its comfortable width; under its cap the
 *                   column also narrows with the strip, 90% of it): the
 *                   right panel slides over the chat's edge instead, the
 *                   chat untouched (the desktop app's narrowest window,
 *                   938px, floats); the page panel stays out, or floats
 *                   when opened by hand (`leftFloat`).
 *
 * Both panels: each side's need is measured against its own free space, and
 * a shift away from one side never pushes the content into the other panel
 * (the two needs are solved together). The right panel is asked for first
 * (opened by hand), so on a window wide enough for one but not both, it
 * makes room and the page panel stays out; while the right panel floats,
 * the page panel stays out too (the chat would be squeezed from both sides).
 *
 * A side that makes room keeps it until the chat beside it would drop
 * ROOM_HYSTERESIS_PX under MIN_CHAT_PX, and a side not making room needs the
 * full MIN_CHAT_PX to make room again, so a window resized across the line
 * never flips back and forth.
 * Between "no move" and "a shift" there is no line to flip across: the shift
 * grows from zero with the shortfall.
 */
import { dockMode, dockPush } from '../chat/live-capture-dock-store'

/** The right panel's width (Liam, 10-15: the agents rail was "a bit too narrow"); the For you cards fill it too. */
export const RIGHT_PANEL_WIDTH_PX = 360
/** The page panel's width: the For you column's when it stood on the left (its rows read best at 272-296px). */
export const PAGE_PANEL_WIDTH_PX = 296
/** Between a panel and the window's edge. */
export const PANEL_GUTTER_PX = 12
/**
 * How far the top bar's blur reaches below the bar, fading out (dashboard-
 * shell.tsx's DashboardTopBar): the chat scrolls softly under it, and the
 * panel starts below it (Liam, 10-16: it sat "under the blurry section").
 */
export const TOP_BAR_FADE_PX = 24
/** Between the panel and the chat's content, at the least. */
export const PANEL_BREATH_PX = 16
/** The least the chat keeps for itself beside the panel. */
export const MIN_CHAT_PX = 640
/** How far under MIN_CHAT_PX a panel already making room may go before it floats. */
export const ROOM_HYSTERESIS_PX = 16
/** The slide, in and out (motion-reduce: none). */
export const PANEL_SLIDE_MS = 180

/**
 * The minimized card's tile at the bottom left (minimized-card-tile.tsx;
 * Liam, 11-11: "I want it to have a preview of the window not just a tab
 * like a square"): a mini window in the card's 16:10, as wide as the page
 * panel above it at the most (Liam, 11-11: "the width should match the width
 * of the sub-nav panel"), 296×185, its title strip over its bottom edge,
 * PANEL_GUTTER_PX above the window's bottom. Narrower where the composer
 * would be under it (no less than MINIMIZED_TILE_MIN_W_PX), never taller.
 */
export const MINIMIZED_TILE_W_PX = PAGE_PANEL_WIDTH_PX
export const MINIMIZED_TILE_H_PX = Math.round((PAGE_PANEL_WIDTH_PX * 10) / 16)
export const MINIMIZED_TILE_MIN_W_PX = 120
/**
 * The band the tile keeps at the bottom left, the gutter above it included:
 * the page panel always ends above it (page-panel-frame.tsx; Liam, 11-11:
 * "it should have a max size so then it becomes scrollable … never …
 * colliding with the minimized left bottom view"), tile or not, so nothing
 * moves when one appears.
 */
export const MINIMIZED_TILE_BAND_PX = PANEL_GUTTER_PX + MINIMIZED_TILE_H_PX + PANEL_GUTTER_PX

/**
 * The page panel's share of the height it may take, from its top down to
 * the band (or the composer, floating): Liam, 11-11, "the sub-menu goes too
 * long it should stop 20% less" (page-panel-frame.tsx pagePanelBottomCss).
 */
export const PAGE_PANEL_HEIGHT_SHARE = 0.8

/** A panel and its gutter: what it covers from the row's edge. */
export const RIGHT_RESERVE_PX = RIGHT_PANEL_WIDTH_PX + PANEL_GUTTER_PX
export const LEFT_RESERVE_PX = PAGE_PANEL_WIDTH_PX + PANEL_GUTTER_PX

/** The reading column's cap (tailwind.css --chat-reading-max): the content's widest by default. */
export const CHAT_CONTENT_MAX_PX = 634
/** The reading column's share of the strip below its cap (tailwind.css --chat-reading-width). */
export const READING_FRACTION = 0.9

export type PanelMode = 'off' | 'room' | 'float'

export interface SpacePlan {
  right: PanelMode
  /** The page panel: `room` or `off`; `float` only when opened by hand this session (SpaceInput.leftFloat). */
  left: PanelMode
  /** The chat strip's margins, px: what it gives up so its content clears the panels making room (0: no move). */
  insetLeft: number
  insetRight: number
}

export const NO_PANELS: SpacePlan = { right: 'off', left: 'off', insetLeft: 0, insetRight: 0 }

export interface SpaceInput {
  /** The row's width, px (0: not laid out yet). */
  width: number
  /** The right panel is on screen (either view). */
  right: boolean
  /** The page panel has something to show (the page on screen has one, and the notepad doesn't hold the left). */
  left?: boolean
  /** The page panel was opened by hand this session: where it can't make room it floats instead of staying out. */
  leftFloat?: boolean
  /** The page panel is a page's sub-nav with its card in front: never off (room, else float), and before the right panel. */
  leftPinned?: boolean
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
 * gives up for them. Zero width (not laid out yet): a shown right panel
 * floats and the page panel stays out, so nothing jumps before the first
 * measure. A page panel opened by hand (`leftFloat`), or a page's sub-nav
 * with its card in front (`leftPinned`), floats wherever it would otherwise
 * stay out, the plan's insets as they were without it.
 */
export function planSpace(input: SpaceInput): SpacePlan {
  const plan = planRoom(input)
  if (input.left && (input.leftFloat || input.leftPinned) && plan.left === 'off') return { ...plan, left: 'float' }
  return plan
}

function planRoom({ width, right, left = false, leftPinned = false, content = CHAT_CONTENT_MAX_PX, dock = false, was = null }: SpaceInput): SpacePlan {
  if (!right && !left) return NO_PANELS
  const float: SpacePlan = { right: right ? 'float' : 'off', left: 'off', insetLeft: 0, insetRight: 0 }
  if (!(width > 0)) return right ? float : NO_PANELS
  const attempt = (rightRoom: boolean, leftRoom: boolean): SpacePlan | null => {
    // The chat keeps MIN_CHAT_PX beside the panels making room; sides
    // already making room hold it a little longer (the hysteresis).
    const held = (!rightRoom || was?.right === 'room') && (!leftRoom || was?.left === 'room')
    const beside = width - (rightRoom ? RIGHT_RESERVE_PX : 0) - (leftRoom ? LEFT_RESERVE_PX : 0)
    if (beside < (held ? MIN_CHAT_PX - ROOM_HYSTERESIS_PX : MIN_CHAT_PX)) return null
    const insets = fit(width, rightRoom, leftRoom, content, dock)
    if (!insets) return null
    return { right: rightRoom ? 'room' : 'off', left: leftRoom ? 'room' : 'off', ...insets }
  }
  // A page's sub-nav with its card in front first: beside the right panel
  // making room, else alone with the right panel floating (planSpace floats
  // it where even that has no room).
  if (right && left && leftPinned) {
    const alone = attempt(false, true)
    return attempt(true, true) ?? (alone ? { ...alone, right: 'float' } : float)
  }
  // Else the right panel first; the page panel only beside it making room, or alone.
  if (right) return (left ? attempt(true, true) : null) ?? attempt(true, false) ?? float
  return attempt(false, true) ?? NO_PANELS
}

/** How far the plan moves the chat's content, px: + right, − left (half the margins' difference). */
export function contentShift(plan: SpacePlan): number {
  return (plan.insetLeft - plan.insetRight) / 2
}

/** The plan's modes as a string, for a state that changes only when they do. */
export function planKeyOf(plan: SpacePlan): string {
  return `${plan.left}:${plan.right}`
}
