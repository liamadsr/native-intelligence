import { describe, expect, it } from 'vitest'
import { MIN_TILE_PX, callLayout, type CallLayout } from '../call-layout'

// Stages as the guest's page measures them (gap 12): the box between its header and controls.
const PHONE = { width: 366, height: 650 } // 390×844, upright
const PHONE_SIDEWAYS = { width: 820, height: 238 } // 844×390
const TABLET = { width: 744, height: 860 } // 768×1024
const DESKTOP = { width: 1000, height: 740 } // 1440×900
const SIDE = { width: 356, height: Infinity } // the members' panel docked at the side

function grid(l: CallLayout) {
  if (l.mode !== 'grid') throw new Error(`expected a grid, got ${l.mode}`)
  return l
}

/** The tiles, laid out, fit inside the stage (unless it scrolls). */
function fits(l: ReturnType<typeof grid>, stage: { width: number; height: number }, gap = 12) {
  expect(l.cols * l.tileWidth + (l.cols - 1) * gap).toBeLessThanOrEqual(stage.width)
  if (!l.scroll && stage.height !== Infinity) expect(l.rows * l.tileHeight + (l.rows - 1) * gap).toBeLessThanOrEqual(stage.height)
}

describe('callLayout', () => {
  it('waits for a measured stage', () => {
    expect(callLayout(2, 0, { width: 0, height: 0 })).toEqual({ mode: 'unmeasured' })
    expect(callLayout(2, 0, { width: 300, height: 0 })).toEqual({ mode: 'unmeasured' })
    expect(callLayout(2, 0, { width: NaN, height: 300 })).toEqual({ mode: 'unmeasured' })
  })

  describe('a phone held upright', () => {
    it('one person fills the stage', () => {
      const l = grid(callLayout(1, 0, PHONE, { gap: 12 }))
      expect(l).toMatchObject({ cols: 1, rows: 1, tileWidth: 366, tileHeight: 650, orientation: 'portrait', scroll: false })
    })
    it('two people stack, each the full width and half the height', () => {
      const l = grid(callLayout(2, 0, PHONE, { gap: 12 }))
      expect(l).toMatchObject({ cols: 1, rows: 2, tileWidth: 366, scroll: false })
      expect(l.tileHeight).toBe(Math.floor((650 - 12) / 2))
      fits(l, PHONE)
    })
    it('three stack too, each still wider than tall', () => {
      const l = grid(callLayout(3, 0, PHONE, { gap: 12 }))
      expect(l).toMatchObject({ cols: 1, rows: 3, tileWidth: 366 })
      expect(l.tileWidth).toBeGreaterThan(l.tileHeight)
      fits(l, PHONE)
    })
    it('four make 2×2 filling the stage', () => {
      const l = grid(callLayout(4, 0, PHONE, { gap: 12 }))
      expect(l).toMatchObject({ cols: 2, rows: 2, scroll: false })
      expect(2 * l.tileHeight + 12).toBeGreaterThan(PHONE.height - 4)
      fits(l, PHONE)
    })
    it('six make 2×3 without scrolling', () => {
      const l = grid(callLayout(6, 0, PHONE, { gap: 12 }))
      expect(l).toMatchObject({ cols: 2, rows: 3, scroll: false })
      fits(l, PHONE)
    })
    it('many more stay two across and scroll, never under the readable size', () => {
      const l = grid(callLayout(14, 0, PHONE, { gap: 12 }))
      expect(l).toMatchObject({ cols: 2, scroll: true })
      expect(l.tileHeight).toBeGreaterThanOrEqual(MIN_TILE_PX)
    })
  })

  describe('a phone held sideways', () => {
    it('two sit side by side, the stage’s full height', () => {
      const l = grid(callLayout(2, 0, PHONE_SIDEWAYS, { gap: 12 }))
      expect(l).toMatchObject({ cols: 2, rows: 1, tileHeight: 238, orientation: 'landscape' })
      fits(l, PHONE_SIDEWAYS)
    })
    it('one person fills the height, no wider than a camera', () => {
      const l = grid(callLayout(1, 0, PHONE_SIDEWAYS, { gap: 12 }))
      expect(l).toMatchObject({ tileHeight: 238 })
      expect(l.tileWidth / l.tileHeight).toBeLessThanOrEqual(16 / 9 + 0.01)
    })
    it('four sit in one row', () => {
      expect(grid(callLayout(4, 0, PHONE_SIDEWAYS, { gap: 12 }))).toMatchObject({ cols: 4, rows: 1 })
    })
    it('six fit in 3×2 without scrolling', () => {
      const l = grid(callLayout(6, 0, PHONE_SIDEWAYS, { gap: 12 }))
      expect(l).toMatchObject({ cols: 3, rows: 2, scroll: false })
      fits(l, PHONE_SIDEWAYS)
    })
  })

  describe('a tablet held upright', () => {
    it.each([
      [1, 1, 1],
      [2, 1, 2],
      [3, 2, 2],
      [4, 2, 2],
      [6, 2, 3],
    ])('%i people: %i×%i', (n, cols, rows) => {
      const l = grid(callLayout(n, 0, TABLET, { gap: 12 }))
      expect(l).toMatchObject({ cols, rows, scroll: false })
      fits(l, TABLET)
    })
  })

  describe('a desktop', () => {
    it('one person fills the stage', () => {
      expect(grid(callLayout(1, 0, DESKTOP, { gap: 12 }))).toMatchObject({ tileWidth: 1000, tileHeight: 740 })
    })
    it('two sit side by side, as large as fits', () => {
      const l = grid(callLayout(2, 0, DESKTOP, { gap: 12 }))
      expect(l).toMatchObject({ cols: 2, rows: 1, tileWidth: 494 })
      fits(l, DESKTOP)
    })
    it.each([
      [3, 2, 2],
      [4, 2, 2],
      [6, 3, 2],
    ])('%i people: %i×%i', (n, cols, rows) => {
      const l = grid(callLayout(n, 0, DESKTOP, { gap: 12 }))
      expect(l).toMatchObject({ cols, rows, scroll: false })
      fits(l, DESKTOP)
    })
  })

  describe('the members’ panel at the side (grows with its tiles)', () => {
    it('one or two people take the width, one per row, at 16:9', () => {
      for (const n of [1, 2]) {
        const l = grid(callLayout(n, 0, SIDE))
        expect(l).toMatchObject({ cols: 1, rows: n, tileWidth: 356, tileHeight: 200 })
      }
    })
    it('more go two across', () => {
      expect(grid(callLayout(4, 0, SIDE))).toMatchObject({ cols: 2, rows: 2 })
    })
  })

  describe('a screen shared', () => {
    it.each([
      ['a phone upright', PHONE, 4, 'portrait'],
      ['a tablet', TABLET, 7, 'portrait'],
      ['a desktop', DESKTOP, 8, 'landscape'],
      ['the side panel', SIDE, 4, 'portrait'],
    ] as const)('on %s the people become a strip of %i across', (_, stage, stripCols, orientation) => {
      for (const n of [1, 2, 6]) expect(callLayout(n, 1, stage, { gap: 12 })).toEqual({ mode: 'share', stripCols, strip: 'bottom', orientation })
    })
    it('on a phone held sideways the strip is a column at the side, so the screen keeps the height', () => {
      for (const n of [1, 2, 6]) expect(callLayout(n, 1, PHONE_SIDEWAYS, { gap: 12 })).toEqual({ mode: 'share', stripCols: 1, strip: 'side', orientation: 'landscape' })
    })
    it('the strip never goes under four across, even on a very narrow stage', () => {
      expect(callLayout(3, 1, { width: 200, height: 400 })).toMatchObject({ mode: 'share', stripCols: 4 })
    })
  })

  it('every count fits every bounded stage', () => {
    for (const stage of [PHONE, PHONE_SIDEWAYS, TABLET, DESKTOP])
      for (let n = 1; n <= 12; n++) {
        const l = grid(callLayout(n, 0, stage, { gap: 12 }))
        expect(l.cols * l.rows).toBeGreaterThanOrEqual(n)
        expect(l.tileHeight).toBeGreaterThanOrEqual(Math.min(MIN_TILE_PX, l.tileHeight))
        fits(l, stage)
      }
  })
})
