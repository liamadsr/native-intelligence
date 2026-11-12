/**
 * A full-screen card minimizing into its tile at the bottom left, and growing
 * back out of it (components/chat-cards/minimized-card.ts; Liam, 11-11:
 * "minimize and animate that same way and go to the bottom left … click on it
 * again and bring it back into the view").
 *
 * One sequence each way, the window solid and the same window at every frame
 * (Liam, 11-11: "it lands at the bottom square then the borders get around";
 * then "it's not a fliker now but the panel is transparent and you see
 * thorugh it and looks broken, the over all transition even with the sub-nav
 * needs to be updated to be smoother the entire open sequence needs to happen
 * smoother"). What moves with the window (the chat and the page panel
 * changing hands) is components/chat-cards/flight-scene.ts; this is the
 * window.
 *
 *   Pace     the ⌘K palette's curve (lib/motion/palette-entrance.ts
 *            PALETTE_ENTRANCE_EASING) over MINIMIZE_FLIGHT_MS: one easing over
 *            the whole path, fast out and a long soft landing, no squash or
 *            spring after it (Liam, 11-11: "match the speed and motion to the
 *            search panel cmd+k panel"; at its 160ms it was "so fast that it
 *            feels glitch").
 *   Path     around the page panel (the sub-nav, `[data-page-panel]`): the
 *            window drops in its own column, right of the panel, shrinking as
 *            it goes, until its top is below the panel's bottom, rounds a soft
 *            corner and runs left into the tile (tilePathPoint; the corner
 *            worked out from the live rects as it starts: tileCorner). A
 *            restore is the same path backwards: out of the tile along the
 *            bottom, then up into place.
 *   Under    it never draws over what stays on screen beside it: the flyer is
 *            clipped round the page panel's column and the main composer's
 *            box (obstacleClip), so it passes behind them, never see-through
 *            over them (its glass is the window's own).
 *   Window   one still copy of the frame (card-reply-flight.ts stillCopyOf;
 *            the tile's preview, cloned: flightCopyOf), its glass the
 *            window's own glass all the way: what an open card sits on is
 *            the app's bare backdrop, and so does the tile, so over that it
 *            is the same surface at the frame, on the way and in the tile.
 *            Never over the chat: flight-scene.ts has it gone before the
 *            window is over it.
 *   Outline  it leaves looking exactly like the frame and lands looking
 *            exactly like the tile, and the other way round, with nothing
 *            popping in after: the copy's clip (tileClipFrames) goes from the
 *            frame's box and corners to the box inside the tile's border,
 *            where the tile draws its preview; the tile's own edge and shadow
 *            ride with it (tileRingFrames: a border box that follows the clip,
 *            1px and the tile's radius on screen at every step, fading in
 *            toward the tile), and the frame's shadow and ring ride the other
 *            way (a box of the frame's size, fading out toward the tile).
 *   Cheap    the move is one transform on the compositor, whatever the main
 *            thread does, and the fades are opacity. The outline (a clip-path
 *            and the edge's box: main thread in Chrome, measured 148) is in
 *            the window's own coordinates under that transform, and is done
 *            by the hand-over (outlineProgress: it follows the window to
 *            there, then holds its last shape, which the transform alone
 *            carries the last few px), so the shell's render, the one busy
 *            stretch of the main thread, falls where nothing of the flight
 *            is the main thread's. Keyframes worked out once, at the start;
 *            nothing per frame in script; promoted only while it flies.
 *   Hand-over the rest of the app changes hands DURING the landing, not after
 *            it: at TILE_HANDOFF_MS the card leaves full screen (a minimize)
 *            or enters it (a restore), so the shell's render (the chat row,
 *            the page panel's swap, the page mounting; ~150ms in development)
 *            falls in the flight's long soft tail, where the window is within
 *            a few px of its place and the outline hardly changes, and the
 *            page's sub-nav (or home's panel and the chat) arrive as the
 *            window lands instead of a beat after it.
 *   Land     in one frame: minimize, the flyer goes and the tile (the same
 *            picture, glass, box, corners, edge and shadow) is there;
 *            restore, the tile goes in the frame the copy appears on it, and
 *            the frame (mounted under the copy since the hand-over, hidden)
 *            shows in the frame the copy goes (landTileFlight).
 *
 * One tile flight at a time: a new one ends the one in the air. Nothing
 * without the Web Animations API (jsdom) or under reduced motion: the tile
 * and the page just appear.
 *
 * Client-safe: no server imports.
 */
import { PALETTE_ENTRANCE_EASING } from '@/lib/motion/palette-entrance'
import { applyCopyScroll, canFly, coverScale, cubicBezier, rectOf, reversedFrames, FLIGHT_GLASS_CLASS, type FlightRect, type StillCopy } from './card-reply-flight'

