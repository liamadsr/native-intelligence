/**
 * Reply on a For you card, seen to travel (Liam, 2026-10-18: "an actual
 * animation that like you see it travel to the chat … a really nice, smooth
 * transition into the top of the chat"): the card lifts off the focus view
 * where Reply was pressed, turns into the Reply chip, and flies into its
 * place above the composer (card-reply-chip.tsx).
 *
 * The motion (Liam, 10-18, after the first cut floated down slowly: "goes
 * down and then to the right … a smooth curve … speeds up at the end … cool
 * and modern"): the card becomes the chip where it stood as it starts to
 * move, then drops, rounds a soft corner and runs right into the
 * chip, picking up speed all the way (FLIGHT_PACE), and a landing with
 * momentum: the real chip carries on a few px the way it came, squashes a
 * little and springs back (settleFrames). It becomes the chip at the card's
 * own width and grows to the chip's as it slides down, never bigger than the
 * card as it takes off (Liam, 10-18: it "pops out and gets bigger than the
 * original … it should get bigger as it slides down").
 *
 * Two halves, because the press and the chip are far apart in time and in
 * the tree (the shell may put the home thread up first: card-reply.ts). The
 * column's Reply (column-compact-card.tsx) launches the flight before the
 * focus view closes: a copy of the card, held where it stood. The chip lands
 * it as it mounts (its layout effect, before its first paint). The card's
 * copy fades out as a copy of the chip fades in, both on one path, each
 * scaled to the moving width (never stretched) from its top-left, so the chip
 * grows out of the card's own first line (its verb pill and sentence). The
 * real chip stays hidden until the copy lands on it.
 *
 * The copies sit in a flyer in <body>, fixed, over everything (the column
 * and the composer sit in clipping rows), never taking a pointer, and are
 * gone once it lands. Transform and opacity only, and nothing left running
 * after (WebKit keeps a kept clone's CSS animations going; these copies are
 * removed, and the settle ends). One flight at a time: a new Reply ends the
 * one in the air. No flight without the Web Animations API (jsdom) or with
 * reduced motion: the chip just appears, as before. A chip that never mounts
 * lets the held card fade out after FLIGHT_WAIT_MS.
 *
 * The same flight carries the top bar's search button into the `/` palette
 * (Liam, 10-20: "the search kind of animates into the center of the page"):
 * launchFlight / landFlight under their own key (SEARCH_FLIGHT_KEY), the
 * button lifting off and the palette's box growing out of it. Dismissed, it
 * goes back the way it came (flyBack): the box shrinks back along the same
 * curve into the button, slowing as it arrives, and the button settles.
 * And a message's Reply in the chat (message-reply.ts), under its own key:
 * the bubble's first lines lift off (maxHeight) and turn into the chip, or
 * the Reply over the words selected does.
 */
import type { CardReplyRef } from './card-reply'

type FlightCard = Pick<CardReplyRef, 'kind' | 'id'>

export interface FlightRect {
  left: number
  top: number
  width: number
  height: number
}

/** A Web Animations keyframe (a type, not an interface, so it is one). */
export type FlightFrame = {
  offset: number
  transform: string
  opacity: number
  /** Where the copy keeps its corners (keepCorners): its radius, counter-scaled. */
  borderRadius?: string
}

/** How long the trip takes, ms. */
export const FLIGHT_MS = 620
/**
 * How far along the path it is over the trip's time, a cubic-bezier's
 * points: from rest, speeding up all the way, arriving about 2.6 times as
 * fast as its average (a fifth of the way at half time).
 */
export const FLIGHT_PACE = [0.45, 0, 0.75, 0.35] as const
/** The landing's bounce, ms. */
export const SETTLE_MS = 460
/** How long a launched card waits for its chip before it fades away, ms. */
export const FLIGHT_WAIT_MS = 1200
/** A chip taken off mid-air: how long the card waits for it to come back (React's development double mount), ms. */
const FLIGHT_RELAND_MS = 250
/** The held card's fade when no chip came, ms. */
const FLIGHT_FADE_MS = 160
/** Keyframes over the trip, evenly in time (straight between them: about one per 10ms). */
const FLIGHT_STEPS = 60
/** Over the focus view (z-50) and the raised composer (z-46). */
const FLIGHT_Z = 60
/** How far along the path (0 to 1) it has grown to the chip's width: most of the drop. */
const GROWN_AT = 0.65
/** The landing: how far the chip carries on past its place (px), and how much it squashes. */
const SETTLE_PX = 7
const SETTLE_SQUASH = 0.035

