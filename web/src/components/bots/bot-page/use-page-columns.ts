'use client'

/**
 * Whether a bot's page has room for its two columns, Chat and Work
 * (docs/plans/bots-v4.md: "A narrow window shows them as two tabs"). Measured
 * on the page itself, not the viewport: the page lives in a window that is
 * maximized when its tab opens (teammate-chat-tab.ts) and can be dragged down
 * to a floating card's width (480 px at the least, ~550 px on a 1440 px
 * screen: use-window-geometry.ts), which is too narrow for both.
 *
 * Always the page's own laid-out width, never its width on screen
 * (getBoundingClientRect). A window gliding to a snap, a restore or a landing
 * has its box written once at its final size and is then drawn scaled from
 * the old one (use-window-geometry.ts glideTo). A window receding in the
 * stack is drawn scaled down for good (content-windows.tsx). The
 * ResizeObserver fires once, as the box changes, so a transformed width read
 * then would stick. The first measure is `clientWidth`; later ones are each
 * entry's `contentRect` (the page has no padding, so the two agree). The
 * first measure is taken before the browser paints (a layout effect), so a
 * narrow card never shows one frame of two columns.
 */
import { useLayoutEffect, useState, type RefObject } from 'react'

/**
 * The page width two columns need: a chat column still worth writing in with
 * the main composer (~440 px) beside the work column on its right (20rem at
 * the least: 36% of the page, between 20 and 25rem). Narrower than this, the
 * page shows Chat and Work as tabs.
 */
export const BOT_PAGE_COLUMNS_MIN_PX = 760

/**
 * The same with an item open (Phase 2): its column is wider (22rem at the
 * least: 46% of the page, between 22 and 34rem, for the work item panel's
 * narrow layout) beside the same chat column.
 */
export const BOT_PAGE_ITEM_COLUMNS_MIN_PX = 800

/**
 * Going back to two columns takes this much more room than staying in them:
 * one width for both would flicker a window parked on the edge (the tabs'
 * row takes height, not width, so nothing else moves it back).
 */
const HYSTERESIS_PX = 40

/**
 * True while the element is wide enough for both columns (`minPx` of it).
 * Starts true: a page opens maximized. Another `minPx` (an item opening or
 * closing) measures again at once, from the same laid-out width.
 */
export function usePageColumns(ref: RefObject<HTMLElement | null>, minPx: number = BOT_PAGE_COLUMNS_MIN_PX): boolean {
  const [columns, setColumns] = useState(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = (width: number) => {
      // Zero: display:none, or a subtree not laid out yet. Not a real width.
      if (!(width > 0)) return
      setColumns((had) => (had ? width >= minPx : width >= minPx + HYSTERESIS_PX))
    }
    apply(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) if (entry.target === el) apply(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, minPx])
  return columns
}
