'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { cn } from '@/lib/utils'
import {
  LiquidPill,
  LiquidPillCard,
  LiquidPillFace,
  liquidPillClipAncestor,
  liquidPillRoomAbove,
  liquidPillRoomLeft,
  useLiquidPillHover,
} from '@/components/ui/liquid-pill'

/**
 * The chat composer's liquid pills — while a capture is on screen or recording,
 * its Transcripts and Tools — sit low in the chat strip, so their cards RISE
 * out of them (`cardSide="top"`). (Capture used to sit here too; it's in the
 * top bar now, its card hanging below it, but still takes `cardSide="top"`.)
 * What they share lives here: the lift that
 * lets a rising card paint over the chat and the content windows, the fit that
 * keeps it inside the room above (and beside) the pill, and how long its
 * content stays mounted as it shrinks home.
 */

/**
 * Set on <html> while any of the composer's rising cards is out, or still
 * shrinking back into its pill. The card pours up over the chat and the
 * content windows, but its pill sits deep in the chat strip, inside stacking
 * contexts that would keep it under the windows: the content row (`z-10`) and
 * the chat strip slot (`z-20`, below the windows' `z-30`) in dashboard-shell.
 * So while this is set, the row and the strip stop forming stacking contexts
 * (nothing else in them changes order) and the pill's wrapper is raised to
 * `z-[46]`. Keyed off <html>, not `:has()`, so the streaming chat below never
 * pays for the selector.
 */
export const CAPTURE_CARD_UP_ATTR = 'data-capture-card-up'

/** How many rising cards are up — the attribute stays set until the last one
 *  is home, so one card finishing its shrink never drops another mid-pour. */
let liftedCards = 0

/** Lift a rising card (see CAPTURE_CARD_UP_ATTR) while `active`. Before paint,
 *  so the first frame of the pour is already on top. */
export function useRisingCardLift(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return
    const html = document.documentElement
    liftedCards += 1
    html.setAttribute(CAPTURE_CARD_UP_ATTR, '')
    return () => {
      liftedCards = Math.max(0, liftedCards - 1)
      if (liftedCards === 0) html.removeAttribute(CAPTURE_CARD_UP_ATTR)
    }
  }, [active])
}

/** A card's content stays mounted this long after it closes, so it shrinks
 *  back into the pill instead of vanishing first. Longer than the spring. */
export const LIQUID_CARD_UNMOUNT_DELAY_MS = 600

/**
 * Whether a card's content should be mounted: from the moment it opens until
 * it has shrunk away. Content that fetches or re-renders often (today's
 * calendar, a live transcript) then costs nothing while the card is shut.
 */
export function useCardContentMounted(shown: boolean): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    if (shown) {
      setMounted(true)
      return
    }
    const timer = setTimeout(() => setMounted(false), LIQUID_CARD_UNMOUNT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [shown])
  return mounted
}

/** A rising card keeps this much clear of whatever clips it. */
const CARD_CLEARANCE_PX = 8
/** …and never shrinks below this, which still shows a few rows. */
export const RISING_CARD_MIN_HEIGHT_PX = 160
/** A card fitted to the room on its left never narrows below this. */
export const RISING_CARD_MIN_WIDTH_PX = 240

/**
 * The size a rising card opens at: as tall as the room above the pill allows
 * (the chat strip clips it, and a short window — or a tall draft pushing the
 * pill up — can leave less than `maxHeight`), between `minHeight` and
 * `maxHeight`; and, given a `maxWidth`, as wide as the room to the pill's
 * left allows (a pill well in from the right of a narrow composer). It keeps
 * that size as it shrinks back, so it goes home to the point it came from.
 *
 * Kept fitted while CLOSED too — from mount, and again as the window, the
 * composer (a growing draft lifts the pill) or whatever clips the card changes
 * size — because closed it parks at a point that depends on its height (see
 * LiquidPillCard), and the pour springs from wherever it parked: fitted only
 * once open, the first pour after a mount (every tab switch) or a squeeze
 * started well above the pill instead of out of it. And once more as it opens,
 * before paint, as the last word.
 *
 * `enabled` false leaves the card at its full size. Without `maxWidth` the
 * width isn't fitted (it comes back 0 — the caller has its own).
 */
export function useRisingCardFit({
  faceRef,
  enabled,
  shown,
  maxHeight,
  minHeight = RISING_CARD_MIN_HEIGHT_PX,
  maxWidth,
  minWidth = RISING_CARD_MIN_WIDTH_PX,
}: {
  faceRef: RefObject<HTMLElement | null>
  enabled: boolean
  shown: boolean
  maxHeight: number
  minHeight?: number
  maxWidth?: number
  minWidth?: number
}): { height: number; width: number } {
  const [size, setSize] = useState({ height: maxHeight, width: maxWidth ?? 0 })
  const sizeRef = useRef(size)
  const fit = useCallback(() => {
    const face = faceRef.current
    // Not laid out (a hidden pane): nothing to measure, so keep the last fit —
    // the composer's observer fits it again once it's shown.
    if (!face || face.getBoundingClientRect().height === 0) return
    const roomAbove = Math.floor(liquidPillRoomAbove(face) - CARD_CLEARANCE_PX)
    const height = Math.max(minHeight, Math.min(maxHeight, roomAbove))
    const width =
      maxWidth == null
        ? 0
        : Math.max(minWidth, Math.min(maxWidth, Math.floor(liquidPillRoomLeft(face) - CARD_CLEARANCE_PX)))
    if (height === sizeRef.current.height && width === sizeRef.current.width) return
    sizeRef.current = { height, width }
    setSize(sizeRef.current)
  }, [faceRef, maxHeight, minHeight, maxWidth, minWidth])

  useLayoutEffect(() => {
    if (!enabled) return
    fit()
    window.addEventListener('resize', fit)
    const face = faceRef.current
    const observer = new ResizeObserver(fit)
    const composer = face?.closest('[data-chat-input-root]')
    if (composer) observer.observe(composer)
    const clip = face && liquidPillClipAncestor(face)
    if (clip) observer.observe(clip)
    return () => {
      window.removeEventListener('resize', fit)
      observer.disconnect()
    }
  }, [enabled, fit, faceRef])

  useLayoutEffect(() => {
    if (shown && enabled) fit()
  }, [shown, enabled, fit])

  return size
}