const round = (n: number, places: number) => {
  const f = 10 ** places
  return Math.round(n * f) / f
}

const between = (t: number, from: number, to: number) => Math.min(1, Math.max(0, (t - from) / (to - from)))

/** A CSS cubic-bezier timing function, as a function of time (0 to 1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const ax = 1 - 3 * x2 + 3 * x1
  const bx = 3 * x2 - 6 * x1
  const cx = 3 * x1
  const ay = 1 - 3 * y2 + 3 * y1
  const by = 3 * y2 - 6 * y1
  const cy = 3 * y1
  const x = (s: number) => ((ax * s + bx) * s + cx) * s
  const y = (s: number) => ((ay * s + by) * s + cy) * s
  return (t) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    let lo = 0
    let hi = 1
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2
      if (x(mid) < t) lo = mid
      else hi = mid
    }
    return y((lo + hi) / 2)
  }
}

const pace = cubicBezier(...FLIGHT_PACE)
const smooth = (t: number) => t * t * (3 - 2 * t)

/**
 * The moving box's top-left at `p` of the way (0 to 1): a cubic curve that
 * drops from `from`'s top-left, rounds a soft corner and runs across into
 * `to`'s, arriving level (Liam: "down and then to the right").
 */
export function flightPoint(from: FlightRect, to: FlightRect, p: number): { x: number; y: number } {
  const c1 = { x: from.left, y: from.top + (to.top - from.top) * 0.8 }
  const c2 = { x: from.left + (to.left - from.left) * 0.2, y: to.top }
  const u = 1 - p
  const a = u * u * u
  const b = 3 * u * u * p
  const c = 3 * u * p * p
  const d = p * p * p
  return {
    x: a * from.left + b * c1.x + c * c2.x + d * to.left,
    y: a * from.top + b * c1.y + c * c2.y + d * to.top,
  }
}

/**
 * The keyframes of both copies, evenly in time (each straight to the next,
 * the pace baked in, so the crossfade keeps its own time whatever the pace).
 * In the first third of the time the card's copy fades out as the chip's
 * fades in, at the card's width. The width follows the path, not the clock:
 * it grows smoothly from the card's to the chip's over the first GROWN_AT of
 * the way (the drop), so it gets bigger as it slides, faster and faster, and
 * lands level at the chip's size. Pure, for the tests.
 */
export function flightFrames(
  from: FlightRect,
  to: FlightRect,
  steps = FLIGHT_STEPS,
  radii?: FlightRadii,
): { card: FlightFrame[]; chip: FlightFrame[] } {
  const card: FlightFrame[] = []
  const chip: FlightFrame[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const p = pace(t)
    const { x, y } = flightPoint(from, to, p)
    const width = from.width + (to.width - from.width) * smooth(between(p, 0, GROWN_AT))
    const at = `translate(${round(x, 2)}px, ${round(y, 2)}px)`
    const offset = round(t, 4)
    const cardScale = width / from.width
    const chipScale = width / to.width
    // Kept corners: the radius over the scale, never past half the copy's own height.
    const corner = (radius: number, scale: number, height: number) => `${round(Math.min(radius / scale, height / 2), 2)}px`
    card.push({
      offset,
      transform: `${at} scale(${round(cardScale, 4)})`,
      opacity: round(1 - between(t, 0.06, 0.3), 3),
      ...(radii ? { borderRadius: corner(radii.card, cardScale, from.height) } : {}),
    })
    chip.push({
      offset,
      transform: `${at} scale(${round(chipScale, 4)})`,
      opacity: round(between(t, 0.03, 0.24), 3),
      ...(radii ? { borderRadius: corner(radii.chip, chipScale, to.height) } : {}),
    })
  }
  return { card, chip }
}

