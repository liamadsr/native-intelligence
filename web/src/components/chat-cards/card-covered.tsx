'use client'

import * as React from 'react'
import { PropertiesScope } from '@/components/views/window-properties'
import { cardFrameOf } from './card-history'

/** Where the focus is, unless it fell to <body> (or nowhere). */
function focusedElement(): HTMLElement | null {
  const active = document.activeElement
  return active instanceof HTMLElement && active !== document.body ? active : null
}

/**
 * The page under something opened over it inside a card (a record, a run, a
 * board), as a window kept a list under its detail on main: still mounted, so
 * every data listener in it keeps running, but `invisible`, which lets the
 * overlay stay TRANSPARENT (the card's glass shows through it, as through
 * every page) instead of painting an opaque background over the glass. Inert
 * and out of the Properties popover while covered.
 *
 * Inert drops the focus inside it to <body>, where ⌘/Ctrl+[ no longer finds
 * the card: the overlay takes it (CardOverlay), and once the overlay goes the
 * focus returns to what had it here (the row that opened it), else the card.
 */
export function CardCovered({ covered, children }: { covered: boolean; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const returnTo = React.useRef<HTMLElement | null>(null)
  const wasCovered = React.useRef(covered)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (covered === wasCovered.current || !el) return
    wasCovered.current = covered
    if (covered) {
      const active = focusedElement()
      returnTo.current = active && el.contains(active) ? active : null
      return
    }
    const back = returnTo.current
    returnTo.current = null
    if (focusedElement()) return
    const target = back?.isConnected && el.contains(back) ? back : cardFrameOf(el)
    target?.focus({ preventScroll: true })
  }, [covered])
  return (
    <div ref={ref} className={covered ? 'invisible h-full min-h-0' : 'h-full min-h-0'} inert={covered || undefined} aria-hidden={covered || undefined}>
      <PropertiesScope available={!covered}>{children}</PropertiesScope>
    </div>
  )
}

/** What opens over a page inside a card: transparent, over the page's glass. */
export const CARD_OVERLAY = 'absolute inset-0 z-10 flex flex-col'

/**
 * The layer over a covered page (CARD_OVERLAY). It takes the focus when it
 * opens if the page under it held it (now inert) or it fell to <body>, so the
 * card keeps the keys; a focus elsewhere (the header's Forward) stays put.
 */
export function CardOverlay({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const active = focusedElement()
    if (active && !active.closest('[inert]')) return
    el.focus({ preventScroll: true })
  }, [])
  return (
    <div ref={ref} tabIndex={-1} className={`${CARD_OVERLAY} outline-none`}>
      {children}
    </div>
  )
}
