'use client'

/**
 * A ThinkingOrb at PAGE scale — the big centred loader a whole surface shows
 * while it has nothing to draw yet.
 *
 * WHY THIS EXISTS RATHER THAN `<ThinkingOrb size={…}>`
 *
 * `thinking-orbs` ships exactly two sizes and types the prop as `64 | 20`,
 * because the two are separate designs rather than one design scaled: each
 * carries its own dot count, dot radius and speed. Passing any other number is
 * a type error, and it is a runtime error too — `resolvePreset` indexes the
 * preset table BY SIZE (`PRESETS[mode][size]`) and would dereference
 * `undefined`.
 *
 * The obvious workaround is to render the 64px orb and blow it up with a CSS
 * transform. That is the wrong one. The component sizes its backing store at
 * `size × min(devicePixelRatio, 2)` — 128 device px at most — so a full-page
 * orb would be a 128px bitmap stretched across ~400 CSS px, and a design made
 * of small round dots is exactly the kind that turns to fuzz under a 3–6×
 * bilinear upscale.
 *
 * So this draws at its true pixel size through the package's `engine` entry, a
 * documented public surface whose painters take the size as an argument.
 *
 * WHICH TUNING, AND WHY IT IS NOT THE 64px PRESET (Liam, 11-21: "it looks
 * warped")
 *
 * The presets scale DOWN from base profiles authored for a 300pt frame: the
 * 64px one keeps about half the dots and fattens them. Drawn at 300–400px,
 * that tuning gave the right dot sizes but half the dots, so the orb broke up
 * into a sparse scatter. The braid ('weaving') made it worse: its three strands
 * reach the poles but only sometimes the sides, and its faint ghost sphere is
 * all but invisible at this size, so the outline read as a lumpy egg that
 * wobbled as it turned. Now: the globe, whose outline is always a circle, at
 * its 300pt base profile, turning slowly. One design, so no `state` prop.
 *
 * WHAT IS RE-IMPLEMENTED FROM THE COMPONENT, AND WHY ONLY THIS MUCH
 *  - Theme resolution and the reduced-motion still frame: both change what is
 *    painted, so they have to be here.
 *  - NOT the shared clock or the IntersectionObserver pause. Those exist so a
 *    screen full of little inline orbs stays cheap and in phase; there is only
 *    ever one of these, and it is the only thing on screen. A hidden tab stops
 *    the animation anyway, because the browser stops serving rAF.
 */

import { MODE_DRAWS, type ModeOpts } from 'thinking-orbs/engine'
import { useEffect, useRef, useState } from 'react'
import { REDUCED_MOTION_QUERY, mediaMatches, prefersReducedMotion, subscribeMedia } from '@/lib/media-query'

/**
 * The size we want when there is room for it, in CSS px.
 *
 * The inline orbs elsewhere in the app are 20px, so this is the "20× bigger"
 * that was asked for, and it is also about as large as the geometry is tuned
 * to go — the dot radii were authored for a 300pt frame.
 */
export const PAGE_ORB_MAX_SIZE = 400
/** Below this the orb reads as a broken graphic rather than a loader. */
const PAGE_ORB_MIN_SIZE = 96
/**
 * Fraction of the container's SHORTER side to fill. Keeps the orb clear of the
 * edges in a short window (a docked panel, a laptop with the inspector open)
 * instead of letting it clip.
 */
const FILL_FRACTION = 0.6
/**
 * Snap the measured size to a step. A canvas resize re-inits the backing store
 * and restarts the paint loop, and without this every pixel of a window drag
 * would do that; with it, a drag re-inits a handful of times.
 */
const SIZE_STEP = 8

/**
 * The globe's base profile from `thinking-orbs` 0.3.1 (`BASE_PROFILES.globe`,
 * which the package does not export), tuned for a 300pt frame: a full grid of
 * small dots at any page size. `dimBase` is the 64px preset's: dots the scan
 * has not reached sit at 45%, so the orb is soft rather than a bright ball.
 * `scanMul` stays at the base 1; the preset's 4.08 sweeps the whole face in
 * under a second: lively at 64px, a strobe at 400px.
 */