/** Which way it is moving as it lands (a unit vector; straight down when it barely moves). */
export function arrivalDirection(from: FlightRect, to: FlightRect): { x: number; y: number } {
  const a = flightPoint(from, to, 0.97)
  const b = flightPoint(from, to, 1)
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  return len < 0.01 ? { x: 0, y: 1 } : { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
}

/** Which way it sets out (a unit vector; straight down when it barely moves). */
export function departureDirection(from: FlightRect, to: FlightRect): { x: number; y: number } {
  const a = flightPoint(from, to, 0)
  const b = flightPoint(from, to, 0.03)
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  return len < 0.01 ? { x: 0, y: 1 } : { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
}

/**
 * The real chip's landing, moving `dir` (arrivalDirection): it carries on
 * SETTLE_PX that way, squashed along it, then springs back past its place a
 * touch and settles. From its centre; nothing kept after. Pure, for the tests.
 */
export function settleFrames(dir: { x: number; y: number }): Keyframe[] {
  const ax = Math.abs(dir.x)
  const ay = Math.abs(dir.y)
  const squash = (k: number) => `scale(${round(1 + k * SETTLE_SQUASH * (ax - ay), 4)}, ${round(1 + k * SETTLE_SQUASH * (ay - ax), 4)})`
  const shift = (k: number) => `translate(${round(dir.x * SETTLE_PX * k, 2)}px, ${round(dir.y * SETTLE_PX * k, 2)}px)`
  return [
    { offset: 0, transform: 'none', easing: 'cubic-bezier(0.2, 0, 0.3, 1)' },
    { offset: 0.24, transform: `${shift(1)} ${squash(1)}`, easing: 'ease-in-out' },
    { offset: 0.58, transform: `${shift(-0.28)} ${squash(-0.3)}`, easing: 'ease-in-out' },
    { offset: 0.82, transform: `${shift(0.06)} scale(1)`, easing: 'ease-out' },
    { offset: 1, transform: 'none' },
  ]
}

/**
 * A flight's keyframes played backwards: the same path, from its end to its
 * start (offsets mirrored, order reversed), so what sped up into its landing
 * slows into where it came from. Pure, for the tests.
 */
export function reversedFrames(frames: FlightFrame[]): FlightFrame[] {
  return frames.map((f) => ({ ...f, offset: round(1 - f.offset, 4) })).reverse()
}

interface Flight {
  key: string
  from: FlightRect
  flyer: HTMLElement
  /** The card's copy. */
  card: HTMLElement
  /** The chip's copy, while in the air. */
  chip: HTMLElement | null
  /** The real chip, hidden while its copy flies to it. */
  target: HTMLElement | null
  /** The trip and the landing, ms. */
  ms: number
  settleMs: number
  /** The source's radius, when the copies keep their corners (keepCorners). */
  cardRadius: number | null
  animations: Animation[]
  timer: ReturnType<typeof setTimeout> | null
}

let flight: Flight | null = null

const keyOf = (card: FlightCard) => `${card.kind}:${card.id}`

/** The search button's flight into the `/` palette (top-bar/search-button.tsx, chat/command-menu.tsx). */
export const SEARCH_FLIGHT_KEY = 'search'
/** Its trip and landing, ms: quicker than a Reply's (Liam, 10-20: "make the animation faster"). */
export const SEARCH_FLIGHT_MS = 380
export const SEARCH_SETTLE_MS = 300

/** A flight's own timing, where it isn't a Reply's (FLIGHT_MS, SETTLE_MS). */
export interface FlightTiming {
  ms?: number
  settleMs?: number
  /**
   * The copies keep their corners on screen as they scale (the search box:
   * Liam, 10-20, its corners "go away and look sharp" when scaled): each
   * frame's radius is the element's own over the frame's scale, at most half
   * its height, so a box scaled down to the button's size is a pill like it.
   */
  keepCorners?: boolean
  /**
   * What lifts off is at most this tall (px): a long message's bubble flies
   * as its first lines, fading out at the cut, not as the whole reply
   * (message-reply.ts: a message's Reply).
   */
  maxHeight?: number
}

/** The fade at the foot of a copy cut to FlightTiming.maxHeight. */
const CUT_MASK = 'linear-gradient(to bottom, #000 55%, transparent)'

/** The copies' own corner radii (px), for keepCorners. */
export interface FlightRadii {
  card: number
  chip: number
}

/** Whether a flight under `key` is held, waiting for its landing. */
export function flightWaiting(key: string): boolean {
  return !!flight && flight.key === key && !flight.chip
}

/** Let the flight under `key` go now (nothing will land it): its copy gone, whatever it hid shown. */
export function cancelFlight(key: string): void {
  if (flight?.key === key) endFlight()
}

function canFly(): boolean {
  if (typeof document === 'undefined' || typeof document.body?.animate !== 'function') return false
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** An element's own corner radius (px), as drawn. */
function radiusOf(el: HTMLElement): number {
  return parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
}

function rectOf(el: HTMLElement): FlightRect | null {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return null
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/**
 * A still copy of `el` for the flyer, exactly `width` wide from its top-left: no ids
 * and no data attributes (nothing that finds the real one finds it), no
 * animation or transition of its own, at most `maxHeight` tall.
 */
function copyOf(el: HTMLElement, width: number, maxHeight?: number): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement
  for (const node of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
    node.removeAttribute('id')
    for (const name of node.getAttributeNames()) if (name.startsWith('data-')) node.removeAttribute(name)
  }
  Object.assign(copy.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    margin: '0',
    width: `${width}px`,
    // Its own width, not its place's cap (the chip's is 100% of the composer; the flyer has none).
    maxWidth: 'none',
    boxSizing: 'border-box',
    transformOrigin: '0 0',
    animation: 'none',
    transition: 'none',
    willChange: 'transform, opacity',
  })
  if (maxHeight !== undefined) {
    copy.style.maxHeight = `${maxHeight}px`
    copy.style.overflow = 'hidden'
  }
  return copy
}

/** Ends the flight now: its animations stopped, the real chip shown, the flyer gone. */
function endFlight(): void {
  const f = flight
  if (!f) return
  flight = null
  if (f.timer) clearTimeout(f.timer)
  for (const a of f.animations) a.cancel()
  if (f.target) f.target.style.opacity = ''
  f.flyer.remove()
}

/** A held card with no chip to land on fades away after `ms`. */
function waitForChip(f: Flight, ms: number): void {
  if (f.timer) clearTimeout(f.timer)
  f.timer = setTimeout(() => {
    if (flight !== f || f.chip) return
    f.timer = null
    const fade = f.flyer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLIGHT_FADE_MS, easing: 'ease-out', fill: 'forwards' })
    f.animations.push(fade)
    fade.finished.then(
      () => {
        if (flight === f) endFlight()
      },
      () => {},
    )
  }, ms)
}

