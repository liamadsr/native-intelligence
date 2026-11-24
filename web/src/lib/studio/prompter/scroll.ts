// The prompter's smooth scroll: the current line sits about a third of the way down, reached by an eased step per
// animation frame (no jumps, no overshoot). Pure; tested in __tests__/scroll.test.ts.

/** Where the current line sits: this share of the view's height from its top. */
export const LINE_AT = 1 / 3
/** The ease's time constant: about 63% of the way there after this long. */
const EASE_MS = 180

/** The scrollTop that puts a line whose top is `lineTop` (and height `lineHeight`) at a third of the view. */
export function scrollTarget(lineTop: number, lineHeight: number, viewHeight: number, contentHeight: number): number {
  const target = lineTop + lineHeight / 2 - viewHeight * LINE_AT
  return Math.max(0, Math.min(target, Math.max(0, contentHeight - viewHeight)))
}

/** The next scrollTop from `current` toward `target` after `dtMs`; lands exactly when within half a pixel. */
export function easeStep(current: number, target: number, dtMs: number): number {
  const gap = target - current
  if (Math.abs(gap) < 0.5) return target
  const next = current + gap * (1 - Math.exp(-Math.max(0, dtMs) / EASE_MS))
  return Math.abs(target - next) < 0.5 ? target : next
}
