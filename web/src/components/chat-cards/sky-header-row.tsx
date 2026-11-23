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
 * It is the page's controls' size container (a calendar sheds controls as it
 * narrows: calendar-header.tsx). Interactive's width in the controls' pill is
 * kept out of that room (`--sky-reserve`: the row's right padding, the pill's
 * negative margin, so the pills stay where they are), as the capsule it was
 * beside the header used to be, so the page's controls shed in time.
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
import { LISTEN_HEADER_ATTR } from '@/components/read-aloud/listen-mode-toggle'

/** The rail's header's height (its 32px buttons, p-1, the 1px edge): the pills match it. */
export const SKY_HEADER_H = 42
/** The gap after the rail's header, as the top bar's controls keep (top-bar.tsx). */
const AFTER_RAIL_HEADER_PX = 8
/** Interactive's room in the controls' pill beyond its own box: its right margin (4px) and the pill's gap (2px). */
const RESERVE_EXTRA_PX = 6
/** The variable the row's right padding and the controls' pill's negative margin read (show-tool-card.tsx). */
export const SKY_RESERVE_VAR = '--sky-reserve'

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
    // Interactive in the controls' pill: its width, out of the page's controls' room.
    const reserve = () => {
      const toggle = row.querySelector<HTMLElement>(`[${LISTEN_HEADER_ATTR}]`)
      const w = toggle ? toggle.getBoundingClientRect().width : 0
      row.style.setProperty(SKY_RESERVE_VAR, `${w > 0 ? Math.round(w) + RESERVE_EXTRA_PX : 0}px`)
    }
    const measureAll = () => {
      measure()
      reserve()
    }
    measureAll()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureAll)
    for (const el of [column, column.parentElement, rail]) if (el) observer?.observe(el)
    // It comes and goes (something to read, or not) and changes width (Next, the mic): watched as the header's content changes.
    let watched: Element | null = null
    const watch = () => {
      const toggle = row.querySelector(`[${LISTEN_HEADER_ATTR}]`)
      if (toggle !== watched) {
        if (watched) observer?.unobserve(watched)
        watched = toggle
        if (toggle) observer?.observe(toggle)
      }
      reserve()
    }
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(watch)
    mutations?.observe(row, { childList: true, subtree: true })
    watch()
    return () => {
      observer?.disconnect()
      mutations?.disconnect()
    }
  }, [])

  return (
    <div
      ref={rowRef}
      {...rest}
      {...{ [FULL_SCREEN_CONTROL_ATTR]: '', [TILE_FLIGHT_RIDER_ATTR]: '' }}
      // A container, as the header was, so a page's controls can shed as the card narrows (the calendar's).
      // z-20: above the card, so a menu a page drops from its header without a portal (Studio's More) opens over the page.
      className={cn('@container pointer-events-none absolute inset-x-0 z-20 flex items-center gap-2 pr-[var(--sky-reserve,0px)]', rest.className)}
      style={ROW_STYLE}
    >
      {children}
    </div>
  )
}