/**
 * Reply pressed on `card`, shown by `source` (the focus view's card): a copy
 * of it is held where it stands, for its chip to land (landCardReplyFlight).
 * Call before the focus view closes. Ends any flight still in the air.
 */
export function launchCardReplyFlight(card: FlightCard, source: HTMLElement | null): void {
  launchFlight(keyOf(card), source)
}

/**
 * `card`'s chip has mounted, `chip` its card box (call from its layout
 * effect, before it paints): the held card flies to it (landFlight).
 */
export function landCardReplyFlight(card: FlightCard, chip: HTMLElement | null): () => void {
  return landFlight(keyOf(card), chip)
}

/**
 * `box` (what a flight landed on, about to go) flies back into `home` (what
 * it flew out of): copies of both on the flight's path played backwards, the
 * box's fading into the home's on the last stretch, then `home` settles. The
 * box itself can go at once (the copies are in the flyer). Ends any flight in
 * the air. Nothing without the Web Animations API or with reduced motion.
 */
export function flyBack(box: HTMLElement | null, home: HTMLElement | null, timing: FlightTiming = {}): void {
  endFlight()
  if (!box || !home || !canFly()) return
  const from = rectOf(home)
  const to = rectOf(box)
  if (!from || !to) return
  const ms = timing.ms ?? FLIGHT_MS
  const settleMs = timing.settleMs ?? SETTLE_MS
  const flyer = document.createElement('div')
  flyer.setAttribute('aria-hidden', 'true')
  flyer.inert = true
  flyer.setAttribute('data-card-reply-flight', '')
  flyer.className = 'ph-no-capture font-sans'
  Object.assign(flyer.style, { position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: String(FLIGHT_Z), pointerEvents: 'none' })
  const homeCopy = copyOf(home, from.width)
  const boxCopy = copyOf(box, to.width, Math.max(1, Math.min(to.height, window.innerHeight - to.top)))
  flyer.append(homeCopy, boxCopy)
  document.body.append(flyer)
  // The way there, played backwards: `card` is home's copy, `chip` the box's.
  const frames = flightFrames(from, to, FLIGHT_STEPS, timing.keepCorners ? { card: radiusOf(home), chip: radiusOf(box) } : undefined)
  const play: KeyframeAnimationOptions = { duration: ms, easing: 'linear', fill: 'forwards' }
  const toHome = homeCopy.animate(reversedFrames(frames.card), play)
  boxCopy.animate(reversedFrames(frames.chip), play)
  // It arrives the way it first set out, reversed.
  const out = departureDirection(from, to)
  toHome.finished.then(
    () => {
      flyer.remove()
      home.animate(settleFrames({ x: -out.x, y: -out.y }), { duration: settleMs })
    },
    () => flyer.remove(),
  )
}

