'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  CELEBRATION_EVENT,
  type CelebrationIntensity,
  type CelebrationOptions,
} from './celebrate'

/**
 * Global confetti overlay. Mounted once (in dashboard-shell) and listens for
 * `dial8:celebrate` events fired via `celebrate()`. Renders a short, cute pop
 * of confetti pieces at the requested origin, then cleans itself up.
 *
 * Hand-rolled with framer-motion (already a dependency) — no confetti library.
 * Each burst is its own keyed group so overlapping rapid completions stack
 * gracefully and each animates/exits independently.
 */

interface Burst {
  id: number
  x: number
  y: number
  pieces: Piece[]
}

type PieceShape = 'dot' | 'chip' | 'ribbon'

interface Piece {
  /** total horizontal travel from origin (px) */
  dx: number
  /** how high the piece pops up before gravity (px, positive) */
  lift: number
  /** how far it ultimately falls below the origin (px, positive) */
  drop: number
  /** end rotation (deg) — spins the whole flight */
  rotate: number
  color: string
  /** longest side of the piece (px) */
  size: number
  /** how slim the piece is (1 = square/round, <1 = chip/ribbon) */
  aspect: number
  shape: PieceShape
  /** slight per-piece delay for a more organic pop */
  delay: number
  /** total flight time (s) — varied so pieces don't land in unison */
  duration: number
}

// Bright, saturated, festive palette that reads on light and dark backgrounds.
const COLORS = [
  '#f43f5e', // rose
  '#fb7185', // light rose
  '#f59e0b', // amber
  '#fbbf24', // gold
  '#22c55e', // green
  '#34d399', // emerald
  '#3b82f6', // blue
  '#38bdf8', // sky
  '#a855f7', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
]

const PIECE_COUNT: Record<CelebrationIntensity, number> = {
  small: 36,
  big: 80,
}

// How far, horizontally, the cone of confetti fans out at the launch apex.
const SPREAD: Record<CelebrationIntensity, number> = {
  small: 150,
  big: 300,
}

// Cleanup safety net — must exceed the longest possible flight
// (max delay 0.12s + max duration 2.5s = 2.62s) with a small margin.
const MAX_DURATION_MS = 3000

let burstSeq = 0

function pickShape(): PieceShape {
  const r = Math.random()
  if (r < 0.45) return 'chip'
  if (r < 0.8) return 'dot'
  return 'ribbon'
}

function makePieces(intensity: CelebrationIntensity): Piece[] {
  const count = PIECE_COUNT[intensity]
  const spread = SPREAD[intensity]
  const pieces: Piece[] = []
  for (let i = 0; i < count; i++) {
    // Fan horizontally across a wide cone for a full burst.
    const dx = (Math.random() - 0.5) * 2 * spread
    // Pop up first (lift), then fall well below the origin (drop) — composed in
    // the renderer as a parabola so it reads like a real shower.
    const lift = 70 + Math.random() * 120
    const drop = 220 + Math.random() * 220

    const shape = pickShape()
    const size =
      shape === 'ribbon'
        ? 13 + Math.random() * 10
        : 9 + Math.random() * 7
    const aspect = shape === 'dot' ? 1 : shape === 'chip' ? 0.5 : 0.3

    pieces.push({
      dx,
      lift,
      drop,
      rotate: (Math.random() - 0.5) * 900,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      size,
      aspect,
      shape,
      delay: Math.random() * 0.1,
      duration: 1.7 + Math.random() * 0.7,
    })
  }
  return pieces
}

