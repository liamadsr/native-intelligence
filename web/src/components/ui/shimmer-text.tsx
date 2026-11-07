'use client'

import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'

/**
 * Muted text with a band of light sweeping across it (after React Bits'
 * ShinyText): the chat's "Thinking" line and a running tool's label.
 *
 * CSS only. `.shimmer-text` (src/styles/tailwind.css) paints the text with a
 * gradient through `background-clip: text`: the muted foreground, with a
 * softer band of the foreground in the middle, on a 250% wide background whose
 * `background-position` one `@keyframes` sweeps left to right (about 2 s, then
 * a short rest, on loop). No requestAnimationFrame, no timers, no filter or
 * blur.
 *
 * ── Performance contract (the desktop app's WKWebView: idle CPU matters) ────
 *  - Use it ONLY for a transient state (reasoning that is streaming, a tool
 *    that is running), never on idle UI. A background-position animation
 *    repaints its text every frame, cheap for one short line and wrong for
 *    anything that stays on screen.
 *  - It stops the moment the state ends: `active={false}` renders plain muted
 *    text with no animation class at all, so nothing keeps ticking.
 *  - It does not animate under `prefers-reduced-motion: reduce` (the class
 *    drops here, and the stylesheet turns the animation off as well).
 */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia(REDUCED_MOTION_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function readReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function serverReducedMotion(): boolean {
  return false
}

/** Whether the person asked for reduced motion (live: follows the setting). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, serverReducedMotion)
}

export interface ShimmerTextProps {
  /** True while the state it names is in progress. False renders plain muted text. */
  active: boolean
  children: ReactNode
  className?: string
}

export function ShimmerText({ active, children, className }: ShimmerTextProps) {
  const reducedMotion = usePrefersReducedMotion()
  const animate = active && !reducedMotion
  return (
    <span
      data-shimmer={animate ? 'on' : 'off'}
      className={cn('text-muted-foreground', animate && 'shimmer-text', className)}
    >
      {children}
    </span>
  )
}
