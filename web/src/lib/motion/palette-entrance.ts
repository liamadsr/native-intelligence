/**
 * The search palette's entrance (`/`, ⌘K: chat/command-menu.tsx), as one
 * definition everything that wants to arrive the same way shares: a short
 * ease in from a hair above, a touch smaller and clear, on a fast-out curve.
 *
 * The page panel uses it when the person changes pages (Liam, 11-11: "The
 * animation for when you change pages for the side panel feels a bit choppy
 * can you apply the same animation we have for the search CMD+K page"):
 * the next page's panel arrives as the palette does instead of two panels
 * sliding past each other in the same place.
 *
 * Web Animations only (no animation library on the shell's first load:
 * shell-heavy-deps.test.ts), transform and opacity only, nothing left
 * running, and none at all under reduced motion or without the API (jsdom).
 */

/** Where it starts: clear, 6px up, 98% size. */
export const PALETTE_ENTRANCE_FROM: Keyframe = { opacity: 0, transform: 'translateY(-6px) scale(0.98)' }
/** How long, ms. */
export const PALETTE_ENTRANCE_MS = 160
/** Fast out, a long soft landing. */
export const PALETTE_ENTRANCE_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'

/** Reduced motion asked for (no animation then). */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Play an entrance on `el` once: from `from` (the palette's by default) to
 * where it stands. No-op without the Web Animations API or under reduced
 * motion. Returns the animation, or null when none ran.
 */
export function playEntrance(
  el: HTMLElement | null,
  { from = PALETTE_ENTRANCE_FROM, duration = PALETTE_ENTRANCE_MS }: { from?: Keyframe; duration?: number } = {},
): Animation | null {
  if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) return null
  return el.animate([from, { opacity: 1, transform: 'none' }], { duration, easing: PALETTE_ENTRANCE_EASING })
}
