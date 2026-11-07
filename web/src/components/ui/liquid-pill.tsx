'use client'

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { Liquid } from 'liquid-gooey'
import { cn } from '@/lib/utils'
import { subscribePointerExit } from '@/lib/pointer-exit'

/**
 * A header pill made of the nav's liquid (liquid-gooey — see GooeyNav), with a
 * card that pours out of it. Closed, the card is collapsed into the pill's
 * right cap; open, it falls out and swells, hanging right-aligned below the
 * pill and joined to it by a neck of goo — or, with `cardSide="top"`, rising
 * right-aligned ABOVE it, for a pill that sits low on the screen (the chat
 * composer's Transcripts and Tools). The Capture button, in the top bar beside
 * the workspace switcher, pours out today's calendar; the workspace switcher
 * pours out its menu. Both hang below their pills.
 *
 *   <LiquidPill open={open}>
 *     <LiquidPillFace>…the pill's controls…</LiquidPillFace>
 *     <LiquidPillCard width={320}>…</LiquidPillCard>
 *   </LiquidPill>
 *
 * Both open on HOVER (useLiquidPillHover) — the card is there before you
 * commit to it, the way the nav's pages are.
 *
 * The liquid is the surface of both the pill and the card, so the face and the
 * card carry no background or border of their own. It is the plain header
 * pills' white / black — or, with `appBackground`, the app's own background,
 * the way the chat composer's pills are all one colour — and the pill is painted exactly their size (see PILL_BLOB_INSET_Y_PX), so
 * a liquid pill sits in its row like any other.
 */

/** The header pills' height (`h-9`). */
const PILL_HEIGHT_PX = 36

/** The goo's reach and edge sharpness — the nav's. */
const GOO_BLUR = 7
const GOO_CONTRAST = 20

/**
 * How far inside the pill's box its liquid blob sits, so the PAINTED pill
 * comes out the size of its neighbours rather than bigger. The goo paints a
 * straight edge about 1.75px outside its blob — measured in Chrome, by drawing
 * the silhouette to a canvas — and the ring adds 1px more; round the pill's
 * ends the curve cancels the goo's spread, leaving just the ring. A 31px blob
 * then paints 36.5px against a plain pill's 36 (a 30px one, 35). Layout offsets
 * are whole pixels, so the blob sits 2px down and a transform takes the last
 * half pixel. Keep in step with the blob's classes, and measure again if the
 * blur changes.
 */
const PILL_BLOB_INSET_Y_PX = 2.5

/** Open, the card hangs this far below the pill's blob: inside the goo's reach,
 *  so a neck of liquid joins the two, the way the nav's pages neck into each
 *  other. */
const CARD_GAP_PX = 8

/** Open, the card's top — to a whole pixel, so its text stays sharp. */
const CARD_OPEN_Y = Math.round(PILL_HEIGHT_PX - PILL_BLOB_INSET_Y_PX + CARD_GAP_PX)

/** Open ABOVE the pill (`cardSide="top"`), the card's BOTTOM: CARD_OPEN_Y
 *  mirrored about the pill's middle, so the card's bottom edge stands exactly
 *  as far above the blob's top (inset 2.5px) as a hanging card's top stands
 *  below the blob's bottom (inset 3px less the half-pixel nudge) — 8.5px
 *  either way — and stays on a whole pixel. */
const CARD_OPEN_BOTTOM_Y = PILL_HEIGHT_PX - CARD_OPEN_Y

/** Closed, the card is collapsed to a point in the pill's right cap — nothing,
 *  rather than a small drop, because where it parks depends on the card's
 *  height (see LiquidPillCard), and the library springs every move: a visible
 *  drop would fly into place on first paint, and again whenever the content
 *  changes size while it's shut. A point travels unseen, and on open the card
 *  still swells out of the pill's liquid. */
const CARD_CLOSED_SCALE = 0

/**
 * The liquid's edge: four 1px layers that draw a ring in the border colour
 * round the merged shape — the header pills' border, which a silhouette can't
 * have; without it the card is lost over a dark window. Plain drop-shadows go
 * to CSS rather than into the SVG filter, so `var()` resolves and the ring
 * follows the theme.
 */
const LIQUID_RING = [
  '1px 0 0 hsl(var(--border))',
  '-1px 0 0 hsl(var(--border))',
  '0 1px 0 hsl(var(--border))',
  '0 -1px 0 hsl(var(--border))',
]