/**
 * The trip, ms: the ⌘K palette's curve over a travel long enough to see
 * (Liam, 11-11: at the palette's own 160ms it was "so fast that it feels
 * glitch and you don't really see the animation"), about the search
 * button's own flight (SEARCH_FLIGHT_MS, 380).
 */
export const MINIMIZE_FLIGHT_MS = 400
/** Its one easing over the whole path: the ⌘K palette's fast out, long soft landing (Liam, 11-11: "match the speed and motion to the search panel cmd+k panel"). */
export const TILE_FLIGHT_EASING = PALETTE_ENTRANCE_EASING
/**
 * When the card itself changes hands, ms into the flight (out of full screen
 * on a minimize, into it on a restore): half way in time, where the palette's
 * curve has the window 97% of the way there, so the shell's render lands in
 * the soft tail and what it brings (the sub-nav, the chat) arrives with the
 * window (Liam, 11-11: "the entire open sequence needs to happen smoother").
 */
export const TILE_HANDOFF_MS = MINIMIZE_FLIGHT_MS / 2
/** Keyframes along the path, evenly by length. */
const TILE_FLIGHT_STEPS = 40
/** The outline's keyframes, evenly by time up to the hand-over. */
const OUTLINE_STEPS = 24
/** The corner's radius at most: this share of the shorter leg. */
const CORNER_SHARE = 0.6
/** Over the full-screen layer (z-50), under the tile (z-52) and the other flights. */
const TILE_FLIGHT_Z = 51
/** How long a copy that reached its place waits for what lands it (a page that never opened), ms. */
const LAND_WAIT_MS = 1200
/** How long a frame put away by a flight that ended stays hidden before it is shown again (it was still there: not put away after all), ms. */
const FRAME_KEPT_MS = 800

/** A box on screen by its edges (the page panel's column). */
export interface FlightObstacle {
  left: number
  top: number
  right: number
  bottom: number
}

type Point = { x: number; y: number }

/**
 * A tile flight's keyframe: transform only. No opacity in it: a second
 * effect on opacity (the handover's fade) next to one here would put both on
 * the main thread in Chrome, where the shell's render freezes them.
 */
export type TileFrame = { offset: number; transform: string }

/**
 * The radius of the path's corner (tilePathPoint) from `from` (the frame's
 * top-left) to `to` (the tile's): a soft share of the shorter leg, and, with
 * the page panel in the way (above and right of the tile), no more than
 * keeps the turn clear of it: below its bottom all the way (the run along
 * the bottom is at the tile's top), or right of its right edge all the way
 * (the drop is at the frame's left). Pure, for the tests.
 */
export function tileCorner(from: Point, to: Point, panel: FlightObstacle | null): number {
  let r = Math.min(Math.abs(to.y - from.y), Math.abs(to.x - from.x)) * CORNER_SHARE
  if (panel && to.x < from.x && to.y > from.y) {
    const room = Math.max(to.y - panel.bottom, from.x - panel.right)
    if (room > 0) r = Math.min(r, room)
  }
  return Math.max(0, r)
}

/**
 * The top-left at `q` of the way (0 to 1, by length) from `from` to `to`:
 * straight down (or up) from `from`, a quarter circle of radius `r`, then
 * straight across into `to`, arriving level. Pure, for the tests.
 */
export function tilePathPoint(from: Point, to: Point, r: number, q: number): Point {
  const dx = Math.sign(to.x - from.x)
  const dy = Math.sign(to.y - from.y)
  const down = Math.abs(to.y - from.y)
  const across = Math.abs(to.x - from.x)
  const radius = Math.min(r, down, across)
  const leg1 = down - radius
  const arc = (Math.PI * radius) / 2
  const total = leg1 + arc + (across - radius)
  if (total <= 0) return { ...from }
  let s = Math.min(1, Math.max(0, q)) * total
  if (s <= leg1) return { x: from.x, y: from.y + dy * s }
  s -= leg1
  if (radius > 0 && s <= arc) {
    const a = s / radius
    return { x: from.x + dx * radius * (1 - Math.cos(a)), y: to.y - dy * radius + dy * radius * Math.sin(a) }
  }
  s -= arc
  return { x: from.x + dx * (radius + s), y: to.y }
}

const round = (n: number, places: number) => {
  const f = 10 ** places
  return Math.round(n * f) / f
}

