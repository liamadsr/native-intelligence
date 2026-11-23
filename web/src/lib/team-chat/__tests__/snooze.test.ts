import { describe, expect, it } from 'vitest'
import { isSnoozeChoice, isSnoozed, snoozeLabel, snoozeUntil, snoozeUntilError, SNOOZE_MAX_MS } from '../snooze'

// Local-clock dates, so the tests hold in any time zone.
const now = new Date(2026, 10, 23, 14, 30, 0)

describe('snoozeUntil', () => {
  it('an hour from now', () => {
    expect(snoozeUntil('hour', now).getTime()).toBe(now.getTime() + 3_600_000)
  })
  it('tomorrow is 8:00 the next morning, local', () => {
    const at = snoozeUntil('tomorrow', now)
    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()]).toEqual([2026, 10, 24, 8, 0])
  })
  it('tomorrow from just after midnight is still the next day', () => {
    const at = snoozeUntil('tomorrow', new Date(2026, 10, 23, 0, 5))
    expect(at.getDate()).toBe(24)
  })
  it('tomorrow crosses a month end', () => {
    const at = snoozeUntil('tomorrow', new Date(2026, 10, 30, 22, 0))
    expect([at.getMonth(), at.getDate()]).toEqual([11, 1])
  })
  it('a week', () => {
    expect(snoozeUntil('week', now).getTime() - now.getTime()).toBe(7 * 24 * 3_600_000)
  })
})

describe('snoozeUntilError', () => {
  it('takes a future time within 31 days', () => {
    expect(snoozeUntilError(new Date(now.getTime() + 60_000).toISOString(), now)).toBeNull()
    expect(snoozeUntilError(new Date(now.getTime() + SNOOZE_MAX_MS).toISOString(), now)).toBeNull()
  })
  it('refuses the past, now, too far, and junk', () => {
    expect(snoozeUntilError(new Date(now.getTime() - 1).toISOString(), now)).toMatch(/future/)
    expect(snoozeUntilError(now.toISOString(), now)).toMatch(/future/)
    expect(snoozeUntilError(new Date(now.getTime() + SNOOZE_MAX_MS + 1).toISOString(), now)).toMatch(/31 days/)
    expect(snoozeUntilError('soon', now)).toMatch(/time/)
    expect(snoozeUntilError(42, now)).toMatch(/time/)
  })
})

describe('isSnoozed', () => {
  it('only while the time is ahead', () => {
    expect(isSnoozed(null, now)).toBe(false)
    expect(isSnoozed(new Date(now.getTime() + 1000).toISOString(), now)).toBe(true)
    expect(isSnoozed(new Date(now.getTime() - 1000).toISOString(), now)).toBe(false)
    expect(isSnoozed('nonsense', now)).toBe(false)
  })
})

describe('snoozeLabel', () => {
  it('today shows the time', () => {
    expect(snoozeLabel(new Date(2026, 10, 23, 15, 30).toISOString(), now, 'en-US')).toBe('Muted until 3:30 PM')
  })
  it('tomorrow says so', () => {
    expect(snoozeLabel(new Date(2026, 10, 24, 8, 0).toISOString(), now, 'en-US')).toBe('Muted until tomorrow, 8:00 AM')
  })
  it('later days give the date', () => {
    expect(snoozeLabel(new Date(2026, 10, 30, 14, 30).toISOString(), now, 'en-US')).toBe('Muted until Mon, Nov 30, 2:30 PM')
  })
})

describe('isSnoozeChoice', () => {
  it('the three timed choices only', () => {
    expect(['hour', 'tomorrow', 'week'].every(isSnoozeChoice)).toBe(true)
    expect(isSnoozeChoice('forever')).toBe(false)
  })
})
