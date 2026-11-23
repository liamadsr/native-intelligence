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
 * header, the one thing it lines up with. Its right end keeps clear of the
 * Interactive capsule (listen mode, show-tool-card.tsx FullScreenInteractive),
 * which stands in the same row at the window's right while it shows. The row
 * lets presses through (the top bar under it stays a drag surface in the Mac
 * app); its pills take them.
 *
 * It rides the card's flight into its tile and back (TILE_FLIGHT_RIDER_ATTR,
 * lib/chat/tile-flight.ts), so it never stays behind the card as it goes.
 *
 * Flat cost: measured again only when the column, its stage (the layer moves
 * the card without resizing it when the side panel or a call's column comes
 * and goes), the rail's header or the Interactive capsule resizes.
 */
import * as React from 'react'
import { cn } from '@/lib/utils'
import { COLUMN_CARD_SKIN } from '@/components/attention/card-skin'
import { FULL_SCREEN_CONTROL_ATTR } from './outside-card-press'
import { TILE_FLIGHT_RIDER_ATTR } from '@/lib/chat/tile-flight'

/** The rail's header's height (its 32px buttons, p-1, the 1px edge): the pills match it. */
export const SKY_HEADER_H = 42
/** The gap after the rail's header, and before the Interactive capsule, as the top bar's controls keep (top-bar.tsx). */
const AFTER_RAIL_HEADER_PX = 8
/** On the Interactive capsule over a full-screen page (show-tool-card.tsx FullScreenInteractive). */
export const FULL_SCREEN_INTERACTIVE_ATTR = 'data-full-screen-interactive'

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
    const interactive = document.querySelector<HTMLElement>(`[${FULL_SCREEN_INTERACTIVE_ATTR}]`)
    const measure = () => {
      const r = rail?.getBoundingClientRect()
      const c = column.getBoundingClientRect()
      if (!r || r.height === 0) {
        row.style.removeProperty('top')
        row.style.paddingLeft = '0px'
        row.style.paddingRight = '0px'
        return
      }
      row.style.top = `${Math.round(r.top - c.top)}px`
      row.style.paddingLeft = `${Math.max(0, Math.round(r.right + AFTER_RAIL_HEADER_PX - c.left))}px`
      // The Interactive capsule, while it shows (it hides itself when there is nothing to read).
      const i = interactive?.getBoundingClientRect()
      const shown = !!i && i.width > 0 && i.height > 0
      row.style.paddingRight = shown ? `${Math.max(0, Math.round(c.right - i.left + AFTER_RAIL_HEADER_PX))}px` : '0px'
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    for (const el of [column, column.parentElement, rail, interactive]) if (el) observer?.observe(el)
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