/**
 * The minimize's keyframes: the frame's copy (`frame`: where it stood, its
 * size at scale 1) from where it stood to the preview's rectangle in `tile`
 * (scaled to cover the tile, centred across, cut at the foot: coverTransform),
 * along tilePathPoint with the corner tileCorner gives, its scale following
 * the way. Evenly by length: the animation's one easing (TILE_FLIGHT_EASING)
 * paces it. A restore plays them backwards (reversedFrames). Transform only.
 * Pure, for the tests.
 */
export function tileFlightFrames(frame: FlightRect, tile: FlightRect, panel: FlightObstacle | null, steps = TILE_FLIGHT_STEPS): TileFrame[] {
  const end = coverScale(frame.width, frame.height, tile.width, tile.height)
  const from = { x: frame.left, y: frame.top }
  const to = { x: tile.left + (tile.width - frame.width * end) / 2, y: tile.top }
  const r = tileCorner(from, to, panel)
  const frames: TileFrame[] = []
  for (let i = 0; i <= steps; i++) {
    const q = i / steps
    const { x, y } = tilePathPoint(from, to, r, q)
    frames.push({ offset: round(q, 4), transform: `translate(${round(x, 2)}px, ${round(y, 2)}px) scale(${round(1 + (end - 1) * q, 5)})` })
  }
  return frames
}

/**
 * The outline's keyframes' places: `at` a count, that many even steps of the
 * way (0 the frame, 1 the tile), each its own offset; or the way at each of
 * a list of even moments (outlineProgress), offsets evenly through them.
 */
function waypoints(at: number | readonly number[]): Array<[offset: number, q: number]> {
  if (typeof at === 'number') return Array.from({ length: at + 1 }, (_, i) => [round(i / at, 4), i / at])
  const last = Math.max(1, at.length - 1)
  return at.map((q, i) => [round(i / last, 4), Math.min(1, Math.max(0, q))])
}

/**
 * How far the outline has come at even moments from the start of a flight to
 * its hand-over (TILE_HANDOFF_MS), 0 to 1: where the window itself is on its
 * curve at each moment (TILE_FLIGHT_EASING over MINIMIZE_FLIGHT_MS), over
 * where it is at the hand-over, so the outline keeps step with the window
 * and is DONE as the card changes hands: the shell's render then (the main
 * thread busy, ~150ms in development) cannot hold the outline 4px short of
 * the tile and let it jump there after (measured), and the window's last
 * few px are the transform's alone, the outline's last shape riding it.
 * Played linear over TILE_HANDOFF_MS. Pure, for the tests.
 */
export function outlineProgress(steps = OUTLINE_STEPS): number[] {
  const [x1, y1, x2, y2] = (/cubic-bezier\(([^)]+)\)/.exec(TILE_FLIGHT_EASING)?.[1] ?? '0.16, 1, 0.3, 1').split(',').map(Number)
  const ease = cubicBezier(x1, y1, x2, y2)
  const share = TILE_HANDOFF_MS / MINIMIZE_FLIGHT_MS
  const whole = ease(share) || 1
  return Array.from({ length: steps + 1 }, (_, i) => (i === steps ? 1 : Math.min(1, ease((i / steps) * share) / whole)))
}

/**
 * The copy's outline on screen along the way, as clip-path keyframes in its
 * own (unscaled) box, at the same offsets as tileFlightFrames: from the
 * frame's box with its corners to the tile's box with its own, so the copy
 * leaves looking exactly like the frame and lands looking exactly like the
 * tile (Liam, 11-11: "it lands at the bottom square then the borders get
 * around"). The box on screen goes from the frame's size to the tile's along
 * the way; the corners are each one's radius on screen at every step (over
 * the scale in the copy's box); the cut is at the foot and evenly at the
 * sides, as the preview's cover fit. Pure, for the tests.
 */
export function tileClipFrames(frame: FlightRect, tile: FlightRect, radii: { frame: number; tile: number }, at: number | readonly number[] = TILE_FLIGHT_STEPS): Array<{ offset: number; clipPath: string }> {
  const end = coverScale(frame.width, frame.height, tile.width, tile.height)
  const frames: Array<{ offset: number; clipPath: string }> = []
  for (const [offset, q] of waypoints(at)) {
    const s = 1 + (end - 1) * q
    // The box on screen, then in the copy's own units.
    const w = (frame.width + (tile.width - frame.width) * q) / s
    const h = (frame.height + (tile.height - frame.height) * q) / s
    const side = Math.max(0, (frame.width - w) / 2)
    const foot = Math.max(0, frame.height - h)
    const r = (radii.frame + (radii.tile - radii.frame) * q) / s
    frames.push({ offset, clipPath: `inset(0px ${round(side, 2)}px ${round(foot, 2)}px ${round(side, 2)}px round ${round(r, 2)}px)` })
  }
  return frames
}

