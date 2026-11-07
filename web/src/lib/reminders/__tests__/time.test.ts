/**
 * Reminder time math. Every preset is LOCAL wall-clock arithmetic, so all
 * fixtures are built with the `new Date(y, m, d, ...)` local constructor and
 * asserted against locally-constructed expectations — the suite is
 * independent of the machine's timezone.
 *
 * Anchor `now` throughout: Thu 6 Aug 2026, 19:36:12.345 local.
 */
import { describe, it, expect } from 'vitest'
import {
  atNine,
  formatFromNow,
  formatReminderDate,
  reminderPresets,
} from '../time'

/** Thu 6 Aug 2026, 19:36:12.345 local. */
const NOW = new Date(2026, 7, 6, 19, 36, 12, 345)

function preset(id: 'hour' | 'tomorrow' | 'next_week' | 'month', now: Date = NOW): Date {
  const found = reminderPresets(now).find((p) => p.id === id)
  if (!found) throw new Error(`missing preset ${id}`)
  return found.date
}

describe('atNine', () => {
  it('moves to 09:00:00.000 on the same local day', () => {
    expect(atNine(NOW)).toEqual(new Date(2026, 7, 6, 9, 0, 0, 0))
  })

  it('does not mutate its argument', () => {
    const input = new Date(2026, 7, 6, 19, 36, 12, 345)
    atNine(input)
    expect(input).toEqual(NOW)
  })
})

describe('reminderPresets', () => {
  it('returns the four rows in display order with their labels', () => {
    expect(reminderPresets(NOW).map((p) => [p.id, p.label])).toEqual([
      ['hour', 'An hour from now'],
      ['tomorrow', 'Tomorrow'],
      ['next_week', 'Next week'],
      ['month', 'A month from now'],
    ])
  })

  it('hour is exactly +1h, seconds and milliseconds preserved', () => {
    expect(preset('hour')).toEqual(new Date(2026, 7, 6, 20, 36, 12, 345))
  })

  it('tomorrow is the next calendar day at 09:00', () => {
    expect(preset('tomorrow')).toEqual(new Date(2026, 7, 7, 9, 0, 0, 0))
  })

  it('next week is the following Monday at 09:00', () => {
    expect(preset('next_week')).toEqual(new Date(2026, 7, 10, 9, 0, 0, 0))
  })

  it('next week on a Monday jumps a full week, never today', () => {
    // Mon 10 Aug 2026, 08:00 — before 09:00, so "today at 9" would still be
    // in the future. It must still roll to the NEXT Monday.
    const monday = new Date(2026, 7, 10, 8, 0, 0, 0)
    expect(preset('next_week', monday)).toEqual(new Date(2026, 7, 17, 9, 0, 0, 0))
  })

  it('next week on a Sunday is tomorrow', () => {
    const sunday = new Date(2026, 7, 9, 19, 0, 0, 0)
    expect(preset('next_week', sunday)).toEqual(new Date(2026, 7, 10, 9, 0, 0, 0))
  })

  it('a month from now is the same day number next month at 09:00', () => {
    expect(preset('month')).toEqual(new Date(2026, 8, 6, 9, 0, 0, 0))
  })

  it('clamps the day when the next month is shorter (Aug 31 → Sep 30)', () => {
    const aug31 = new Date(2026, 7, 31, 19, 36, 0, 0)
    expect(preset('month', aug31)).toEqual(new Date(2026, 8, 30, 9, 0, 0, 0))
  })

  it('clamps into February (Jan 31 2026 → Feb 28)', () => {
    const jan31 = new Date(2026, 0, 31, 12, 0, 0, 0)
    expect(preset('month', jan31)).toEqual(new Date(2026, 1, 28, 9, 0, 0, 0))
  })

  it('clamps into a leap February (Jan 31 2028 → Feb 29)', () => {
    const jan31 = new Date(2028, 0, 31, 12, 0, 0, 0)
    expect(preset('month', jan31)).toEqual(new Date(2028, 1, 29, 9, 0, 0, 0))
  })

  it('rolls the year over from December', () => {
    const dec15 = new Date(2026, 11, 15, 22, 0, 0, 0)
    expect(preset('month', dec15)).toEqual(new Date(2027, 0, 15, 9, 0, 0, 0))
  })

  it('every preset is strictly in the future', () => {
    for (const p of reminderPresets(NOW)) {
      expect(p.date.getTime()).toBeGreaterThan(NOW.getTime())
    }
  })
})

describe('formatReminderDate', () => {
  it('renders the picker row format', () => {
    expect(formatReminderDate(new Date(2026, 7, 6, 20, 36))).toBe('Thu, 6 Aug, 8:36 PM')
  })

  it('renders morning times without a leading zero on the hour', () => {
    expect(formatReminderDate(new Date(2026, 7, 7, 9, 0))).toBe('Fri, 7 Aug, 9:00 AM')
  })

  it('renders midnight as 12 AM', () => {
    expect(formatReminderDate(new Date(2026, 11, 1, 0, 5))).toBe('Tue, 1 Dec, 12:05 AM')
  })
})

describe('formatFromNow', () => {
  const from = (ms: number) => formatFromNow(new Date(NOW.getTime() + ms), NOW)

  it('collapses anything within 45s to "now"', () => {
    expect(from(0)).toBe('now')
    expect(from(45_000)).toBe('now')
  })

  it('treats an already-past target as "now" (the cron has not swept yet)', () => {
    expect(from(-5 * 60_000)).toBe('now')
    expect(from(-3 * 86_400_000)).toBe('now')
  })

  it('formats minutes, singular at one', () => {
    expect(from(60_000)).toBe('1 minute from now')
    expect(from(25 * 60_000)).toBe('25 minutes from now')
  })

  it('formats hours, singular at one', () => {
    expect(from(3_600_000)).toBe('1 hour from now')
    expect(from(13 * 3_600_000)).toBe('13 hours from now')
  })

  it('formats days, singular at one', () => {
    expect(from(86_400_000)).toBe('1 day from now')
    expect(from(9 * 86_400_000)).toBe('9 days from now')
  })

  it('formats months, singular at one', () => {
    expect(from(30 * 86_400_000)).toBe('1 month from now')
    expect(from(95 * 86_400_000)).toBe('3 months from now')
  })

  it('formats years once past twelve 30-day months', () => {
    expect(from(365 * 86_400_000)).toBe('1 year from now')
    expect(from(2 * 365 * 86_400_000)).toBe('2 years from now')
  })

  // Each unit rounds BEFORE its threshold is tested, so the top half of a
  // bucket promotes to the next unit instead of naming that unit's own
  // ceiling ("60 minutes", "24 hours", "30 days", "12 months").
  it('promotes to the next unit rather than naming a bucket ceiling', () => {
    expect(from(59.6 * 60_000)).toBe('1 hour from now')
    expect(from(23.6 * 3_600_000)).toBe('1 day from now')
    expect(from(29.6 * 86_400_000)).toBe('1 month from now')
    expect(from(348 * 86_400_000)).toBe('1 year from now')
  })

  it('still uses the smaller unit just below each rounding boundary', () => {
    expect(from(59 * 60_000)).toBe('59 minutes from now')
    expect(from(23 * 3_600_000)).toBe('23 hours from now')
    expect(from(29 * 86_400_000)).toBe('29 days from now')
    expect(from(11 * 30 * 86_400_000)).toBe('11 months from now')
  })

  it('accepts an ISO string, matching what the reminder row stores', () => {
    const target = new Date(NOW.getTime() + 13 * 3_600_000)
    expect(formatFromNow(target.toISOString(), NOW)).toBe('13 hours from now')
  })
})