/**
 * A copy of `source` held where it stands, under `key`, for what it becomes
 * to land it (landFlight). Ends any flight still in the air.
 */
export function launchFlight(key: string, source: HTMLElement | null, timing: FlightTiming = {}): void {
  endFlight()
  if (!source || !canFly()) return
  const rect = rectOf(source)
  if (!rect) return
  // What lifts off: at most maxHeight of it (a long message's first lines).
  const cut = timing.maxHeight !== undefined && rect.height > timing.maxHeight
  const from = cut ? { ...rect, height: timing.maxHeight as number } : rect
  const flyer = document.createElement('div')
  flyer.setAttribute('aria-hidden', 'true')
  flyer.inert = true
  flyer.setAttribute('data-card-reply-flight', '')
  // `ph-no-capture`: a draft card's sentence quotes the email's subject. `font-sans`: the focus view's own.
  flyer.className = 'ph-no-capture font-sans'
  Object.assign(flyer.style, { position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: String(FLIGHT_Z), pointerEvents: 'none' })
  // Its visible part: a card taller than the window is cut at the window's bottom.
  const copy = copyOf(source, from.width, Math.max(1, Math.min(from.height, window.innerHeight - from.top)))
  if (cut) {
    copy.style.maskImage = CUT_MASK
    copy.style.setProperty('-webkit-mask-image', CUT_MASK)
  }
  copy.style.transform = `translate(${from.left}px, ${from.top}px)`
  flyer.append(copy)
  document.body.append(flyer)
  const f: Flight = {
    key,
    from,
    flyer,
    card: copy,
    chip: null,
    target: null,
    ms: timing.ms ?? FLIGHT_MS,
    settleMs: timing.settleMs ?? SETTLE_MS,
    cardRadius: timing.keepCorners ? radiusOf(source) : null,
    animations: [],
    timer: null,
  }
  flight = f
  waitForChip(f, FLIGHT_WAIT_MS)
}

/**
 * What the flight under `key` becomes has mounted, `chip` its box (call from
 * its layout effect, before it paints): the held copy flies to it, and it
 * shows when it lands. Nothing when no flight under `key` is waiting. Returns
 * the effect's cleanup: a target taken off mid-air (or mounted twice, as
 * React does in development) shows again at once and leaves the copy held,
 * briefly, for a target to land it again.
 */
export function landFlight(key: string, chip: HTMLElement | null): () => void {
  const f = flight
  if (!f || f.key !== key || f.chip || !chip) return () => {}
  const to = rectOf(chip)
  if (!to) {
    endFlight()
    return () => {}
  }
  if (f.timer) clearTimeout(f.timer)
  f.timer = null
  const copy = copyOf(chip, to.width)
  copy.style.opacity = '0'
  f.flyer.append(copy)
  f.chip = copy
  f.target = chip
  chip.style.opacity = '0'
  const frames = flightFrames(f.from, to, FLIGHT_STEPS, f.cardRadius === null ? undefined : { card: f.cardRadius, chip: radiusOf(chip) })
  const timing: KeyframeAnimationOptions = { duration: f.ms, easing: 'linear', fill: 'forwards' }
  const toCard = f.card.animate(frames.card, timing)
  const toChip = copy.animate(frames.chip, timing)
  f.animations = [toCard, toChip]
  const dir = arrivalDirection(f.from, to)
  toChip.finished.then(
    () => {
      if (flight !== f) return
      endFlight()
      // Landed with momentum: the real chip carries on, squashes and springs back.
      chip.animate(settleFrames(dir), { duration: f.settleMs })
    },
    () => {},
  )
  return () => {
    if (flight !== f || f.chip !== copy) return
    for (const a of f.animations) a.cancel()
    f.animations = []
    copy.remove()
    f.chip = null
    chip.style.opacity = ''
    f.target = null
    waitForChip(f, FLIGHT_RELAND_MS)
  }
}