/**
 * The tile's own edge along the way, as keyframes of a border box in the
 * copy's own (unscaled) units, at the same offsets as tileClipFrames: round
 * the copy's clip, `edge.width` thick and `edge.radius` round ON SCREEN at
 * every step (each over the scale), so at the tile it is exactly the tile's
 * border, round the box the tile draws its preview in (Liam, 11-11: "it
 * lands at the bottom square then the borders get around"). Its box only:
 * its colour, shadow and fade are the flyer's (tileEdge). Pure, for the
 * tests.
 */
export type RingFrame = { offset: number; left: string; top: string; width: string; height: string; borderWidth: string; borderRadius: string }
export function tileRingFrames(frame: FlightRect, tile: FlightRect, edge: { width: number; radius: number }, at: number | readonly number[] = TILE_FLIGHT_STEPS): RingFrame[] {
  const end = coverScale(frame.width, frame.height, tile.width, tile.height)
  const px = (n: number) => `${round(n, 2)}px`
  const frames: RingFrame[] = []
  for (const [offset, q] of waypoints(at)) {
    const s = 1 + (end - 1) * q
    // The clip's box in the copy's units (tileClipFrames), and the edge round it.
    const w = (frame.width + (tile.width - frame.width) * q) / s
    const h = (frame.height + (tile.height - frame.height) * q) / s
    const side = Math.max(0, (frame.width - w) / 2)
    const foot = Math.max(0, frame.height - h)
    const b = edge.width / s
    frames.push({
      offset,
      left: px(side - b),
      top: px(-b),
      width: px(frame.width - 2 * side + 2 * b),
      height: px(frame.height - foot + 2 * b),
      borderWidth: px(b),
      borderRadius: px(edge.radius / s),
    })
  }
  return frames
}

/** A box-shadow with every length times `k` (the tile's shadow in the copy's units: its size on screen over the scale). */
export function scaledShadow(shadow: string, k: number): string {
  if (!shadow || shadow === 'none') return 'none'
  return shadow.replace(/(-?\d*\.?\d+)px/g, (_, n: string) => `${round(Number(n) * k, 2)}px`)
}

/**
 * Everything but `holes`, for the flyer's clip-path (in the window's
 * coordinates: the flyer covers it from its top-left), so a copy passing the
 * page panel or the composer goes behind them, never over them. One closed
 * path: out to each hole and back to the outer corner, so the way there
 * encloses nothing. None: no clip. Pure, for the tests.
 */
export function obstacleClip(holes: readonly FlightObstacle[]): string {
  if (!holes.length) return 'none'
  const far = 100000
  const r = (n: number) => `${round(n, 2)}px`
  const start = `${-far}px ${-far}px`
  const points = [start, `${far}px ${-far}px`, `${far}px ${far}px`, `${-far}px ${far}px`, start]
  for (const o of holes) points.push(`${r(o.left)} ${r(o.top)}`, `${r(o.right)} ${r(o.top)}`, `${r(o.right)} ${r(o.bottom)}`, `${r(o.left)} ${r(o.bottom)}`, `${r(o.left)} ${r(o.top)}`, start)
  return `polygon(evenodd, ${points.join(', ')})`
}

/** Everything but `o` (obstacleClip of the one). */
export function panelClip(o: FlightObstacle): string {
  return obstacleClip([o])
}

function boxOf(el: Element | null): FlightObstacle | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden') return null
  return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height }
}

/**
 * The page panel on screen (the sub-nav beside the rail), or null when there
 * is none to go round: its whole column (`[data-page-panel]`, down to its
 * capped bottom), not just its card, since a minimize swaps in Home's panel,
 * often taller, while the copy flies.
 */
export function pagePanelObstacle(): FlightObstacle | null {
  if (typeof document === 'undefined') return null
  return boxOf(document.querySelector('[data-page-panel]:not([data-page-panel-mode="off"])'))
}

/**
 * The main chat's composer box on screen, or null: it stays under an open
 * card (chat-panel.tsx `data-chat-composer`: the bottom zone; the box is its
 * reading column inside that column's padding), and the window's way to the
 * tile crosses it.
 */
export function composerObstacle(): FlightObstacle | null {
  if (typeof document === 'undefined') return null
  const col = document.querySelector<HTMLElement>('[data-chat-composer]:not([hidden]) > .chat-reading-col')
  const box = boxOf(col)
  if (!col || !box) return null
  const cs = getComputedStyle(col)
  const pad = (v: string) => parseFloat(v) || 0
  const inner = { left: box.left + pad(cs.paddingLeft), top: box.top + pad(cs.paddingTop), right: box.right - pad(cs.paddingRight), bottom: box.bottom - pad(cs.paddingBottom) }
  return inner.right - inner.left > 1 && inner.bottom - inner.top > 1 ? inner : null
}

