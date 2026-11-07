/**
 * Where a dragged side panel card lands (card-drag.ts dropIndex): at or past
 * a neighbour's centre it takes that neighbour's slot, so the end slots are
 * reachable with the drag kept inside the column, a tall (open) card's too.
 */
import { describe, expect, it } from 'vitest'
import { dropIndex } from '../card-drag'

describe('dropIndex', () => {
  // Three 40px cards, 10px apart: centres 20, 70, 120.
  const centres = [20, 70, 120]

  it('stays put short of a neighbour’s centre, takes its slot at or past it, either way', () => {
    expect(dropIndex(centres, 0, 0)).toBe(0)
    expect(dropIndex(centres, 0, 49)).toBe(0)
    expect(dropIndex(centres, 0, 50)).toBe(1)
    expect(dropIndex(centres, 0, 100)).toBe(2)
    expect(dropIndex(centres, 2, -50)).toBe(1)
    expect(dropIndex(centres, 2, -100)).toBe(0)
    expect(dropIndex(centres, 1, 0)).toBe(1)
  })

  it('a tall card past a short last one: its centre reaching the last card’s centre is enough', () => {
    // An open card 300px tall (centre 150) over a closed 40px one (top 310, centre 330).
    expect(dropIndex([150, 330], 0, 180)).toBe(1)
    expect(dropIndex([150, 330], 0, 179)).toBe(0)
  })
})
