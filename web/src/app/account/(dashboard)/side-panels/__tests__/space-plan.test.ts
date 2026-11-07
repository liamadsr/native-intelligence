/**
 * The space plan's decisions (space-plan.ts; Liam, 10-16: "it doesn't need
 * to push it out of the way if there's enough space for it to come in"):
 *
 *   • wide: the panel fits beside the chat's content, nothing moves;
 *   • medium: the content moves by exactly the shortfall (the strip gives
 *     up twice it on the panel's side), never the panel's full width;
 *   • narrow: the panel floats, the chat untouched (938px floats);
 *   • both panels: each side against its own free space, a shift never
 *     into the other panel, the right panel first;
 *   • the hysteresis at the room / float line;
 *   • the widest content counts: a card wider than the column moves it more;
 *   • the capture's notepad pushing the content counts too.
 */
import { describe, expect, it } from 'vitest'
import {
  CHAT_CONTENT_MAX_PX,
  LEFT_RESERVE_PX,
  NO_PANELS,
  PANEL_BREATH_PX,
  READING_FRACTION,
  RIGHT_RESERVE_PX,
  contentShift,
  planSpace,
  type SpacePlan,
} from '../space-plan'

/** Where the centred content's edges land in the row under a plan (no notepad). */
function edges(width: number, plan: SpacePlan, content = CHAT_CONTENT_MAX_PX) {
  const strip = width - plan.insetLeft - plan.insetRight
  const column = Math.min(READING_FRACTION * strip, content)
  const mid = plan.insetLeft + strip / 2
  return { lo: mid - column / 2, hi: mid + column / 2, column }
}
/** The right panel's inner edge, less the breath it keeps from the content. */
const rightClear = (width: number) => width - RIGHT_RESERVE_PX - PANEL_BREATH_PX
const LEFT_CLEAR = LEFT_RESERVE_PX + PANEL_BREATH_PX