function overlaps(o: FlightObstacle, r: FlightRect): boolean {
  return o.left < r.left + r.width && o.right > r.left && o.top < r.top + r.height && o.bottom > r.top
}

/** A copy ready to fly: the frame's still copy at scale 1, and where it stood. */
export interface TileSnapshot {
  copy: HTMLElement
  rect: FlightRect
}

/**
 * The flight's copy of a still copy (the tile's preview): a clone of what is
 * already stripped (no second walk over the page), its glass the window's
 * glass again (in the tile the tile's skin is that glass), placed from its
 * top-left. Not under reduced motion or without the API.
 */
export function flightCopyOf(still: StillCopy | null): TileSnapshot | null {
  if (!still || !canFly()) return null
  const copy = still.copy.cloneNode(true) as HTMLElement
  for (const glass of copy.querySelectorAll<HTMLElement>(`.${FLIGHT_GLASS_CLASS}`)) {
    glass.style.removeProperty('background')
    glass.style.removeProperty('backdrop-filter')
  }
  // A layer of its own while it flies: its clip is then a mask over it, never a repaint of it.
  Object.assign(copy.style, { position: 'absolute', left: '0', top: '0', transformOrigin: '0 0', transform: 'none', opacity: '1', willChange: 'transform', pointerEvents: 'none' })
  return { copy, rect: { left: still.left, top: still.top, width: still.width, height: still.height } }
}

/**
 * The tile's end of a flight: its box on screen (border box) and the edge it
 * wears there, read off the tile, or its slot, which wears the same
 * (minimized-card-tile.tsx TILE_LOOK), as the flight starts.
 */
export interface TileEnd {
  rect: FlightRect
  /** Its border, px. */
  border: number
  /** Its corner radius, px (the border box's). */
  radius: number
  /** Its border's colour. */
  edge: string
  /** Its box-shadow, as computed. */
  shadow: string
}

export function tileEndOf(el: HTMLElement | null): TileEnd | null {
  const rect = el ? rectOf(el) : null
  if (!el || !rect) return null
  const cs = getComputedStyle(el)
  return { rect, border: parseFloat(cs.borderTopWidth) || 0, radius: parseFloat(cs.borderTopLeftRadius) || 0, edge: cs.borderTopColor || 'transparent', shadow: cs.boxShadow || 'none' }
}

/** The box inside the tile's border: where it draws its preview (TilePreview: `absolute inset-0`), so where the copy lands. */
export function tileInnerBox(end: TileEnd): FlightRect {
  const b = Math.min(end.border, end.rect.width / 2, end.rect.height / 2)
  return { left: end.rect.left + b, top: end.rect.top + b, width: end.rect.width - 2 * b, height: end.rect.height - 2 * b }
}

/**
 * Hide `home` (the tile) at once, with no opacity transition of its own (its
 * class fade is for fading away while a card opens; its other transitions, a
 * hover's lift, carry on), until the returned reveal: shown again in that
 * same frame, still with none (its style worked out before its own
 * transitions are given back), whole: the copy it takes over from wears its
 * picture, glass, box, corners, edge and shadow already, so nothing comes in
 * after (Liam, 11-11: "it like flikers when it goes to the bottom left", "it
 * lands at the bottom square then the borders get around").
 */
function hideHome(home: HTMLElement): () => void {
  const property = home.style.transitionProperty
  const others = getComputedStyle(home)
    .transitionProperty.split(',')
    .map((p) => p.trim())
    .filter((p) => p && p !== 'opacity' && p !== 'all' && p !== 'none')
  home.style.transitionProperty = others.length ? others.join(', ') : 'none'
  home.style.opacity = '0'
  let shown = false
  return () => {
    if (shown) return
    shown = true
    home.style.opacity = ''
    // Settle its style now, opacity transition-free, so giving the transitions back starts none.
    void getComputedStyle(home).opacity
    home.style.transitionProperty = property
  }
}

interface TileFlight {
  /** Into the tile, or out of it back to the frame. */
  kind: 'into' | 'out'
  key: string | null
  flyer: HTMLElement
  move: Animation
  animations: Animation[]
  /** The frame, hidden while the flight is over it (into: from its launch; out: from its mount till the copy reaches it). */
  target: HTMLElement | null
  /** Into: the tile, once drawn (landTileHome), hidden till the handover. */
  home: HTMLElement | null
  /** The copy has reached its place. */
  done: boolean
  /** Shows what the flight hid (the tile), transition-free. */
  reveal: () => void
  /** Runs once, TILE_HANDOFF_MS in (at the latest as the copy reaches its place): the card put away, or brought back. */
  handoff: (() => void) | null
  /** The hand-over has run (or there was none to run). */
  handed: boolean
  /** Runs once if it ends before the hand-over (another tile flight took over): nothing changed hands. */
  cancelled: (() => void) | null
  timer: ReturnType<typeof setTimeout> | null
  handoffTimer: ReturnType<typeof setTimeout> | null
}

