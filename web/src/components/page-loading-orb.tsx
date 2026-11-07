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
 * So this draws the SAME geometry at its true pixel size through the package's
 * `engine` entry — a documented public surface whose painters take the size as
 * an argument. Drawing big is what that geometry was built for: per its own
 * source, "dot radii were tuned for a 300pt frame", and the shipped presets
 * scale DOWN from there. We take the 64px preset's mode, speed and dot profile
 * and hand the painter the size we actually want.
 *
 * WHAT IS RE-IMPLEMENTED FROM THE COMPONENT, AND WHY ONLY THIS MUCH
 *  - Theme resolution and the reduced-motion still frame: both change what is
 *    painted, so they have to be here.
 *  - NOT the shared clock or the IntersectionObserver pause. Those exist so a
 *    screen full of little inline orbs stays cheap and in phase; there is only
 *    ever one of these, and it is the only thing on screen. A hidden tab stops
 *    the animation anyway, because the browser stops serving rAF.
 */

import { MODE_DRAWS, resolvePreset, type OrbState } from 'thinking-orbs/engine'
import { useEffect, useRef, useState } from 'react'

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

export interface PageLoadingOrbProps {
  /** Which animation. Defaults to the state the Knowledge surfaces use. */
  state?: OrbState
  /** Announced to screen readers in place of the per-state default. */
  label?: string
  className?: string
}

/**
 * Fills its parent and centres the orb, so a caller only has to give it a box:
 * `<div className="h-full"><PageLoadingOrb /></div>`, or drop it into an
 * `absolute inset-0` overlay.
 */
export function PageLoadingOrb({
  state = 'weaving',
  label = 'Loading…',
  className,
}: PageLoadingOrbProps) {
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

    // The 64px preset, drawn at `size`: its mode and speed are what the state
    // means, and its dot profile is the denser of the two shipped tunings.
    const { mode, speed, opts } = resolvePreset(state, 64)
    const draw = MODE_DRAWS[mode]

    const paintAt = (t: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)
      draw(ctx, size, t, dark, opts)
    }

    // Reduced motion gets one representative frame, at the same phase the
    // library picks for its own still.
    if (reduced) {
      paintAt(0.6)
      return
    }

    let raf = 0
    const loop = () => {
      paintAt((performance.now() / 1000) * speed)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [state, size, dark, reduced])

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

    const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null
    media?.addEventListener('change', resolve)

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
      media?.removeEventListener('change', resolve)
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

function prefersDark(): boolean {
  return typeof matchMedia === 'undefined' || matchMedia('(prefers-color-scheme: dark)').matches
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  return reduced
}