/** At rest, the header pills' own small shadow, so the pill matches its
 *  neighbours; with the card out, the nav's lift, so the card stands off
 *  whatever it's over. Same number of layers, so the svg's filter transition
 *  can tween between them. */
const LIQUID_SHADOW_REST = [...LIQUID_RING, '0 1px 3px rgba(0,0,0,0.10)', '0 1px 2px rgba(0,0,0,0.06)'].join(', ')
const LIQUID_SHADOW_OPEN = [...LIQUID_RING, '0 6px 16px rgba(0,0,0,0.10)', '0 1px 3px rgba(0,0,0,0.06)'].join(', ')

/** Shared by anchored popovers that need the same liquid as the header pills. */
export const LIQUID_POPOVER_SURFACE = {
  blur: GOO_BLUR,
  contrast: GOO_CONTRAST,
  fill: 'hsl(var(--background))',
  shadow: LIQUID_SHADOW_OPEN,
}

/** Grace before a hover-out closes the card — the nav's, and for the same
 *  reason: the hand crosses the gap on its way down into the card. */
const CLOSE_DELAY_MS = 220

/** How far past the pill and the card the pointer still counts as over them. */
const HOVER_SLACK_PX = 12

/** Window event a liquid pill fires as its card comes out (`detail`: its id). */
const LIQUID_PILL_OPEN_EVENT = 'dial8:liquid-pill-open'

/** Which way the card pours out of the pill: down (hanging below it, the
 *  header's way) or up (rising above it, for a pill low on the screen). */
export type LiquidPillCardSide = 'bottom' | 'top'

const LiquidPillContext = createContext<{
  open: boolean
  setCardHeight: (height: number) => void
  setCardWidth: (width: number) => void
  cardSide: LiquidPillCardSide
}>({
  open: false,
  setCardHeight: () => {},
  setCardWidth: () => {},
  cardSide: 'bottom',
})

export const LiquidPill = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    open: boolean
    /** Where the card comes out — below the pill (the default) or above it. */
    cardSide?: LiquidPillCardSide
    /** Paint the liquid — pill and card alike — the app's own background
     *  (`--background`) rather than the header pills' pure white / black.
     *  The chat composer's pills take it, so they match its plain pills. */
    appBackground?: boolean
  }
>(function LiquidPill({ open, cardSide = 'bottom', appBackground = false, className, children, ...rest }, ref) {
  const [cardHeight, setCardHeight] = useState(0)
  const [cardWidth, setCardWidth] = useState(0)
  const context = useMemo(() => ({ open, setCardHeight, setCardWidth, cardSide }), [open, cardSide])
  return (
    <Liquid
      ref={ref}
      blur={GOO_BLUR}
      contrast={GOO_CONTRAST}
      // `--background` is set to the header pills' white / black just in here
      // — unless the pill takes the app's own background (`appBackground`),
      // when it's left alone and the liquid is the theme's background, the
      // colour `bg-background` paints (the calendar's now-line label).
      fill="hsl(var(--background))"
      shadow={open ? LIQUID_SHADOW_OPEN : LIQUID_SHADOW_REST}
      // The card travels well outside the pill's own box — down (or up) and to
      // the left — and the filter region must cover it, or the goo is clipped
      // mid-drop. The region is padded on every side alike, so this covers a
      // card rising above the pill as well as one hanging below it — and, for a
      // short card much wider than a small pill, however far it reaches left.
      filterPadding={Math.max(CARD_OPEN_Y + cardHeight, cardWidth) + 24}
      className={cn(
        !appBackground && '[--background:0_0%_100%] dark:[--background:0_0%_0%]',
        '[&>[data-gooey-svg]]:transition-[filter] [&>[data-gooey-svg]]:duration-300',
        className,
      )}
      data-open={open ? '' : undefined}
      {...rest}
    >
      {/* The pill's blob, set inside the pill's box (PILL_BLOB_INSET_Y_PX).
          Observed, so it follows the pill exactly however its size changes —
          a workspace's name changing, a recording's controls appearing. Not
          jelly: the pill's content moves with CSS, and a blob lagging behind
          it on a spring left the content hanging off the liquid (measured: up
          to 37px, for over half a second, when the workspace name used to
          open on hover). */}
      <Liquid.Item observe>
        <div className="pointer-events-none absolute inset-x-px top-[2px] bottom-[3px] translate-y-[0.5px] rounded-full" />
      </Liquid.Item>
      <LiquidPillContext.Provider value={context}>{children}</LiquidPillContext.Provider>
    </Liquid>
  )
})

