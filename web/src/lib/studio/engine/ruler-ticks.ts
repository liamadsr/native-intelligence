/**
 * The timeline ruler's marks (Liam, 11-24: "can you make it so that the timeline numbers never overlap like this
 * regardless of size"): round steps (a tenth of a second up to an hour), the smallest one whose labels can stand
 * apart at the ruler's real width, so a narrow timeline shows fewer marks and a zoomed-in one more, never touching.
 * The end of the video is not marked: the transport shows its length, and a mark pinned there collided with the
 * one before it.
 */

/** Steps a mark may sit on, in seconds, smallest first. */
export const RULER_STEPS: readonly number[] = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/** About how wide a ruler label's character is at its 12px, and the room kept clear between two labels. */
export const RULER_CHAR_PX = 7
export const RULER_GAP_PX = 18

export interface RulerTick {
  seconds: number
  label: string
}

/** How many decimals a step's labels need: none for whole seconds, one for tenths and halves, two for quarters. */
export function rulerDecimals(step: number): number {
  if (step >= 1) return 0
  return Math.abs(step * 10 - Math.round(step * 10)) < 1e-9 ? 1 : 2
}

/** A mark's words: minutes and seconds, with the step's decimals (0:05, 0:02.5, 0:00.25, 12:30). */
export function rulerLabel(seconds: number, step: number): string {
  const decimals = rulerDecimals(step)
  const minutes = Math.floor(seconds / 60 + 1e-9)
  const rest = Math.max(0, seconds - minutes * 60)
  const secs = rest.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0')
  return `${minutes}:${secs}`
}

/** The widest a step's label gets over the video (its last mark's), in pixels, with the clear room after it. */
function labelRoom(duration: number, step: number): number {
  return rulerLabel(duration, step).length * RULER_CHAR_PX + RULER_GAP_PX
}

/**
 * The marks for a video `duration` seconds long on a ruler `width` pixels wide: the smallest step whose marks are
 * at least a label's room apart (the largest step when even that is too tight), from 0 up to but not at the end.
 */
export function rulerTicks(duration: number, width: number): RulerTick[] {
  if (!(duration > 0) || !(width > 0)) return [{ seconds: 0, label: '0:00' }]
  const pxPerSecond = width / duration
  const step = RULER_STEPS.find((s) => s * pxPerSecond >= labelRoom(duration, s)) ?? RULER_STEPS[RULER_STEPS.length - 1]
  const ticks: RulerTick[] = []
  // Marks well short of the end only: the last one keeps a label's room before the ruler's edge.
  const room = labelRoom(duration, step) / pxPerSecond
  for (let i = 0; ; i++) {
    const seconds = Math.round(i * step * 1000) / 1000
    if (seconds > 0 && seconds > duration - room) break
    ticks.push({ seconds, label: rulerLabel(seconds, step) })
    if (seconds >= duration) break
  }
  return ticks
}
