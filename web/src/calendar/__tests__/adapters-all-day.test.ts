import { describe, expect, it } from 'vitest'
import { calendarColor, calendarEventToIEvent, eventResponse, exclusiveEndDate } from '@/calendar/adapters'
import { withCalendarColors } from '@/calendar/event-colors'
import type { IEvent } from '@/calendar/interfaces'
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

describe('calendar colours', () => {
  const ev = (id: string, accountId: string, calendarName: string, extra: Partial<IEvent> = {}): IEvent => ({
    id, title: id, description: '', startDate: '2026-11-20T10:00:00Z', endDate: '2026-11-20T11:00:00Z', color: 'blue', accountId, calendarName, ...extra,
  })

  it('gives every event of one calendar the same colour, and an event with no calendar blue', () => {
    expect(calendarColor('acc-1', 'Work')).toBe(calendarColor('acc-1', 'Work'))
    expect(calendarColor(undefined, undefined)).toBe('blue')
    expect(calendarEventToIEvent({ ...base, id: 'x' }).color).toBe('blue')
    expect(calendarEventToIEvent({ ...base, id: 'y' }).color).toBe('blue')
  })

  it('gives the calendars on screen a colour each, in name order, and leaves tasks alone', () => {
    const events = [
      ev('a', 'acc-1', 'Work'), ev('b', 'acc-2', 'Personal'), ev('c', 'acc-1', 'Team'), ev('d', 'acc-1', 'Work'),
      ev('task', '', '', { isAction: true, color: 'red' }),
    ]
    const out = withCalendarColors(events)
    const color = (id: string) => out.find((e) => e.id === id)!.color
    expect(color('a')).toBe(color('d'))
    expect(new Set([color('a'), color('b'), color('c')]).size).toBe(3)
    expect([color('c'), color('a'), color('b')]).toEqual(['blue', 'green', 'purple'])
    expect(color('task')).toBe('red')
    // Nothing to change: the same array, so memoized views stay put.
    expect(withCalendarColors(out)).toBe(out)
  })

  it('reads the owner’s answer from either provider’s words', () => {
    expect(eventResponse('needsAction')).toBe('pending')
    expect(eventResponse('notResponded')).toBe('pending')
    expect(eventResponse('tentativelyAccepted')).toBe('tentative')
    expect(eventResponse('declined')).toBe('declined')
    expect(eventResponse('organizer')).toBe('accepted')
    expect(eventResponse(undefined)).toBeUndefined()
  })
})
