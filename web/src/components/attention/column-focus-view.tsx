'use client'

/**
 * A For you card's focus view (Liam, 10-16: click a card and "it should do
 * this"): the card stays where it stood and grows in place (its sentence,
 * then a divider and its details, or its full card when a menu row asks for
 * the controls), everything else on screen goes soft behind a blur, and a
 * narrower menu card floats beside it with the card's other verbs: on its
 * left, level with its header, so it stands in the same place whatever the
 * card's height (Liam, 11-20). Esc, a click on the blur, or a verb that
 * settles the card closes it.
 *
 * A dialog (labelled with the card's words) with its focus kept inside while
 * open, given back to the card after. Placed from the card's box when it
 * opens, again when the window resizes or the card or menu change size (a
 * full card mounting), never per frame: the card keeps its top unless it or
 * its menu would run off the bottom. Where there is no room on the card's
 * left (a narrow window), the menu goes below the card, or above it when
 * there is no room below.
 *
 * Mounted only while open. The blur over the whole page is a full-viewport
 * backdrop-filter, costly over the moving sky in WebKit (card-skin.ts), so
 * the sky is held still meanwhile (a sky-activity hold, released on close).
 * Reduced motion: no lift.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { skyActivity } from '@/lib/sky/sky-activity'
import { cn } from '@/lib/utils'

/** The space kept clear at the window's edges, px. */
export const FOCUS_EDGE_PX = 12
/** The gap between the card and its menu, px. */
export const FOCUS_MENU_GAP_PX = 8
/** The menu's width when it stands on the card's left, px (`w-60`, 15rem). */
export const FOCUS_MENU_WIDTH_PX = 240
/**
 * Room round the card inside its scroll box for the card's own shadow, px
 * (taken back by a negative margin, so the card stands where it did): a scroll
 * box clips at its edge, and a shadow cut there showed as square corners past
 * the card's round ones (Liam, 10-19).
 */
export const FOCUS_SHADOW_ROOM_PX = 16
/** The sky-activity hold the focus view keeps while open. */
export const FOCUS_SKY_HOLD = 'for-you-focus'
/** The blur everything else goes soft behind: the focus view's, and the chat's while a card waits as its Reply chip (card-reply-chip.tsx). */
export const FOCUS_BACKDROP_CLASS =
  'bg-black/10 backdrop-blur-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 dark:bg-black/35'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Where the menu stands: on the card's left, level with its header; else below it, or above it. */
export type FocusMenuSide = 'left' | 'below' | 'above'

export interface FocusPlace {
  top: number
  left: number
  width: number
  menu: FocusMenuSide
  /** The tallest the card may be (it scrolls past it), so card and menu stay on screen. */
  maxHeight: number
}

/**
 * Where the focused card and its menu go, from the card's box in the column
 * (`anchor`), their measured heights and the window's height. The menu on the
 * card's left, level with its top, when it fits there: the card at its own
 * top unless it or the menu would run off the bottom, then moved up just
 * enough. Else stacked: the card at its own top unless card and menu would
 * run off the bottom; then the menu above when it fits there, else the card
 * moved up just enough (never past the top edge). Pure, for the tests.
 */
export function placeFocus(
  anchor: { top: number; left: number; width: number },
  cardHeight: number,
  menuHeight: number,
  viewportHeight: number,
): FocusPlace {
  const bottomEdge = viewportHeight - FOCUS_EDGE_PX
  if (menuHeight > 0 && anchor.left - FOCUS_MENU_GAP_PX - FOCUS_MENU_WIDTH_PX >= FOCUS_EDGE_PX) {
    // Beside the card, the menu takes none of its height.
    const maxHeight = Math.max(0, viewportHeight - FOCUS_EDGE_PX * 2)
    const tallest = Math.max(Math.min(cardHeight, maxHeight), menuHeight)
    const top = Math.max(FOCUS_EDGE_PX, Math.min(anchor.top, bottomEdge - tallest))
    return { top, left: anchor.left, width: anchor.width, menu: 'left', maxHeight }
  }
  const menu = menuHeight > 0 ? menuHeight + FOCUS_MENU_GAP_PX : 0
  const maxHeight = Math.max(0, viewportHeight - FOCUS_EDGE_PX * 2 - menu)
  const height = Math.min(cardHeight, maxHeight)
  const at = { left: anchor.left, width: anchor.width, maxHeight }
  const top = Math.max(FOCUS_EDGE_PX, anchor.top)
  if (top + height + menu <= bottomEdge) return { ...at, top, menu: 'below' }
  // The menu above, when the card stays on screen and the menu fits over it.
  const cardTop = Math.max(FOCUS_EDGE_PX, Math.min(top, bottomEdge - height))
  if (menu > 0 && cardTop - menu >= FOCUS_EDGE_PX) return { ...at, top: cardTop, menu: 'above' }
  // Neither fits as it stands: the card moves up so the menu fits below.
  return { ...at, top: Math.max(FOCUS_EDGE_PX, bottomEdge - height - menu), menu: 'below' }
}

