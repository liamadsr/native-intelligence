'use client'

/**
 * Tiny imperative event-bus for firing a celebration (confetti pop) from
 * anywhere in the app — completion handlers live in many components (board DnD,
 * list dropdowns, detail panels, checkboxes, cycle-complete), so rather than
 * thread a callback through all of them we dispatch a window CustomEvent and let
 * the single <CelebrationOverlay/> (mounted in dashboard-shell) render the burst.
 *
 * Usage:
 *   import { celebrate } from '@/components/celebration/celebrate'
 *   celebrate()                         // burst at screen center
 *   celebrate({ x, y })                 // burst at a point (e.g. a checkbox)
 *   celebrate({ x, y, intensity: 'big' })
 */

export type CelebrationIntensity = 'small' | 'big'

export interface CelebrationOptions {
  /** Origin x in viewport px. Defaults to horizontal center. */
  x?: number
  /** Origin y in viewport px. Defaults to ~40% down the screen. */
  y?: number
  /** How much confetti. 'small' (default) = a cute pop. */
  intensity?: CelebrationIntensity
}

export const CELEBRATION_EVENT = 'dial8:celebrate'

/**
 * Fire a confetti celebration. Safe to call from any client code; a no-op
 * during SSR. Respects prefers-reduced-motion (handled in the overlay).
 */
export function celebrate(options: CelebrationOptions = {}): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CELEBRATION_EVENT, { detail: options }))
}

/**
 * Convenience: derive a burst origin from a DOM element (e.g. the checkbox or
 * row that was just completed) so the confetti pops right where the user acted.
 * Falls back to undefined fields (center) if the element is missing.
 */
export function celebrateFromElement(
  el: Element | null | undefined,
  options: Omit<CelebrationOptions, 'x' | 'y'> = {},
): void {
  if (!el) {
    celebrate(options)
    return
  }
  const rect = el.getBoundingClientRect()
  celebrate({
    ...options,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  })
}