export function CelebrationOverlay() {
  const [bursts, setBursts] = useState<Burst[]>([])
  const [mounted, setMounted] = useState(false)
  const reduceMotion = useReducedMotion()
  const reduceRef = useRef(reduceMotion)
  reduceRef.current = reduceMotion

  useEffect(() => setMounted(true), [])

  const removeBurst = useCallback((id: number) => {
    setBursts((prev) => prev.filter((b) => b.id !== id))
  }, [])

  useEffect(() => {
    function onCelebrate(e: Event) {
      // Honor reduced-motion: skip the animation entirely.
      if (reduceRef.current) return

      const detail = (e as CustomEvent<CelebrationOptions>).detail ?? {}
      const intensity = detail.intensity ?? 'small'
      const x = typeof detail.x === 'number' ? detail.x : window.innerWidth / 2
      const y =
        typeof detail.y === 'number' ? detail.y : window.innerHeight * 0.4
      const id = ++burstSeq
      setBursts((prev) => {
        // Cap concurrent bursts so a rapid "complete all" spree can't flood.
        const next = [...prev, { id, x, y, pieces: makePieces(intensity) }]
        return next.length > 6 ? next.slice(next.length - 6) : next
      })
    }

    window.addEventListener(CELEBRATION_EVENT, onCelebrate)
    return () => window.removeEventListener(CELEBRATION_EVENT, onCelebrate)
  }, [])

  if (!mounted || reduceMotion) return null

  return createPortal(
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        // Above all app chrome (matches the global Toaster z-index).
        zIndex: 2147483646,
      }}
    >
      <AnimatePresence>
        {bursts.map((burst) => (
          <BurstView
            key={burst.id}
            burst={burst}
            onDone={() => removeBurst(burst.id)}
          />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  )
}

function BurstView({ burst, onDone }: { burst: Burst; onDone: () => void }) {
  // Safety net: ensure the burst is removed even if the driving piece's
  // onAnimationComplete doesn't fire (e.g. tab blur mid-animation).
  useEffect(() => {
    const t = setTimeout(onDone, MAX_DURATION_MS)
    return () => clearTimeout(t)
  }, [onDone])

  // Pieces have varied delay+duration, so the LAST in the array isn't
  // necessarily the last to finish. Drive cleanup off the longest-lived one.
  let driverIdx = 0
  let driverEnd = -1
  burst.pieces.forEach((p, i) => {
    const end = p.delay + p.duration
    if (end > driverEnd) {
      driverEnd = end
      driverIdx = i
    }
  })

  return (
    <div
      style={{
        position: 'absolute',
        left: burst.x,
        top: burst.y,
        width: 0,
        height: 0,
      }}
    >
      {burst.pieces.map((p, i) => (
        // Two-layer parabola: the OUTER layer carries horizontal travel + the
        // downward fall (easeIn = gravity) + the opacity fade; the INNER layer
        // adds the initial upward pop (easeOut). Their two vertical translations
        // compose into a real up-then-down arc — and because each layer uses a
        // single scalar target (not keyframe arrays) the animation runs
        // reliably. The piece itself spins + scales on a third element.
        <motion.div
          key={i}
          initial={{ x: 0, y: 0, opacity: 1 }}
          animate={{ x: p.dx, y: p.drop, opacity: 0 }}
          transition={{
            duration: p.duration,
            delay: p.delay,
            x: { duration: p.duration, delay: p.delay, ease: 'easeOut' },
            y: { duration: p.duration, delay: p.delay, ease: 'easeIn' },
            opacity: {
              duration: p.duration * 0.35,
              delay: p.delay + p.duration * 0.65,
              ease: 'easeIn',
            },
          }}
          onAnimationComplete={i === driverIdx ? onDone : undefined}
          style={{ position: 'absolute', willChange: 'transform, opacity' }}
        >
          <motion.div
            initial={{ y: 0 }}
            animate={{ y: -p.lift }}
            transition={{
              duration: p.duration * 0.4,
              delay: p.delay,
              ease: 'easeOut',
            }}
            style={{ willChange: 'transform' }}
          >
            <motion.div
              initial={{ scale: 0.2, rotate: 0 }}
              animate={{ scale: 1, rotate: p.rotate }}
              transition={{
                scale: { duration: 0.25, delay: p.delay, ease: 'backOut' },
                rotate: { duration: p.duration, delay: p.delay, ease: 'linear' },
              }}
              style={{
                width: p.size,
                height: p.size * p.aspect,
                backgroundColor: p.color,
                borderRadius: p.shape === 'dot' ? '9999px' : '1px',
                // A touch of sheen so chips/ribbons catch the eye.
                boxShadow: '0 0 0 0.5px rgba(255,255,255,0.2) inset',
              }}
            />
          </motion.div>
        </motion.div>
      ))}
    </div>
  )
}