/** The menu's box against the dialog's (the card's): beside it on the left, level with its top; or under or over it. */
function menuStyle(side: FocusMenuSide | undefined): CSSProperties {
  if (side === 'left') return { top: 0, right: `calc(100% + ${FOCUS_MENU_GAP_PX}px)`, width: FOCUS_MENU_WIDTH_PX }
  if (side === 'above') return { left: 0, bottom: `calc(100% + ${FOCUS_MENU_GAP_PX}px)` }
  return { left: 0, top: `calc(100% + ${FOCUS_MENU_GAP_PX}px)` }
}

export function ColumnFocusView({
  anchorRef,
  label,
  onClose,
  card,
  menu,
}: {
  /** The card in the column: where the focused card stands, and where focus goes back to. */
  anchorRef: RefObject<HTMLElement | null>
  /** The dialog's accessible name (the card's words). */
  label: string
  onClose: () => void
  /** The focused card, grown. */
  card: ReactNode
  /** The menu card with the other verbs (null: none). */
  menu: ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<FocusPlace | null>(null)

  const measure = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect()
    if (!anchor) return
    const next = placeFocus(
      { top: anchor.top, left: anchor.left, width: anchor.width },
      // Its whole height (scrollHeight: past a cap it scrolls, but its content is still this tall), less its shadow's room.
      Math.max(0, (cardRef.current?.scrollHeight ?? 0) - FOCUS_SHADOW_ROOM_PX * 2),
      menuRef.current?.offsetHeight ?? 0,
      window.innerHeight,
    )
    setPlace((was) =>
      was && was.top === next.top && was.left === next.left && was.width === next.width && was.menu === next.menu && was.maxHeight === next.maxHeight
        ? was
        : next,
    )
  }, [anchorRef])

  // Placed before the first paint, and again on a resize of the window or of what it shows.
  useLayoutEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    const RO = typeof ResizeObserver === 'undefined' ? null : ResizeObserver
    const observer = RO ? new RO(measure) : null
    if (cardRef.current) observer?.observe(cardRef.current)
    if (menuRef.current) observer?.observe(menuRef.current)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [measure])

  // The sky holds still behind the blur while it's open.
  useEffect(() => {
    skyActivity.setHold(FOCUS_SKY_HOLD, true)
    return () => skyActivity.setHold(FOCUS_SKY_HOLD, false)
  }, [])

  // Focus moves in as it opens and goes back to the card in the column as it closes.
  useEffect(() => {
    const anchor = anchorRef.current
    dialogRef.current?.focus({ preventScroll: true })
    return () => {
      if (anchor?.isConnected) anchor.focus({ preventScroll: true })
    }
  }, [anchorRef])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // A menu or picker open inside it takes its own Escape first (it marks the event).
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    // Focus kept inside: a picker portalled out of it (a popover) keeps its own.
    const active = document.activeElement
    if (active && active !== dialog && !dialog.contains(active)) return
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    // z-50, the popovers' own: a picker the full card opens portals in after it and stands above.
    // `ph-no-capture`: portalled out of the For you column, so it carries its
    // own; session replay blocks the full card (a draft's subject and brief).
    <div data-column-focus="" className="ph-no-capture fixed inset-0 z-50 font-sans" onKeyDown={onKeyDown}>
      <div
        aria-hidden
        data-column-focus-backdrop=""
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
        className={cn('absolute inset-0', FOCUS_BACKDROP_CLASS)}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-column-focus-dialog=""
        className="absolute outline-none"
        style={{
          top: place?.top ?? 0,
          left: place?.left ?? 0,
          width: place?.width ?? undefined,
          // Measured before it shows (the first layout pass places it).
          visibility: place ? undefined : 'hidden',
        }}
      >
        {/* Its shadow's room round it: never a press (one there falls through to the blur, which closes it). */}
        <div
          ref={cardRef}
          data-column-focus-card=""
          className="pointer-events-none overflow-y-auto overscroll-contain motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.98] motion-safe:duration-150"
          style={{
            padding: FOCUS_SHADOW_ROOM_PX,
            margin: -FOCUS_SHADOW_ROOM_PX,
            ...(place ? { maxHeight: place.maxHeight + FOCUS_SHADOW_ROOM_PX * 2 } : {}),
          }}
        >
          <div className="pointer-events-auto">{card}</div>
        </div>
        {menu && (
          <div
            ref={menuRef}
            data-column-focus-menu={place?.menu ?? 'below'}
            className="absolute w-[min(15rem,100%)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150"
            style={menuStyle(place?.menu)}
          >
            {menu}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