const PAGE_GLOBE: ModeOpts = {
  latRings: 17,
  lonDensity: 44,
  rBase: 0.6,
  rDepth: 1.7,
  rBoost: 1,
  inkFar: 0.62,
  inkSpan: 0.54,
  rsPow: 0.6,
  rMin: 0.3,
  scanMul: 1,
  dimBase: 0.45,
}
/**
 * Animation time per second. The 64px preset runs at ~2; at page size the
 * same angular speed moves the front dots ~6× as many pixels per second, so
 * this is slower: a turn every ~10s, a highlight sweep every ~7s.
 */
const PAGE_GLOBE_SPEED = 1.2

export interface PageLoadingOrbProps {
  /** Announced to screen readers. */
  label?: string
  className?: string
}

/**
 * Fills its parent and centres the orb, so a caller only has to give it a box:
 * `<div className="h-full"><PageLoadingOrb /></div>`, or drop it into an
 * `absolute inset-0` overlay.
 */
export function PageLoadingOrb({ label = 'Loading…', className }: PageLoadingOrbProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useFittedSize(boxRef)
  const dark = useIsDark(boxRef)
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    // `size` is null until the box has been measured — nothing to paint into
    // yet, and guessing a size would paint once at the wrong scale.
    if (!canvas || size === null) return

    const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = MODE_DRAWS.globe

    const paintAt = (t: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)
      draw(ctx, size, t, dark, PAGE_GLOBE)
    }

    // Reduced motion gets one representative frame, at the same phase the
    // library picks for its own still.
    if (reduced) {
      paintAt(0.6)
      return
    }

    let raf = 0
    const loop = () => {
      paintAt((performance.now() / 1000) * PAGE_GLOBE_SPEED)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [size, dark, reduced])

  return (
    <div
      ref={boxRef}
      className={`flex h-full w-full items-center justify-center ${className ?? ''}`}
    >
      {size !== null && (
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={label}
          style={{ width: size, height: size }}
        />
      )}
    </div>
  )
}

/**
 * The largest sensible orb for the box we were given, or null before the first
 * measurement.
 *
 * Measured rather than fixed because this renders inside whatever the caller's
 * layout is — a full page, a half-height panel, a narrow column — and a loader
 * that overflows its container and clips looks like a rendering bug, which is
 * the one impression a loading state must not give.
 */
function useFittedSize(ref: React.RefObject<HTMLElement | null>): number | null {
  const [size, setSize] = useState<number | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = () => {
      const { width, height } = el.getBoundingClientRect()
      const shorter = Math.min(width, height)
      // A zero-sized box means the element is display:none or not laid out
      // yet. Keep the last good size rather than collapsing to the minimum and
      // snapping back.
      if (shorter <= 0) return
      const fitted = Math.min(PAGE_ORB_MAX_SIZE, Math.floor((shorter * FILL_FRACTION) / SIZE_STEP) * SIZE_STEP)
      setSize(Math.max(PAGE_ORB_MIN_SIZE, fitted))
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return size
}

/**
 * Resolve the ink for the substrate the orb is sitting on, the same way the
 * library's `theme="auto"` does: nearest ancestor that declares a theme, then
 * the OS preference — and live-update when either changes.
 */
function useIsDark(ref: React.RefObject<HTMLElement | null>): boolean {
  const [dark, setDark] = useState(true)

  useEffect(() => {
    const resolve = () => {
      setDark(nearestDeclaredTheme(ref.current) ?? prefersDark())
    }
    resolve()

    const unsubscribe = subscribeMedia(DARK_QUERY, resolve)

    let observer: MutationObserver | null = null
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(resolve)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme'],
        subtree: true,
      })
    }

    return () => {
      unsubscribe()
      observer?.disconnect()
    }
  }, [ref])

  return dark
}

/** `data-theme` or a `dark`/`light` class on the element or any ancestor. */
function nearestDeclaredTheme(from: HTMLElement | null): boolean | null {
  let el: HTMLElement | null = from
  while (el) {
    const attr = el.getAttribute('data-theme')
    if (attr === 'dark') return true
    if (attr === 'light') return false
    if (el.classList.contains('dark')) return true
    if (el.classList.contains('light')) return false
    el = el.parentElement
  }
  return null
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

function prefersDark(): boolean {
  return mediaMatches(DARK_QUERY, true)
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const sync = () => setReduced(prefersReducedMotion())
    sync()
    return subscribeMedia(REDUCED_MOTION_QUERY, sync)
  }, [])

  return reduced
}