let tileFlight: TileFlight | null = null
const noop = () => {}

const playOptions = (): KeyframeAnimationOptions => ({ duration: MINIMIZE_FLIGHT_MS, easing: TILE_FLIGHT_EASING, fill: 'forwards' })
/** The outline's clock: its keyframes are moments already (outlineProgress), done by the hand-over and held. */
const outlineOptions = (): KeyframeAnimationOptions => ({ duration: TILE_HANDOFF_MS, easing: 'linear', fill: 'forwards' })

/**
 * The flyer on screen and in the air: the window (`snap`) between where its
 * frame stands and the tile (`end`), `kind` saying which way.
 *
 *   flyer   the window's size from its top-left, clipped round what the
 *           window passes behind (obstacleClip).
 *   mover   the copy's box at scale 1, ONE transform animation: the path and
 *           the scale (tileFlightFrames). Everything else is inside it, in
 *           the copy's own coordinates.
 *   shade   the frame's own shadow and ring on a box of its size, fading out
 *           toward the tile (the copy's are cut by its clip).
 *   copy    the still copy, its clip from the frame's box to the tile's
 *           inner box (tileClipFrames), done by the hand-over
 *           (outlineProgress).
 *   edge    the tile's border and shadow round that clip (tileRingFrames, on
 *           the clip's clock), fading in toward the tile.
 */
function takeOff(kind: 'into' | 'out', snap: TileSnapshot, end: TileEnd, frame: HTMLElement | null): { flyer: HTMLElement; move: Animation; animations: Animation[] } {
  const { copy, rect } = snap
  const inner = tileInnerBox(end)
  const panel = pagePanelObstacle()
  // Never a hole over where the window stands or lands: there it is whole.
  const holes = [panel, composerObstacle()].filter((o): o is FlightObstacle => !!o && !overlaps(o, rect) && !overlaps(o, end.rect))

  const flyer = document.createElement('div')
  flyer.setAttribute('aria-hidden', 'true')
  flyer.inert = true
  flyer.setAttribute('data-card-reply-flight', '')
  flyer.setAttribute('data-tile-flight', kind)
  flyer.className = 'ph-no-capture'
  Object.assign(flyer.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', overflow: 'visible', zIndex: String(TILE_FLIGHT_Z), pointerEvents: 'none' })
  if (holes.length) flyer.style.clipPath = obstacleClip(holes)

  const mover = document.createElement('div')
  mover.setAttribute('data-tile-flight-window', '')
  Object.assign(mover.style, { position: 'absolute', left: '0', top: '0', width: `${rect.width}px`, height: `${rect.height}px`, transformOrigin: '0 0', willChange: 'transform', pointerEvents: 'none' })
  const shade = document.createElement('div')
  shade.setAttribute('data-tile-flight-shade', '')
  Object.assign(shade.style, { position: 'absolute', inset: '0', pointerEvents: 'none', willChange: 'opacity' })
  const edge = document.createElement('div')
  edge.setAttribute('data-tile-flight-edge', '')
  Object.assign(edge.style, { position: 'absolute', boxSizing: 'border-box', borderStyle: 'solid', borderColor: end.edge, pointerEvents: 'none', willChange: 'opacity' })
  mover.append(shade, copy, edge)
  flyer.append(mover)
  document.body.append(flyer)

  // The frame's own look, off the frame while it is there, else off its copy (the frame's clone, drawn now).
  const look = getComputedStyle(frame ?? copy)
  const frameRadius = parseFloat(look.borderTopLeftRadius) || 0
  Object.assign(shade.style, { borderRadius: `${frameRadius}px`, boxShadow: look.boxShadow || 'none' })
  const scale = coverScale(rect.width, rect.height, inner.width, inner.height)
  edge.style.boxShadow = scaledShadow(end.shadow, 1 / scale)
  // Its scrollers where the page's stood (a clone starts at the top).
  applyCopyScroll(copy)

  const way = <T extends { offset: number }>(frames: T[]): T[] => (kind === 'into' ? frames : reversedFrames(frames))
  const moves = way(tileFlightFrames(rect, inner, panel))
  // The outline at each moment up to the hand-over: toward the tile, or from it toward the frame.
  const along = outlineProgress().map((p) => (kind === 'into' ? p : 1 - p))
  const clips = tileClipFrames(rect, inner, { frame: frameRadius, tile: Math.max(0, end.radius - end.border) }, along)
  const rings = tileRingFrames(rect, inner, { width: end.border, radius: end.radius }, along)
  const toTile = way([
    { offset: 0, opacity: 0 },
    { offset: 1, opacity: 1 },
  ])
  const toFrame = way([
    { offset: 0, opacity: 1 },
    { offset: 1, opacity: 0 },
  ])
  // As its first keyframe before the animations take it (the frame this paints in).
  const ring = rings[0]
  mover.style.transform = moves[0].transform
  copy.style.clipPath = clips[0].clipPath
  Object.assign(edge.style, { left: ring.left, top: ring.top, width: ring.width, height: ring.height, borderWidth: ring.borderWidth, borderRadius: ring.borderRadius, opacity: String(toTile[0].opacity) })
  shade.style.opacity = String(toFrame[0].opacity)

  const move = mover.animate(moves, playOptions())
  const animations = [move, copy.animate(clips, outlineOptions()), edge.animate(rings, outlineOptions()), edge.animate(toTile, playOptions()), shade.animate(toFrame, playOptions())]
  return { flyer, move, animations }
}

/** A frame the flight put away shows again only if it is still there a moment on (it was not put away after all). */
function showIfKept(frame: HTMLElement): void {
  setTimeout(() => {
    if (frame.isConnected) frame.style.opacity = ''
  }, FRAME_KEPT_MS)
}

/** Ends the tile flight now: animations stopped, the flyer gone, what it hid shown, in one go. */
function endTileFlight(): void {
  const f = tileFlight
  if (!f) return
  tileFlight = null
  if (f.timer) clearTimeout(f.timer)
  if (f.handoffTimer) clearTimeout(f.handoffTimer)
  for (const a of f.animations) a.cancel()
  f.flyer.remove()
  if (f.target) {
    // Into the tile, its card already told to leave: the frame goes with it, never back for a frame.
    if (f.kind === 'into' && f.handed) showIfKept(f.target)
    else f.target.style.opacity = ''
  }
  f.reveal()
  const cancelled = f.handed ? null : f.cancelled
  f.cancelled = null
  f.handoff = null
  cancelled?.()
}

/** Let the tile flight under `key` go now (nothing will land it). */
export function cancelTileFlight(key: string): void {
  if (tileFlight?.key === key) endTileFlight()
}

/** Whether a tile flight is in the air (or waiting to land). */
export function tileFlightActive(): boolean {
  return !!tileFlight
}

/** After the next frame is out, as a task of its own. */
export function afterFrame(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(run, 0))
  else setTimeout(run, 0)
}