/** The pill's controls: transparent, riding on the liquid. Stacked above the
 *  card, so the card growing out of the pill can never take a click meant for
 *  the pill. */
export const LiquidPillFace = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function LiquidPillFace(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={cn('relative z-10 flex h-9 items-center rounded-full', className)} {...rest} />
})

/**
 * The card that pours out of the pill. Closed it is inert and takes no pointer;
 * its content fades in a beat after the drop starts to fall, and out at once.
 * Give it a radius (`rounded-*`) — the liquid takes its shape from the card's.
 */
export const LiquidPillCard = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    width: number
    /** Omit, and the card is as tall as its content. */
    height?: number
  }
>(function LiquidPillCard({ width, height, className, style, children, ...rest }, ref) {
  const { open, setCardHeight, setCardWidth, cardSide } = useContext(LiquidPillContext)
  const cardRef = useRef<HTMLDivElement | null>(null)
  // The liquid's filter region must reach the card's far (left) edge too.
  useLayoutEffect(() => setCardWidth(width), [width, setCardWidth])
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      cardRef.current = node
      assignRef(ref, node)
    },
    [ref],
  )

  // The closed drop is centred in the pill's right cap, and the card scales
  // about its own centre — so where it parks depends on its height. Measured
  // before paint, and again whenever the content changes size.
  const [measuredHeight, setMeasuredHeight] = useState(height ?? 0)
  useLayoutEffect(() => {
    if (height != null) {
      setCardHeight(height)
      return
    }
    const el = cardRef.current
    if (!el) return
    const measure = () => {
      setMeasuredHeight(el.offsetHeight)
      setCardHeight(el.offsetHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [height, setCardHeight])
  const cardHeight = height ?? measuredHeight

  // Right-aligned on the pill (`right-0 top-0`), its top level with the
  // pill's; `x`/`y` move it from there. Open, it hangs CARD_OPEN_Y below — or,
  // rising, is lifted its own height plus the gap so its bottom sits at
  // CARD_OPEN_BOTTOM_Y. Closed, it scales to nothing about its CENTRE, which
  // sits on the centre of the pill's right cap — half the pill's height in from
  // its right edge, and down from its top — whichever way it opens, so it pours
  // out of the pill down or up alike.
  const openY = cardSide === 'top' ? CARD_OPEN_BOTTOM_Y - cardHeight : CARD_OPEN_Y
  return (
    <Liquid.Item
      className={cn('absolute right-0 top-0', !open && 'pointer-events-none')}
      x={open ? 0 : width / 2 - PILL_HEIGHT_PX / 2}
      y={open ? openY : PILL_HEIGHT_PX / 2 - cardHeight / 2}
      scale={open ? 1 : CARD_CLOSED_SCALE}
      transition="bouncy"
    >
      <div
        ref={setRefs}
        aria-hidden={!open}
        inert={!open}
        // Open: something nothing should be drawn over.
        data-bot-obstacle
        className={cn(
          'overflow-hidden transition-opacity',
          open ? 'opacity-100 delay-100 duration-200' : 'opacity-0 duration-100',
          className,
        )}
        style={{ width, height, ...style }}
        {...rest}
      >
        {children}
      </div>
    </Liquid.Item>
  )
})

/** An `overflow` that clips. Anything but `visible` does — and a non-visible
 *  overflow-x turns a visible overflow-y into `auto`, so overflow-y says it. */
const CLIPPING_OVERFLOW = /^(hidden|clip|auto|scroll)$/

/**
 * The nearest ancestor of a pill's `face` that clips its overflow — what cuts
 * a RISING card off at its top — or null if nothing short of the window does.
 * A caller that keeps its card fitted watches this for size changes.
 */
export function liquidPillClipAncestor(face: HTMLElement): HTMLElement | null {
  for (let el = face.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el)
    if (CLIPPING_OVERFLOW.test(style.overflowY || style.overflow)) return el
  }
  return null
}

/**
 * How tall a RISING card (`cardSide="top"`) can open before its top is cut
 * off: from where its bottom edge sits open (CARD_OPEN_BOTTOM_Y, just above
 * the pill) up to the top of the nearest ancestor that clips its overflow (see
 * liquidPillClipAncestor), or the window's top if that comes first. A caller
 * low in a short window sizes its card to this rather than have the card
 * cropped. `face` is the pill's LiquidPillFace, whose top is the pill's.
 */