describe('the space plan', () => {
  it('wide: the panel fits beside the content, and nothing moves', () => {
    const plan = planSpace({ width: 1600, right: true, left: false })
    expect(plan).toEqual({ right: 'room', left: 'off', insetLeft: 0, insetRight: 0 })
    expect(contentShift(plan)).toBe(0)
    // Exactly enough: still nothing moves.
    expect(planSpace({ width: CHAT_CONTENT_MAX_PX + 2 * (RIGHT_RESERVE_PX + PANEL_BREATH_PX), right: true, left: false })).toMatchObject({ insetRight: 0 })
    // For you likewise, on the left.
    expect(planSpace({ width: 1300, right: false, left: true })).toEqual({ right: 'off', left: 'room', insetLeft: 0, insetRight: 0 })
  })

  it('medium: the content moves by exactly the shortfall, never the panel’s width', () => {
    // 1300: (1300 − 634) / 2 = 333 free beside the column, 388 wanted: short 55.
    const right = planSpace({ width: 1300, right: true, left: false })
    expect(right).toEqual({ right: 'room', left: 'off', insetLeft: 0, insetRight: 110 })
    expect(contentShift(right)).toBe(-55)
    expect(edges(1300, right).hi).toBe(rightClear(1300))
    expect(edges(1300, right).column).toBe(CHAT_CONTENT_MAX_PX)
    expect(right.insetRight).toBeLessThan(RIGHT_RESERVE_PX)
    // For you at 1100: 233 free, 324 wanted: the content moves right 91.
    const left = planSpace({ width: 1100, right: false, left: true })
    expect(left).toEqual({ right: 'off', left: 'room', insetLeft: 182, insetRight: 0 })
    expect(contentShift(left)).toBe(91)
    expect(edges(1100, left).lo).toBe(LEFT_CLEAR)
  })

  it('narrower, the column narrows with the strip (its 90%) and still clears the panel', () => {
    const plan = planSpace({ width: 1012, right: true, left: false })
    expect(plan.right).toBe('room')
    const e = edges(1012, plan)
    expect(e.hi).toBeLessThanOrEqual(rightClear(1012))
    expect(e.column).toBeLessThan(CHAT_CONTENT_MAX_PX)
  })

  it('narrow: the panel floats, the chat untouched; the desktop app’s 938px window floats', () => {
    expect(planSpace({ width: 1000, right: true, left: false })).toEqual({ right: 'float', left: 'off', insetLeft: 0, insetRight: 0 })
    expect(planSpace({ width: 938, right: true, left: false })).toEqual({ right: 'float', left: 'off', insetLeft: 0, insetRight: 0 })
    expect(planSpace({ width: 938, right: true, left: true })).toEqual({ right: 'float', left: 'float', insetLeft: 0, insetRight: 0 })
  })

  it('both panels: each against its own free space, no shift into the other', () => {
    // Wide: neither moves anything.
    expect(planSpace({ width: 1500, right: true, left: true })).toEqual({ right: 'room', left: 'room', insetLeft: 0, insetRight: 0 })
    // The right short by 5, the left with room to spare: the content moves left 5, still clear of For you.
    const short = planSpace({ width: 1400, right: true, left: true })
    expect(short).toEqual({ right: 'room', left: 'room', insetLeft: 0, insetRight: 10 })
    expect(edges(1400, short).lo).toBeGreaterThanOrEqual(LEFT_CLEAR)
    // Both short: the content between them, clear of each.
    const both = planSpace({ width: 1340, right: true, left: true })
    expect(both).toMatchObject({ right: 'room', left: 'room' })
    const e = edges(1340, both)
    expect(e.lo).toBeGreaterThanOrEqual(LEFT_CLEAR)
    expect(e.hi).toBeLessThanOrEqual(rightClear(1340))
    // Room for one only: the right panel first, For you floats.
    expect(planSpace({ width: 1280, right: true, left: true })).toEqual({ right: 'room', left: 'float', insetLeft: 0, insetRight: 130 })
  })

  it('a side making room holds it a little past the line, so a resize never flips back and forth', () => {
    const room: SpacePlan = { right: 'room', left: 'off', insetLeft: 0, insetRight: 356 }
    const float: SpacePlan = { right: 'float', left: 'off', insetLeft: 0, insetRight: 0 }
    // 1000 is under the line (1012) coming from float, inside it coming from room.
    expect(planSpace({ width: 1000, right: true, left: false, was: float }).right).toBe('float')
    expect(planSpace({ width: 1000, right: true, left: false, was: room }).right).toBe('room')
    // Past the hysteresis it floats whatever came before.
    expect(planSpace({ width: 990, right: true, left: false, was: room }).right).toBe('float')
    // At the line, both ways agree.
    expect(planSpace({ width: 1012, right: true, left: false, was: float }).right).toBe('room')
    expect(planSpace({ width: 1012, right: true, left: false, was: room }).right).toBe('room')
  })

  it('the widest content counts: a card wider than the column moves it where the column alone would not', () => {
    expect(planSpace({ width: 1500, right: true, left: false, content: CHAT_CONTENT_MAX_PX }).insetRight).toBe(0)
    // 800 wide: (1500 − 800) / 2 = 350 free, 388 wanted: short 38.
    const wide = planSpace({ width: 1500, right: true, left: false, content: 800 })
    expect(wide).toEqual({ right: 'room', left: 'off', insetLeft: 0, insetRight: 76 })
    expect(edges(1500, wide, 800).hi).toBe(rightClear(1500))
  })

  it('the capture’s notepad counts: its push moves the content toward the right panel', () => {
    // Alone, 1500 holds the panel beside the column; with the notepad pushing it over, the content moves back left.
    expect(planSpace({ width: 1500, right: true, left: false }).insetRight).toBe(0)
    expect(planSpace({ width: 1500, right: true, left: false, dock: true }).insetRight).toBeGreaterThan(0)
    // Wide enough for both, nothing moves.
    expect(planSpace({ width: 1900, right: true, left: false, dock: true })).toMatchObject({ right: 'room', insetLeft: 0, insetRight: 0 })
  })

  it('nothing shown: nothing taken; not measured yet: floats, so nothing jumps', () => {
    expect(planSpace({ width: 2000, right: false, left: false })).toBe(NO_PANELS)
    expect(planSpace({ width: 0, right: true, left: false })).toEqual({ right: 'float', left: 'off', insetLeft: 0, insetRight: 0 })
  })
})