function handOver(f: TileFlight): void {
  if (f.handoffTimer) clearTimeout(f.handoffTimer)
  f.handoffTimer = null
  const run = f.handoff
  f.handoff = null
  f.handed = true
  run?.()
}

/** In the air: the hand-over TILE_HANDOFF_MS in, and the landing as `move` ends (now, or within LAND_WAIT_MS of it). */
function fly(f: TileFlight, landed: () => boolean): void {
  tileFlight = f
  if (f.handoff) f.handoffTimer = setTimeout(() => tileFlight === f && handOver(f), TILE_HANDOFF_MS)
  f.move.finished.then(
    () => {
      if (tileFlight !== f) return
      f.done = true
      // At the latest (a timer held back: a tab in the background).
      if (!f.handed) handOver(f)
      if (tileFlight !== f) return
      if (landed()) endTileFlight()
      else f.timer = setTimeout(() => tileFlight === f && endTileFlight(), LAND_WAIT_MS)
    },
    noop,
  )
}

/**
 * Into the tile: the frame's copy (`snap`) from where the frame stands to a
 * tile at `to` (its box and edge: tileEndOf), under `key`. `frame` (still on
 * screen: a minimize launched before its card leaves full screen,
 * minimized-card.ts minimizeSoon) is hidden while the copy is over it.
 * `handoff` runs TILE_HANDOFF_MS in (the card put away then, its frame going
 * with it); the tile, drawn under the flyer's z (landTileHome), stays hidden
 * till the copy has landed and takes over in that one frame. `cancelled`
 * runs instead when the flight ends before the hand-over. Ends any tile
 * flight in the air. False when nothing flies.
 */
export function launchIntoTile(
  key: string | null,
  snap: TileSnapshot | null,
  to: TileEnd | null,
  frame: HTMLElement | null = null,
  { handoff, cancelled }: { handoff?: () => void; cancelled?: () => void } = {},
): boolean {
  if (!snap || !to || !canFly()) return false
  endTileFlight()
  const { flyer, move, animations } = takeOff('into', snap, to, frame)
  if (frame) frame.style.opacity = '0'
  const f: TileFlight = { kind: 'into', key, flyer, move, animations, target: frame, home: null, done: false, reveal: noop, handoff: handoff ?? null, handed: !handoff, cancelled: cancelled ?? null, timer: null, handoffTimer: null }
  // Landed: the flyer goes and the tile is whole, in one go (one frame).
  fly(f, () => !!f.home)
  return true
}

