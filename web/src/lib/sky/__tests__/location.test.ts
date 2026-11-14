import { describe, expect, it } from 'vitest'
import { roundCoord } from '../location'

describe('roundCoord', () => {
  it('rounds to one decimal without a negative zero', () => {
    expect(roundCoord(-0.04)).toBe(0)
    expect(Object.is(roundCoord(-0.04), -0)).toBe(false)
    expect(roundCoord(51.5074)).toBe(51.5)
  })
})
