'use client'

import { useEffect, useRef, useState } from 'react'
import { useWindowPropertiesVisible } from './window-properties'

/**
 * Panel width below which the properties sidebar steps aside.
 *
 * Derived from the sidebar's 289px plus the NARROWEST content column still
 * worth reading (~420px), not from the content's 736px maximum — the content
 * compresses happily, so keying off its max would drop the sidebar on ordinary
 * window sizes where both fit fine.
 */
const MIN_CONTENT_WIDTH = 420
const SIDEBAR_WIDTH = 289
export const PROPERTIES_MIN_WIDTH = SIDEBAR_WIDTH + MIN_CONTENT_WIDTH // 709

/**
 * Hysteresis band. Showing and hiding at the SAME width makes a window parked
 * on the boundary flicker: hiding the sidebar widens the content, which can
 * re-satisfy the show condition, which hides it again. Requiring a little extra
 * width to come back breaks that loop.
 */
const HYSTERESIS = 40

/**
 * Whether properties are visible. In a card in the chat this follows the
 * card's Properties popover (window-properties.tsx). Standalone surfaces
 * retain their width-driven sidebar.
 *
 * Replaces a manual toggle: the sidebar is always up when there's room for it
 * and steps aside when there isn't, coming back on its own when the window
 * grows again.
 *
 * @param ref     Element whose width decides — the panel body, not the window,
 *                so a collapsed nav or a narrow split view counts too.
 * @param locked  Keeps the sidebar visible regardless of width. The push
 *                compose form lives inside it, and unmounting that form on a
 *                resize would silently discard everything typed into it.
 */
export function usePropertiesVisible(
  ref: React.RefObject<HTMLElement | null>,
  locked = false,
): boolean {
  const windowVisible = useWindowPropertiesVisible()
  // Start visible: the common case is a wide window, and appearing is far less
  // jarring than a sidebar that flashes in on mount.
  const [visible, setVisible] = useState(true)
  // The element being watched, and how to stop watching it.
  const watching = useRef<{ el: HTMLElement; stop: () => void } | null>(null)

  // After EVERY commit, not once on mount: the element can arrive after the
  // first render. A detail panel shows a loading state until its entity is in,
  // and only then mounts the body this ref points at — a watch set up on mount
  // found nothing, never ran again (the ref object never changes), and left
  // the sidebar up at any width. Costs a comparison per render; nothing is
  // done unless the element itself changed.
  useEffect(() => {
    if (windowVisible !== null) {
      watching.current?.stop()
      watching.current = null
      return
    }
    const el = ref.current
    if (watching.current?.el === el) return
    watching.current?.stop()
    watching.current = null
    if (!el || typeof ResizeObserver === 'undefined') return

    const measure = () => {
      const width = el.getBoundingClientRect().width
      // Width 0 means display:none or an unmounted subtree — not a real answer,
      // so don't let it collapse the sidebar.
      if (width === 0) return
      setVisible((wasVisible) =>
        wasVisible ? width >= PROPERTIES_MIN_WIDTH : width >= PROPERTIES_MIN_WIDTH + HYSTERESIS,
      )
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    watching.current = { el, stop: () => ro.disconnect() }
  })

  // …and stop for good when the panel goes away.
  useEffect(() => () => {
    watching.current?.stop()
    watching.current = null
  }, [])

  return locked || (windowVisible ?? visible)
}
