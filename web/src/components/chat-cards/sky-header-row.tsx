'use client'

/**
 * A full-screen page's header beside the app rail, up on the sky (Liam, 11-23:
 * "Lets try G"): not a row inside the card but two glass pills above it, in
 * the window's top row, level with the rail's header (rail/app-rail.tsx), as
 * the top bar's own pills are. The title's pill at the card's left edge (past
 * the rail's header when the side panel is closed and the card starts under
 * it), the controls' pill at its right edge.
 *
 * Drawn inside the card's column (show-tool-card.tsx), so it is as wide as the
 * card and moves with it; its top and left inset are measured from the rail's
 * header, the one thing it lines up with. Interactive (listen mode) is in its
 * controls' pill (show-tool-card.tsx), not a capsule of its own beside it. The
 * row lets presses through (the top bar under it stays a drag surface in the
 * Mac app); its pills take them.
 *
 * It rides the card's flight into its tile and back (TILE_FLIGHT_RIDER_ATTR,
 * lib/chat/tile-flight.ts), so it never stays behind the card as it goes.
 *
 * Flat cost: measured again only when the column, its stage (the layer moves
 * the card without resizing it when the side panel or a call's column comes
 * and goes) or the rail's header resizes.
 */
import * as React from 'react'
import { cn } from '@/lib/utils'
import { COLUMN_CARD_SKIN } from '@/components/attention/card-skin'
import { FULL_SCREEN_CONTROL_ATTR } from './outside-card-press'
import { TILE_FLIGHT_RIDER_ATTR } from '@/lib/chat/tile-flight'

/** The rail's header's height (its 32px buttons, p-1, the 1px edge): the pills match it. */
export const SKY_HEADER_H = 42
/** The gap after the rail's header, as the top bar's controls keep (top-bar.tsx). */
const AFTER_RAIL_HEADER_PX = 8

/** One pill: the rail's header's glass, edge and round ends. */
export const SKY_PILL = cn('pointer-events-auto flex h-full items-center rounded-full border border-border/60', COLUMN_CARD_SKIN)

/** First paint, before the measure (the layout effect runs before it anyway): the same arithmetic in CSS. */
const ROW_STYLE: React.CSSProperties = {
  height: SKY_HEADER_H,
  top: `calc(var(--app-header-bottom, ${SKY_HEADER_H + 3}px) - ${SKY_HEADER_H}px - var(--card-panel-top, 50px))`,
}

export function SkyHeaderRow({ children, ...rest }: { children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const rowRef = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    const row = rowRef.current
    const column = row?.parentElement
    if (!row || !column) return
    const rail = document.querySelector<HTMLElement>('[data-app-rail-header]')
    const measure = () => {
      const r = rail?.getBoundingClientRect()
      const c = column.getBoundingClientRect()
      if (!r || r.height === 0) {
        row.style.removeProperty('top')
        row.style.paddingLeft = '0px'
        return
      }
      row.style.top = `${Math.round(r.top - c.top)}px`
      row.style.paddingLeft = `${Math.max(0, Math.round(r.right + AFTER_RAIL_HEADER_PX - c.left))}px`
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    for (const el of [column, column.parentElement, rail]) if (el) observer?.observe(el)
    return () => observer?.disconnect()
  }, [])

  return (
    <div
      ref={rowRef}
      {...rest}
      {...{ [FULL_SCREEN_CONTROL_ATTR]: '', [TILE_FLIGHT_RIDER_ATTR]: '' }}
      // A container, as the header was, so a page's controls can shed as the card narrows (the calendar's).
      // z-20: above the card, so a menu a page drops from its header without a portal (Studio's More) opens over the page.
      className={cn('@container pointer-events-none absolute inset-x-0 z-20 flex items-center gap-2', rest.className)}
      style={ROW_STYLE}
    >
      {children}
    </div>
  )
}
