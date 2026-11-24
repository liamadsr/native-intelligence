/**
 * The card header's one date (../helpers.ts headerDateLabel; Liam, 11-23:
 * "why is the current date repeated here like three times"): the month and
 * year once, as the view shows them.
 */
import { describe, expect, it } from 'vitest'
import { headerDateLabel } from '../helpers'

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day)

describe('headerDateLabel', () => {
  it('a week inside one month: "Dec 6 – 12, 2026", the year once', () => {
    expect(headerDateLabel('week', d(2026, 12, 8))).toEqual({ short: 'Dec 6 – 12', long: 'Dec 6 – 12, 2026' })
  })

  it('a week across two months, and across two years', () => {
    expect(headerDateLabel('week', d(2026, 12, 2)).long).toBe('Nov 29 – Dec 5, 2026')
    expect(headerDateLabel('week', d(2026, 12, 30)).long).toBe('Dec 27, 2026 – Jan 2, 2027')
  })

  it('a day, a month, a year', () => {
    expect(headerDateLabel('day', d(2026, 12, 7))).toEqual({ short: 'Dec 7', long: 'Mon, Dec 7, 2026' })
    expect(headerDateLabel('month', d(2026, 12, 7))).toEqual({ short: 'Dec 2026', long: 'December 2026' })
    expect(headerDateLabel('agenda', d(2026, 12, 7)).long).toBe('December 2026')
    expect(headerDateLabel('year', d(2026, 12, 7)).long).toBe('2026')
  })
})