export function liquidPillRoomAbove(face: HTMLElement): number {
  const clip = liquidPillClipAncestor(face)
  const clipTop = clip ? Math.max(0, clip.getBoundingClientRect().top) : 0
  return face.getBoundingClientRect().top + CARD_OPEN_BOTTOM_Y - clipTop
}

/**
 * How wide a card can open before its LEFT edge is cut off. The card is
 * right-aligned on the pill, so it reaches left from the pill's right edge —
 * up to the left of the nearest ancestor that clips its overflow (see
 * liquidPillClipAncestor), or the window's left edge. A pill that sits well in
 * from the right of a narrow strip sizes its card to this.
 */
export function liquidPillRoomLeft(face: HTMLElement): number {
  const clip = liquidPillClipAncestor(face)
  const clipLeft = clip ? Math.max(0, clip.getBoundingClientRect().left) : 0
  return face.getBoundingClientRect().right - clipLeft
}

/**
 * How tall a HANGING card (`cardSide="bottom"`) can open before it runs off
 * the bottom of the window: from its open top (CARD_OPEN_Y below the pill's
 * top) down to the window's bottom edge. `face` is the pill's LiquidPillFace.
 * Measured against the window, not a clipping ancestor: a header pill's card
 * pours down over the page, out of the bar's own box.
 */
export function liquidPillRoomBelow(face: HTMLElement): number {
  return window.innerHeight - face.getBoundingClientRect().top - CARD_OPEN_Y
}

/** A hanging card keeps this much clear of the window's edges… */
const HANGING_CARD_CLEARANCE_PX = 8
/** …and never shrinks below this (a short window scrolls its content). */
export const HANGING_CARD_MIN_HEIGHT_PX = 120
/** …nor narrower than this, on a very narrow window. */
export const HANGING_CARD_MIN_WIDTH_PX = 240

/**
 * The size a HANGING card (`cardSide="bottom"`, a header pill's) opens at: as
 * tall as the room below the pill allows (see liquidPillRoomBelow), between
 * `minHeight` and `maxHeight`, so a short window never pushes it off screen —
 * the card's content scrolls inside instead; and as wide as the room to the
 * pill's right edge allows (it's right-aligned on the pill and reaches left),
 * between `minWidth` and `maxWidth`.
 *
 * Kept fitted while CLOSED too (from mount, and as the window resizes),
 * because closed the card parks at a point that depends on its size (see
 * LiquidPillCard) and the pour springs from there; and once more as it opens,
 * before paint. `enabled` false leaves it at its full size.
 */
