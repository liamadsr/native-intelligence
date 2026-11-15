/**
 * The landing page's one motion personality: unhurried and exact. Three
 * curves and no others, the same three the hero's day is built on
 * (hero-day.tsx keeps its own copies as CSS strings).
 *
 *   MOVE  something already on screen changing place or size: slow out, slow in
 *   IN    something arriving: fast start, soft landing
 *   OUT   something leaving: gentle start, quick exit (and shorter than it came)
 *
 * Entrances pair opacity with a small move, never opacity alone; a group
 * arrives in turn (STAGGER apart) and the whole group lands inside half a
 * second; nothing bounces.
 */
export const MOVE = [0.4, 0, 0.2, 1] as const
export const IN = [0.05, 0.7, 0.1, 1] as const
export const OUT = [0.3, 0, 1, 1] as const

export const MOVE_CSS = `cubic-bezier(${MOVE.join(', ')})`
export const IN_CSS = `cubic-bezier(${IN.join(', ')})`
export const OUT_CSS = `cubic-bezier(${OUT.join(', ')})`

/** Seconds between one member of a group arriving and the next. */
export const STAGGER = 0.07

/** A group whose children arrive in turn once it scrolls into view (framer-motion variants). */
export const GROUP = {
  hidden: {},
  shown: { transition: { staggerChildren: STAGGER, delayChildren: 0.05 } },
} as const

/** One member of a GROUP: rises a little as it fades in. */
export const MEMBER = {
  hidden: { opacity: 0, y: 14 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.4, ease: IN } },
} as const

/** How far inside the viewport an element must be before a looping scene on it starts (use-in-view.ts). */
export const IN_VIEW_MARGIN = '-15% 0px -15% 0px'
