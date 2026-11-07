'use client'

/**
 * DotGlyph — a small, self-contained dot-field primitive used as the app's
 * signature visual accent.
 *
 * Design goals:
 *  - Theme-aware: colors derive from the resolved `currentColor` of the host
 *    element, so callers tune appearance purely with text-color utilities
 *    (e.g. `text-sidebar-foreground/[0.045]`). No hard-coded palette.
 *  - Dependency-light: a single <canvas> driven by requestAnimationFrame.
 *    Deliberately avoids CSS @keyframes (the codebase's loader keyframes are
 *    not all defined) so motion is guaranteed and self-contained.
 *  - Respectful: honors `prefers-reduced-motion` (renders a still field) and
 *    pauses when the tab is hidden.
 *
 * Three modes:
 *  - `ambient` — a faint field of dots drifting slowly. Background texture.
 *  - `pulse`   — a tight cluster breathing in/out. A "thinking" indicator.
 *  - `ripple`  — dots displaced outward from a point, settling back. Hover.
 *
 * It is purely presentational and holds no app state, so it can be dropped
 * anywhere and removed without side effects.
 */

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

export type DotGlyphMode = 'ambient' | 'pulse' | 'ripple'

interface DotGlyphProps {
  mode?: DotGlyphMode
  /** Spacing between dots in CSS pixels. Larger = sparser field. */
  gap?: number
  /** Dot radius in CSS pixels. */
  dotRadius?: number
  /** Animation speed multiplier (1 = default). */
  speed?: number
  /**
   * For `ripple`: the impulse origin in [0..1] element-relative coordinates.
   * Updating this prop fires a new ripple from that point.
   */
  origin?: { x: number; y: number } | null
  className?: string
}

interface Dot {
  /** Home position (grid), in device pixels. */
  hx: number
  hy: number
  /** Per-dot phase offset so the field doesn't pulse in lockstep. */
  phase: number
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Read the host element's resolved color so dots inherit `currentColor`. */
function resolveColor(el: HTMLElement): string {
  const c = getComputedStyle(el).color
  return c || 'rgba(127,127,127,0.4)'
}

export function DotGlyph({
  mode = 'ambient',
  gap = 22,
  dotRadius = 1.1,
  speed = 1,
  origin = null,
  className,
}: DotGlyphProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Latest ripple impulse, consumed by the animation loop.
  const rippleRef = useRef<{ x: number; y: number; t: number } | null>(null)

  // Fire a ripple whenever `origin` changes to a non-null value.
  useEffect(() => {
    if (mode !== 'ripple' || !origin) return
    rippleRef.current = { x: origin.x, y: origin.y, t: 0 }
  }, [origin, mode])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = prefersReducedMotion()
    let dots: Dot[] = []
    let dpr = 1
    let width = 0
    let height = 0
    let color = resolveColor(wrap)
    let raf = 0
    let start = 0
    let running = true

    function buildDots() {
      width = wrap!.clientWidth
      height = wrap!.clientHeight
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas!.width = Math.max(1, Math.floor(width * dpr))
      canvas!.height = Math.max(1, Math.floor(height * dpr))
      color = resolveColor(wrap!)

      const g = gap * dpr
      const cols = Math.ceil((width * dpr) / g) + 1
      const rows = Math.ceil((height * dpr) / g) + 1
      dots = []
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          dots.push({ hx: c * g, hy: r * g, phase: c * 0.7 + r * 1.3 })
        }
      }
    }

    function draw(now: number) {
      if (!running) return
      if (!start) start = now
      const t = ((now - start) / 1000) * speed
      const g = gap * dpr
      const baseR = dotRadius * dpr

      ctx!.clearRect(0, 0, canvas!.width, canvas!.height)

      const ripple = rippleRef.current
      if (ripple) {
        ripple.t += 0.016 * speed
        if (ripple.t > 1.4) rippleRef.current = null
      }

      for (const d of dots) {
        let dx = 0
        let dy = 0
        let alpha = 0.5
        let r = baseR

        if (mode === 'ambient') {
          if (!reduced) {
            dx = Math.sin(t * 0.5 + d.phase) * (g * 0.08)
            dy = Math.cos(t * 0.4 + d.phase * 1.1) * (g * 0.08)
          }
          alpha = 0.35 + (reduced ? 0 : 0.25 * (0.5 + 0.5 * Math.sin(t * 0.8 + d.phase)))
        } else if (mode === 'pulse') {
          const cx = canvas!.width / 2
          const cy = canvas!.height / 2
          const dist = Math.hypot(d.hx - cx, d.hy - cy)
          const wave = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 3 - dist * 0.03)
          alpha = 0.2 + 0.6 * wave
          r = baseR * (0.7 + 0.5 * wave)
        } else if (mode === 'ripple') {
          alpha = 0.4
          if (ripple && !reduced) {
            const ox = ripple.x * canvas!.width
            const oy = ripple.y * canvas!.height
            const dist = Math.hypot(d.hx - ox, d.hy - oy)
            const ringR = ripple.t * Math.max(canvas!.width, canvas!.height) * 0.6
            const band = Math.exp(-Math.pow((dist - ringR) / (g * 1.5), 2))
            const decay = 1 - ripple.t / 1.4
            const push = band * decay * g * 0.9
            if (dist > 0.001) {
              dx = ((d.hx - ox) / dist) * push
              dy = ((d.hy - oy) / dist) * push
            }
            alpha = 0.4 + band * decay * 0.5
            r = baseR * (1 + band * decay * 0.8)
          }
        }

        ctx!.globalAlpha = Math.max(0, Math.min(1, alpha))
        ctx!.beginPath()
        ctx!.arc(d.hx + dx, d.hy + dy, r, 0, Math.PI * 2)
        ctx!.fillStyle = color
        ctx!.fill()
      }
      ctx!.globalAlpha = 1

      // A still field still needs one paint; only loop when animating.
      if (!reduced || rippleRef.current) {
        raf = requestAnimationFrame(draw)
      }
    }

    buildDots()
    raf = requestAnimationFrame(draw)

    const ro = new ResizeObserver(() => {
      buildDots()
      if (reduced && !rippleRef.current) {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(draw)
      }
    })
    ro.observe(wrap)

    const onVisibility = () => {
      running = !document.hidden
      if (running) {
        start = 0
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(draw)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [mode, gap, dotRadius, speed])

  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      className={cn('pointer-events-none h-full w-full', className)}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  )
}
