import { describe, expect, it } from 'vitest'
import { linkFieldsInput } from '../input'
import { dateOverridesOf } from '../links'
import { LINK_DATE_OVERRIDES_MAX } from '../types'

const NOW = Date.parse('2026-11-20T12:00:00Z')

describe('a link’s dated changes (migration 705)', () => {
  it('keeps each date’s ranges in order, a day off as none, and drops dates before yesterday', () => {
    expect(
      dateOverridesOf({ '2026-11-25': [{ start: '13:00', end: '14:00' }, { start: '09:00', end: '10:00' }], '2026-11-26': [], '2026-11-19': [], '2026-11-01': [] }, NOW),
    ).toEqual({ '2026-11-19': [], '2026-11-25': [{ start: '09:00', end: '10:00' }, { start: '13:00', end: '14:00' }], '2026-11-26': [] })
  })

  it('none left is null, as is null', () => {
    expect(dateOverridesOf({ '2026-01-01': [] }, NOW)).toBeNull()
    expect(dateOverridesOf(null, NOW)).toBeNull()
  })

  it('refuses a date that isn’t one, ranges that don’t fit, and too many', () => {
    expect(dateOverridesOf({ '2026-02-30': [] }, NOW)).toMatch(/not a date/)
    expect(dateOverridesOf({ '2026-12-01': [{ start: '10:00', end: '09:00' }] }, NOW)).toMatch(/2026-12-01/)
    expect(dateOverridesOf({ '2026-12-01': [{ start: '09:00', end: '11:00' }, { start: '10:00', end: '12:00' }] }, NOW)).toMatch(/overlapping/)
    const many = Object.fromEntries(Array.from({ length: LINK_DATE_OVERRIDES_MAX + 1 }, (_, i) => [new Date(NOW + (i + 1) * 86_400_000).toISOString().slice(0, 10), []]))
    expect(dateOverridesOf(many, NOW)).toMatch(/At most/)
  })

  it('the input takes dates as keys and ranges as values, nothing else', () => {
    expect(linkFieldsInput.safeParse({ date_overrides: { '2026-12-01': [{ start: '09:00', end: '10:00' }] } }).success).toBe(true)
    expect(linkFieldsInput.safeParse({ date_overrides: { tomorrow: [] } }).success).toBe(false)
    expect(linkFieldsInput.safeParse({ date_overrides: { '2026-12-01': [{ start: '9am', end: '10:00' }] } }).success).toBe(false)
  })
})
