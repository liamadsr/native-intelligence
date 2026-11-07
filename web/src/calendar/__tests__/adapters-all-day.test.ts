import { describe, expect, it } from 'vitest'
import { calendarEventToIEvent, exclusiveEndDate } from '@/calendar/adapters'
import type { CalendarEvent } from '@/lib/integrations/calendar'

const base: CalendarEvent = { id: 'e1', title: 'Offsite', start: '', end: '' }

describe('calendarEventToIEvent all-day end', () => {
  it('turns an exclusive date-only end into the last day covered', () => {
    const one = calendarEventToIEvent({ ...base, isAllDay: true, start: '2026-10-21', end: '2026-10-22' })
    expect(one.endDate).toBe('2026-10-21')
    const multi = calendarEventToIEvent({ ...base, isAllDay: true, start: '2026-10-30', end: '2026-11-02' })
    expect(multi.endDate).toBe('2026-11-01')
  })

  it('leaves timed events and non-date-only ends alone', () => {
    const timed = calendarEventToIEvent({ ...base, start: '2026-10-21T09:00:00Z', end: '2026-10-21T10:00:00Z' })
    expect(timed.endDate).toBe('2026-10-21T10:00:00Z')
    const iso = calendarEventToIEvent({ ...base, isAllDay: true, start: '2026-10-21T00:00:00.000Z', end: '2026-10-22T00:00:00.000Z' })
    expect(iso.endDate).toBe('2026-10-22T00:00:00.000Z')
  })
})

describe('exclusiveEndDate', () => {
  it('gives an all-day event back its exclusive end (the instant it is over)', () => {
    const one = calendarEventToIEvent({ ...base, isAllDay: true, start: '2026-10-21', end: '2026-10-22' })
    expect(exclusiveEndDate(one)).toBe('2026-10-22')
    const multi = calendarEventToIEvent({ ...base, isAllDay: true, start: '2026-10-30', end: '2026-11-02' })
    expect(exclusiveEndDate(multi)).toBe('2026-11-02')
  })

  it('leaves timed and non-date-only ends alone', () => {
    expect(exclusiveEndDate({ endDate: '2026-10-21T10:00:00Z' })).toBe('2026-10-21T10:00:00Z')
    expect(exclusiveEndDate({ isAllDay: true, endDate: '2026-10-22T00:00:00.000Z' })).toBe('2026-10-22T00:00:00.000Z')
  })
})