export function useHangingCardFit({
  faceRef,
  enabled,
  shown,
  maxHeight,
  maxWidth,
  minHeight = HANGING_CARD_MIN_HEIGHT_PX,
  minWidth = HANGING_CARD_MIN_WIDTH_PX,
}: {
  faceRef: RefObject<HTMLElement | null>
  enabled: boolean
  shown: boolean
  maxHeight: number
  maxWidth: number
  minHeight?: number
  minWidth?: number
}): { height: number; width: number } {
  const [size, setSize] = useState({ height: maxHeight, width: maxWidth })
  const sizeRef = useRef(size)
  const fit = useCallback(() => {
    const face = faceRef.current
    // Not laid out (a hidden pane): nothing to measure, so keep the last fit.
    if (!face || face.getBoundingClientRect().height === 0) return
    const roomBelow = Math.floor(liquidPillRoomBelow(face) - HANGING_CARD_CLEARANCE_PX)
    const roomLeft = Math.floor(face.getBoundingClientRect().right - HANGING_CARD_CLEARANCE_PX)
    const height = Math.max(minHeight, Math.min(maxHeight, roomBelow))
    const width = Math.max(minWidth, Math.min(maxWidth, roomLeft))
    if (height === sizeRef.current.height && width === sizeRef.current.width) return
    sizeRef.current = { height, width }
    setSize(sizeRef.current)
  }, [faceRef, maxHeight, maxWidth, minHeight, minWidth])

  useLayoutEffect(() => {
    if (!enabled) return
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [enabled, fit])

  useLayoutEffect(() => {
    if (shown && enabled) fit()
  }, [shown, enabled, fit])

  return size
}

/**
 * Hover-to-open for a LiquidPill, the nav's way: the card opens as the pointer
 * enters the pill, stays open while the pointer is anywhere over the pill or
 * the card — the gap between them included — and closes a moment after it
 * leaves both. Tracked by POSITION, not by the elements' own enter/leave,
 * because the hand crosses open space on its way into the card (down, or up
 * to a card that rises — the check is by bounding boxes, so it doesn't mind
 * which). Touch has no hover, so a touch never opens it. Escape and a press
 * outside are the caller's (each already has its own).
 *
 * Only one liquid pill is out at a time: one opening puts the others away, the
 * way a menu bar's menus take turns. The Capture and workspace pills sit side
 * by side in the header, 6px apart — inside each other's hover slack — and
 * sliding from one to the other without this left both cards out, one over
 * the other.
 *
 * `open` / `setOpen` are the caller's state; `enabled` false keeps the card
 * shut (the Capture button while a capture is underway). `held` true keeps an
 * open card out whatever the pointer does — a card clicked to stay open (the
 * composer's Transcripts, so a live transcript can be read hands-free). A held
 * card still takes turns: another pill opening puts it away.
 */
export function useLiquidPillHover({
  open,
  setOpen,
  enabled = true,
  held = false,
  closeDelayMs = CLOSE_DELAY_MS,
  hoverSlackPx = HOVER_SLACK_PX,
  faceRef,
  cardRef,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  enabled?: boolean
  held?: boolean
  closeDelayMs?: number
  hoverSlackPx?: number
  faceRef: RefObject<HTMLElement | null>
  cardRef: RefObject<HTMLElement | null>
}) {
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current == null) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const openNow = useCallback(() => {
    cancelClose()
    if (enabled) setOpen(true)
  }, [cancelClose, enabled, setOpen])

  const closeNow = useCallback(() => {
    cancelClose()
    setOpen(false)
  }, [cancelClose, setOpen])

  /** Close after the grace period, so crossing the gap doesn't snap it shut. */
  const closeSoon = useCallback(() => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
    }, closeDelayMs)
  }, [cancelClose, closeDelayMs, setOpen])

  // A pending close must not fire into an unmounted component.
  useEffect(() => cancelClose, [cancelClose])

  const id = useId()
  useEffect(() => {
    if (open) window.dispatchEvent(new CustomEvent(LIQUID_PILL_OPEN_EVENT, { detail: id }))
  }, [open, id])
  useEffect(() => {
    const onOtherOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) closeNow()
    }
    window.addEventListener(LIQUID_PILL_OPEN_EVENT, onOtherOpen)
    return () => window.removeEventListener(LIQUID_PILL_OPEN_EVENT, onOtherOpen)
  }, [id, closeNow])

  const overPillOrCard = useCallback(
    (x: number, y: number) => {
      const within = (el: HTMLElement | null) => {
        const r = el?.getBoundingClientRect()
        return !!r
          && x >= r.left - hoverSlackPx && x <= r.right + hoverSlackPx
          && y >= r.top - hoverSlackPx && y <= r.bottom + hoverSlackPx
      }
      return within(faceRef.current) || within(cardRef.current)
    },
    [faceRef, cardRef, hoverSlackPx],
  )

  // Held: no hover-out close, and none already on its way.
  useEffect(() => {
    if (held) cancelClose()
  }, [held, cancelClose])

  useEffect(() => {
    if (!open || !enabled || held) return
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      if (overPillOrCard(e.clientX, e.clientY)) cancelClose()
      else if (closeTimerRef.current == null) closeSoon()
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    // Tracking by position needs a LATER pointermove to see the pointer gone.
    // When it leaves the page outright (off a window edge, up into the desktop
    // app's title-bar strip, onto another window) or the window loses focus,
    // none comes and the card would stay out until the next click. Treat that
    // as leaving both: close after the usual grace period, which a pointer
    // coming straight back over the pill or card still cancels.
    const stopExit = subscribePointerExit(() => {
      if (closeTimerRef.current == null) closeSoon()
    })
    return () => {
      window.removeEventListener('pointermove', onMove)
      stopExit()
    }
  }, [open, enabled, held, overPillOrCard, cancelClose, closeSoon])

  /** For the pill's face. */
  const onPointerEnter = useCallback(
    (e: ReactPointerEvent) => {
      if (e.pointerType !== 'touch') openNow()
    },
    [openNow],
  )

  return { openNow, closeNow, closeSoon, cancelClose, onPointerEnter }
}

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}
