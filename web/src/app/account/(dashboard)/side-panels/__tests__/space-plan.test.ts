/**
 * The space plan's decisions (space-plan.ts; Liam, 10-16: "it doesn't need
 * to push it out of the way if there's enough space for it to come in"):
 * the side panel on the right (Liam, 11-11: the For you cards are one of its
 * views), and the page panel beside the navigation (Liam, 11-11: home's
 * recents), which makes room or isn't shown, never floats:
 *
 *   • wide: the panel fits beside the chat's content, nothing moves;
 *   • medium: the content moves by exactly the shortfall (the strip gives
 *     up twice it on the panel's side), never the panel's full width;
 *   • narrow: the panel floats, the chat untouched (938px floats);
 *   • the hysteresis at the room / float line;
 *   • the widest content counts: a card wider than the column moves it more;
 *   • the capture's notepad pushing the content counts too.
 */
import { describe, expect, it } from 'vitest'
import {
  CHAT_CONTENT_MAX_PX,
  LEFT_RESERVE_PX,
  MIN_CHAT_PX,
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
/** The page panel's inner edge, and the breath it keeps from the content. */
const leftClear = LEFT_RESERVE_PX + PANEL_BREATH_PX

describe('the space plan', () => {
  it('wide: the panel fits beside the content, and nothing moves', () => {
    const plan = planSpace({ width: 1600, right: true })
    expect(plan).toEqual({ right: 'room', left: 'off', insetLeft: 0, insetRight: 0 })
    expect(contentShift(plan)).toBe(0)
    // Exactly enough: still nothing moves.
    expect(planSpace({ width: CHAT_CONTENT_MAX_PX + 2 * (RIGHT_RESERVE_PX + PANEL_BREATH_PX), right: true })).toMatchObject({ insetRight: 0 })
  })

  it('medium: the content moves by exactly the shortfall, never the panel’s width', () => {
    // 1300: (1300 − 634) / 2 = 333 free beside the column, 388 wanted: short 55.
    const right = planSpace({ width: 1300, right: true })
    expect(right).toEqual({ right: 'room', left: 'off', insetLeft: 0, insetRight: 110 })
    expect(contentShift(right)).toBe(-55)
    expect(edges(1300, right).hi).toBe(rightClear(1300))
    expect(edges(1300, right).column).toBe(CHAT_CONTENT_MAX_PX)
    expect(right.insetRight).toBeLessThan(RIGHT_RESERVE_PX)
  })

  it('narrower, the column narrows with the strip (its 90%) and still clears the panel', () => {
    const plan = planSpace({ width: 1012, right: true })
    expect(plan.right).toBe('room')
    const e = edges(1012, plan)
    expect(e.hi).toBeLessThanOrEqual(rightClear(1012))
    expect(e.column).toBeLessThan(CHAT_CONTENT_MAX_PX)
  })

  it('narrow: the panel floats, the chat untouched; the desktop app’s 938px window floats', () => {
    expect(planSpace({ width: 1000, right: true })).toEqual({ right: 'float', left: 'off', insetLeft: 0, insetRight: 0 })
    expect(planSpace({ width: 938, right: true })).toEqual({ right: 'float', left: 'off', insetLeft: 0, insetRight: 0 })
  })

  it('the panel making room holds it a little past the line, so a resize never flips back and forth', () => {
    const room: SpacePlan = { right: 'room', left: 'off', insetLeft: 0, insetRight: 356 }
    const float: SpacePlan = { right: 'float', left: 'off', insetLeft: 0, insetRight: 0 }
    // 1000 is under the line (1012) coming from float, inside it coming from room.
    expect(planSpace({ width: 1000, right: true, was: float }).right).toBe('float')
    expect(planSpace({ width: 1000, right: true, was: room }).right).toBe('room')
    // Past the hysteresis it floats whatever came before.
    expect(planSpace({ width: 990, right: true, was: room }).right).toBe('float')
    // At the line, both ways agree.
    expect(planSpace({ width: 1012, right: true, was: float }).right).toBe('room')
    expect(planSpace({ width: 1012, right: true, was: room }).right).toBe('room')
  })

  it('the widest content counts: a card wider than the column moves it where the column alone would not', () => {
    expect(planSpace({ width: 1500, right: true, content: CHAT_CONTENT_MAX_PX }).insetRight).toBe(0)
    // 800 wide: (1500 − 800) / 2 = 350 free, 388 wanted: short 38.
    const wide = planSpace({ width: 1500, right: true, content: 800 })
    expect(wide).toEqual({ right: 'room', left: 'off', insetLeft: 0, insetRight: 76 })
    expect(edges(1500, wide, 800).hi).toBe(rightClear(1500))
  })

  it('the capture’s notepad counts: its push moves the content toward the right panel', () => {
    // Alone, 1500 holds the panel beside the column; with the notepad pushing it over, the content moves back left.
    expect(planSpace({ width: 1500, right: true }).insetRight).toBe(0)
    expect(planSpace({ width: 1500, right: true, dock: true }).insetRight).toBeGreaterThan(0)
    // Wide enough for both, nothing moves.
    expect(planSpace({ width: 1900, right: true, dock: true })).toMatchObject({ right: 'room', left: 'off', insetLeft: 0, insetRight: 0 })
  })

  it('nothing shown: nothing taken; not measured yet: floats, so nothing jumps', () => {
    expect(planSpace({ width: 2000, right: false })).toBe(NO_PANELS)
    expect(planSpace({ width: 2000, right: false, dock: true })).toBe(NO_PANELS)
    expect(planSpace({ width: 0, right: true })).toEqual({ right: 'float', left: 'off', insetLeft: 0, insetRight: 0 })
  })
})

describe('the space plan’s left slot: the page panel', () => {
  it('wide: it fits beside the content, and nothing moves', () => {
    const plan = planSpace({ width: 1800, right: false, left: true })
    expect(plan).toEqual({ right: 'off', left: 'room', insetLeft: 0, insetRight: 0 })
    expect(contentShift(plan)).toBe(0)
    expect(edges(1800, plan).lo).toBeGreaterThanOrEqual(leftClear)
  })

  it('short of room: the content moves right by exactly the shortfall', () => {
    // 1200: (1200 − 634) / 2 = 283 free beside the column, 324 wanted: short 41.
    const plan = planSpace({ width: 1200, right: false, left: true })
    expect(plan).toEqual({ right: 'off', left: 'room', insetLeft: 82, insetRight: 0 })
    expect(contentShift(plan)).toBe(41)
    expect(edges(1200, plan).lo).toBe(leftClear)
    expect(edges(1200, plan).column).toBe(CHAT_CONTENT_MAX_PX)
  })

  it('no room for it beside a 640px chat: it isn’t shown, and never floats', () => {
    const line = MIN_CHAT_PX + LEFT_RESERVE_PX
    expect(planSpace({ width: line, right: false, left: true }).left).toBe('room')
    expect(planSpace({ width: line - 1, right: false, left: true })).toBe(NO_PANELS)
    expect(planSpace({ width: 938, right: false, left: true })).toBe(NO_PANELS)
    // Not measured yet: not shown (nothing to jump).
    expect(planSpace({ width: 0, right: false, left: true })).toBe(NO_PANELS)
  })

  it('beside the right panel: both make room where both fit, the content clear of each', () => {
    const plan = planSpace({ width: 1700, right: true, left: true })
    expect(plan).toMatchObject({ right: 'room', left: 'room' })
    const e = edges(1700, plan)
    expect(e.lo).toBeGreaterThanOrEqual(leftClear)
    expect(e.hi).toBeLessThanOrEqual(rightClear(1700))
    // Tighter: still both, the content between them, never pushed into either.
    const tight = planSpace({ width: 1330, right: true, left: true })
    expect(tight).toMatchObject({ right: 'room', left: 'room' })
    const t = edges(1330, tight)
    expect(t.lo).toBeGreaterThanOrEqual(leftClear)
    expect(t.hi).toBeLessThanOrEqual(rightClear(1330))
  })

  it('room for one but not both: the right panel (opened by hand) keeps it, the page panel stays out', () => {
    // 1300: 1300 − 372 − 308 = 620 beside both, under 640.
    expect(planSpace({ width: 1300, right: true, left: true })).toEqual({ right: 'room', left: 'off', insetLeft: 0, insetRight: 110 })
    // The right panel floating: the page panel stays out too.
    expect(planSpace({ width: 1000, right: true, left: true })).toEqual({ right: 'float', left: 'off', insetLeft: 0, insetRight: 0 })
    expect(planSpace({ width: 0, right: true, left: true })).toEqual({ right: 'float', left: 'off', insetLeft: 0, insetRight: 0 })
  })

  it('holds its room a little past the line, so a resize never flips it back and forth', () => {
    const line = MIN_CHAT_PX + LEFT_RESERVE_PX
    const room: SpacePlan = { right: 'off', left: 'room', insetLeft: 0, insetRight: 0 }
    expect(planSpace({ width: line - 8, right: false, left: true, was: NO_PANELS }).left).toBe('off')
    expect(planSpace({ width: line - 8, right: false, left: true, was: room }).left).toBe('room')
    expect(planSpace({ width: line - 17, right: false, left: true, was: room }).left).toBe('off')
  })
})

describe('the page panel opened by hand (its button, Liam 11-11): it may float', () => {
  it('floats wherever it would stay out, the insets as without it; with room it still makes room; nothing to show, nothing', () => {
    expect(planSpace({ width: 938, right: false, left: true, leftFloat: true })).toEqual({ right: 'off', left: 'float', insetLeft: 0, insetRight: 0 })
    expect(planSpace({ width: 1300, right: true, left: true, leftFloat: true })).toEqual({ right: 'room', left: 'float', insetLeft: 0, insetRight: 110 })
    expect(planSpace({ width: 1000, right: true, left: true, leftFloat: true })).toEqual({ right: 'float', left: 'float', insetLeft: 0, insetRight: 0 })
    expect(planSpace({ width: 1800, right: false, left: true, leftFloat: true }).left).toBe('room')
    expect(planSpace({ width: 938, right: false, left: false, leftFloat: true })).toBe(NO_PANELS)
    // As the device remembered it (no leftFloat): out, never over the chat.
    expect(planSpace({ width: 938, right: false, left: true })).toBe(NO_PANELS)
  })
})

describe('a page’s sub-nav with its card in front (Liam, 11-11: its card draws no navigation of its own from md up)', () => {
  it('never off while open: room where there is room, else it floats, as remembered or opened by hand', () => {
    // Room: as any page panel.
    expect(planSpace({ width: 1800, right: false, left: true, leftPinned: true }).left).toBe('room')
    // No room beside a 640px chat (938px): it floats instead of staying out, the chat untouched.
    expect(planSpace({ width: 938, right: false, left: true, leftPinned: true })).toEqual({ right: 'off', left: 'float', insetLeft: 0, insetRight: 0 })
    // Not measured yet: floats, so it is there from the first frame.
    expect(planSpace({ width: 0, right: false, left: true, leftPinned: true })).toEqual({ right: 'off', left: 'float', insetLeft: 0, insetRight: 0 })
    // Closed (nothing asked for the left): nothing.
    expect(planSpace({ width: 938, right: false, left: false, leftPinned: true })).toBe(NO_PANELS)
  })

  it('before the right panel: room for one but not both, the sub-nav makes room and the right panel floats', () => {
    // 1300: room for one only. Home’s Recent stays out there; a page’s sub-nav keeps the left.
    const plan = planSpace({ width: 1300, right: true, left: true, leftPinned: true })
    expect(plan).toMatchObject({ left: 'room', right: 'float' })
    expect(plan.insetRight).toBe(0)
    expect(planSpace({ width: 1300, right: true, left: true }).left).toBe('off')
    // Room for both: both, as before.
    expect(planSpace({ width: 1700, right: true, left: true, leftPinned: true })).toMatchObject({ right: 'room', left: 'room' })
    // Room for neither: both float.
    expect(planSpace({ width: 900, right: true, left: true, leftPinned: true })).toEqual({ right: 'float', left: 'float', insetLeft: 0, insetRight: 0 })
  })
})
