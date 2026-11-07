'use client'

/**
 * Small pointer-drag resize hook with localStorage persistence — a hand-rolled
 * resize handle rather than pulling the panel-group lib into a non-split-pane
 * layout.
 *
 * Returns the current size plus a `startResize` handler to wire onto a thin
 * drag handle. `axis` decides which delta drives the size and its sign:
 *   - 'x-left'  → handle on the panel's LEFT edge; dragging left grows it
 *                 (used for a right-docked side panel)
 *   - 'y-top'   → handle on the panel's TOP edge; dragging up grows it
 *                 (used for a bottom-docked drawer)
 *
 * COMMIT-ON-RELEASE: a drag never calls setState and never touches
 * localStorage. Each pointermove only stashes the clamped px value; a
 * rAF-coalesced (latest-wins) writer puts it straight onto the panel element's
 * inline style, so a 1,400-line editor tree is not re-rendered per frame.
 * pointerup commits the final value to state + ONE localStorage write.
 *
 * The panel element is resolved from the handle itself (the handle is an
 * absolutely-positioned child of the panel root at both call sites), so the
 * hook needs no extra ref plumbing through the consumer.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

type Axis = 'x-left' | 'y-top'

export function useResizable(opts: {
  storageKey: string
  defaultSize: number
  min: number
  max: number
  axis: Axis
}) {
  const { storageKey, defaultSize, min, max, axis } = opts

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max])

  // Read the persisted size in a lazy initializer. Guarded for SSR (no window);
  // the server renders the default and the client hydrates to the same value
  // because this runs during the client's first render too.
  const [size, setSize] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultSize
    try {
      const stored = window.localStorage.getItem(storageKey)
      if (stored != null) {
        const n = Number(stored)
        if (Number.isFinite(n)) return Math.min(max, Math.max(min, n))
      }
    } catch {
      /* ignore storage errors */
    }
    return defaultSize
  })

  const drag = useRef<{ start: number; origin: number } | null>(null)
  // The value the DOM is showing right now. Equal to `size` outside a drag; the
  // authoritative value DURING one, so a mid-drag re-render of the editor keeps
  // rendering the dragged size instead of snapping back to the committed state.
  // Re-synced during render (not an effect) so `size` below is right on the very
  // pass that reads it.
  const live = useRef(size)
  if (drag.current == null) live.current = size

  // Teardown for the drag currently in flight (listeners + body styles), so a
  // drag can be ended by something other than its own pointerup: an unmount, or
  // a fresh pointerdown after a pointerup that never reached us (released
  // outside the window). Without it those listeners stack for the session.
  const endDrag = useRef<(() => void) | null>(null)

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      endDrag.current?.()
      // `live` still equals the committed state here (commit-on-release keeps
      // the two in sync between drags), so the origin stays correct.
      const origin = live.current
      drag.current = {
        start: axis === 'x-left' ? e.clientX : e.clientY,
        origin,
      }
      const target = e.currentTarget.parentElement as HTMLElement | null
      const prop = axis === 'x-left' ? 'width' : 'height'

      // Suppress text selection and lock the cursor for the whole drag, even
      // when the pointer leaves the thin handle.
      const prevUserSelect = document.body.style.userSelect
      const prevCursor = document.body.style.cursor
      document.body.style.userSelect = 'none'
      document.body.style.cursor = axis === 'x-left' ? 'col-resize' : 'row-resize'

      let frame: number | null = null
      const paint = () => {
        frame = null
        if (target) target.style[prop] = `${live.current}px`
      }

      const onMove = (ev: PointerEvent) => {
        const d = drag.current
        if (!d) return
        const cur = axis === 'x-left' ? ev.clientX : ev.clientY
        // Both axes grow when dragging toward the panel's interior, so the
        // delta is negated (left edge: smaller clientX = wider; top edge:
        // smaller clientY = taller).
        live.current = clamp(d.origin + (d.start - cur))
        // Latest-wins: one paint per frame no matter how many moves land.
        if (frame == null && typeof requestAnimationFrame === 'function') {
          frame = requestAnimationFrame(paint)
        }
      }
      // Returns false when this drag was already ended (superseded or
      // unmounted), so a late pointerup can't commit on top of it.
      const teardown = () => {
        if (endDrag.current !== teardown) return false
        endDrag.current = null
        drag.current = null
        if (frame != null) {
          cancelAnimationFrame(frame)
          frame = null
        }
        document.body.style.userSelect = prevUserSelect
        document.body.style.cursor = prevCursor
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        return true
      }
      const onUp = () => {
        const final = live.current
        if (!teardown()) return
        // Land the DOM on the exact committed value so the state commit below
        // is a no-op paint rather than a one-frame snap.
        if (target) target.style[prop] = `${final}px`
        setSize(final)
        try {
          localStorage.setItem(storageKey, String(final))
        } catch {
          /* ignore storage errors */
        }
      }
      endDrag.current = teardown
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [axis, clamp, storageKey],
  )

  // A drag in flight when the editor unmounts must not leave its window
  // listeners (or the locked body cursor) behind — and must NOT commit, since
  // that would setState on an unmounted component.
  useEffect(
    () => () => {
      endDrag.current?.()
    },
    [],
  )

  return {
    // Committed state normally; the live drag value if the editor re-renders
    // mid-drag, so React's paint agrees with the one the drag loop just made
    // instead of snapping the panel back.
    size: drag.current != null ? live.current : size,
    startResize,
    isResizing: () => drag.current != null,
  }
}