/**
 * A pill in the chat composer's top row whose card RISES out of it — the
 * capture page's Transcripts and Tools. It looks and moves like the top bar's
 * Capture pill (same liquid, height, ring and type — but, like every pill in
 * the composer, the app's own background, not the header's pure white / black),
 * and takes turns with it and every other liquid pill: one card out at a time.
 *
 * Hovering opens the card; leaving both the pill and the card closes it after
 * a moment. A click PINS it open (the pill reads pressed), so a live
 * transcript can be read without holding the pointer there; a second click,
 * Escape, a press outside, or another pill opening puts it away. Keyboard
 * focus opens it too.
 *
 * The card is as tall as the room above the pill allows (up to
 * `cardMaxHeight`) and as wide as the room to its left (up to `cardMaxWidth`),
 * lifts itself over the chat and the windows while it's out (see
 * CAPTURE_CARD_UP_ATTR), and mounts its `children` only while shown and
 * shrinking back. `cardHeader` heads the card and stays mounted while it's
 * shut, for content whose state must outlive a close (a permission prompt's
 * outcome, say, while the OS dialog it opened has focus).
 */
export function ComposerLiquidPill({
  name,
  label,
  icon,
  count,
  title,
  cardLabel,
  cardMaxWidth,
  cardMaxHeight,
  cardHeader,
  children,
}: {
  /** Tags the pill (`data-composer-pill`) for tests and styling hooks. */
  name: string
  /** The pill's word — shown from `md` up; below that the pill is its icon
   *  (and count) alone, the way the top bar's Capture drops its label on a
   *  narrow window. */
  label: string
  icon: ReactNode
  /** A tally after the label; nothing when 0 or absent. */
  count?: number
  /** The pill's tooltip, when there's more to say than its label. */
  title?: string
  cardLabel: string
  cardMaxWidth: number
  cardMaxHeight: number
  /** Heads the card; mounted for the pill's whole life, not just while open. */
  cardHeader?: ReactNode
  children: ReactNode
}) {
  const [open, setOpenState] = useState(false)
  const [pinned, setPinned] = useState(false)
  // Every close — hover-out, Escape, a press outside, another pill taking its
  // turn — also lets go of a pin, so the next hover is a plain hover again.
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    if (!next) setPinned(false)
  }, [])
  const rootRef = useRef<HTMLDivElement>(null)
  const faceRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const { openNow, closeNow, closeSoon, onPointerEnter } = useLiquidPillHover({
    open,
    setOpen,
    held: pinned,
    faceRef,
    cardRef,
  })

  // Escape closes, and so does a press anywhere outside the pill and its card.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNow()
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return
      closeNow()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, closeNow])

  const contentMounted = useCardContentMounted(open)
  const lifted = open || contentMounted
  useRisingCardLift(lifted)
  const { height, width } = useRisingCardFit({
    faceRef,
    enabled: true,
    shown: open,
    maxHeight: cardMaxHeight,
    maxWidth: cardMaxWidth,
  })

  const onClick = () => {
    if (pinned) {
      closeNow()
      return
    }
    openNow()
    setPinned(true)
  }

  const tally = count ? count : null
  return (
    // z-10 keeps the pill above its neighbours at rest; `z-[46]` while its
    // card is up — see CAPTURE_CARD_UP_ATTR.
    <div className={cn('relative shrink-0', lifted ? 'z-[46]' : 'z-10')}>
      <LiquidPill
        ref={rootRef}
        open={open}
        cardSide="top"
        appBackground
        className="inline-flex"
        data-composer-pill={name}
        onFocus={openNow}
        onBlur={(e) => {
          if (pinned) return
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeSoon()
        }}
      >
        <LiquidPillFace ref={faceRef} onPointerEnter={onPointerEnter}>
          <button
            type="button"
            onClick={onClick}
            title={title}
            aria-label={tally == null ? label : `${label} (${tally})`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-pressed={pinned}
            className={cn(
              'flex h-full items-center gap-1.5 rounded-full px-3 text-[12px] transition-colors',
              pinned
                ? 'bg-muted text-sidebar-foreground'
                : 'text-sidebar-foreground/70 hover:bg-muted hover:text-sidebar-foreground',
            )}
          >
            {icon}
            <span className="max-md:hidden">{label}</span>
            {tally != null && <span className="tabular-nums opacity-60">{tally}</span>}
          </button>
        </LiquidPillFace>

        <LiquidPillCard
          ref={cardRef}
          width={width}
          height={height}
          role="dialog"
          aria-label={cardLabel}
          className="rounded-2xl"
        >
          <div className="flex h-full min-h-0 flex-col">
            {cardHeader}
            {contentMounted && <div className="min-h-0 flex-1">{children}</div>}
          </div>
        </LiquidPillCard>
      </LiquidPill>
    </div>
  )
}