function landHome(f: TileFlight, tile: HTMLElement): () => void {
  if (f.done) {
    // The copy is there already: the tile takes over before this paint.
    endTileFlight()
    return noop
  }
  f.home = tile
  f.reveal = hideHome(tile)
  return () => {
    if (tileFlight !== f || f.home !== tile) return
    f.home = null
    f.reveal()
    f.reveal = noop
  }
}

/**
 * The tile for the flight into it under `key` is drawn (call from its
 * layout effect, before it paints, its preview already in it): hidden with
 * no transition till the copy has landed on it, then whole, transition-free,
 * in the very frame the copy goes. Returns the effect's cleanup (the tile
 * shown again; React's development double mount lands it again).
 */
export function landTileHome(key: string, tile: HTMLElement | null): () => void {
  const f = tileFlight
  if (!f || f.kind !== 'into' || f.key !== key || !tile || f.home) return noop
  return landHome(f, tile)
}

/**
 * A card minimized, the flight starting as its tile draws (an exit that
 * could not wait: minimized-card.ts minimizeCard): its frame's copy (`snap`,
 * taken as it left full screen) flies into `tile` (call from the tile's
 * layout effect, before it paints, its preview already in it), the tile
 * whole in the frame the copy goes. Ends any tile flight in the air.
 * Nothing without a copy, the Web Animations API, or under reduced motion;
 * true when it flies.
 */
export function flyIntoTile(snap: TileSnapshot | null, tile: HTMLElement | null): boolean {
  if (!tile || !launchIntoTile(null, snap, tileEndOf(tile)) || !tileFlight) return false
  landHome(tileFlight, tile)
  return true
}

/**
 * The tile clicked: a copy of its card's frame (`snap`, the preview's
 * clone) grows out of `tile` back to where the frame stood, under `key`: it
 * starts looking exactly like the tile (its box, corners, edge and shadow,
 * as it stands, lifted under the pointer or not; the tile gone in the frame
 * the copy appears on it, no ghost of it left behind), and lands looking
 * exactly like the frame. `handoff` runs TILE_HANDOFF_MS in (the card
 * brought back then: its frame mounts under the copy and lands it,
 * landTileFlight). `cancelled` runs instead when the flight ends before the
 * hand-over. Ends any tile flight in the air. False when nothing flies (no
 * copy, no API, reduced motion, no tile on screen).
 */
export function launchTileFlight(
  key: string,
  tile: HTMLElement | null,
  snap: TileSnapshot | null,
  { handoff, cancelled }: { handoff?: () => void; cancelled?: () => void } = {},
): boolean {
  if (!snap || !tile || !canFly()) return false
  const from = tileEndOf(tile)
  if (!from) return false
  endTileFlight()
  const { flyer, move, animations } = takeOff('out', snap, from, null)
  const reveal = hideHome(tile)
  const f: TileFlight = { kind: 'out', key, flyer, move, animations, target: null, home: null, done: false, reveal, handoff: handoff ?? null, handed: !handoff, cancelled: cancelled ?? null, timer: null, handoffTimer: null }
  // The frame is there, hidden: it shows as the copy goes. Not yet: the copy waits on its place for it.
  fly(f, () => !!f.target)
  return true
}

/**
 * The frame of the card flying out of the tile (`key`) has mounted (call
 * from its layout effect, before it paints): hidden under its copy till the
 * copy reaches it, and shown in the frame the copy goes; at once (the copy
 * gone, the frame shown, before this paint) when the copy is there already.
 * Returns the effect's cleanup (a frame taken off shows again; React's
 * development double mount lands it again).
 */
export function landTileFlight(key: string, frame: HTMLElement | null): () => void {
  const f = tileFlight
  if (!f || f.kind !== 'out' || f.key !== key || !frame) return noop
  if (f.done) {
    endTileFlight()
    return noop
  }
  f.target = frame
  frame.style.opacity = '0'
  return () => {
    if (tileFlight !== f || f.target !== frame) return
    frame.style.opacity = ''
    f.target = null
  }
}

export function __resetTileFlightForTests(): void {
  if (tileFlight?.handoffTimer) clearTimeout(tileFlight.handoffTimer)
  if (tileFlight?.timer) clearTimeout(tileFlight.timer)
  tileFlight = null
}
