import { describe, it, expect } from 'vitest'
import { dueAtFromDate } from '@/lib/actions/due-at'

describe('dueAtFromDate', () => {
  it('writes a bare day at noon UTC, so it reads as the same day from UTC-11 to UTC+11', () => {
    const due = dueAtFromDate('2026-10-21')
    expect(due).toBe('2026-10-21T12:00:00.000Z')
    for (const timeZone of ['Pacific/Pago_Pago', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo', 'Pacific/Noumea']) {
      expect(new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(due as string))).toBe('2026-10-21')
    }
  })

  it('passes timestamps and clears through untouched', () => {
    expect(dueAtFromDate('2026-10-21T17:30:00-07:00')).toBe('2026-10-21T17:30:00-07:00')
    expect(dueAtFromDate('')).toBe('')
    expect(dueAtFromDate(null)).toBeNull()
    expect(dueAtFromDate(undefined)).toBeUndefined()
  })
})
