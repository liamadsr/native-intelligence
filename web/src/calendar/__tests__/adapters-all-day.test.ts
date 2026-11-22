import { describe, expect, it } from 'vitest'
import { allDayDates, calendarColor, calendarEventToIEvent, eventResponse, exclusiveEndDate } from '@/calendar/adapters'
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
  })
})

describe('all-day events are calendar days, never instants', () => {
  /** A reader's clock in a named zone: the local date of an instant there. */
  const clockIn = (timeZone: string) => (ms: number) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))
    const get = (type: string) => parts.find((p) => p.type === type)!.value
    return `${get('year')}-${get('month')}-${get('day')}`
  }
  const ZONES = ['America/Los_Angeles', 'America/New_York', 'UTC', 'Europe/Berlin', 'Asia/Kolkata', 'Pacific/Auckland', 'Pacific/Honolulu']

  it.each(ZONES)('Google’s dates (end exclusive) are the same days in %s', (zone) => {
    expect(allDayDates('2026-11-26', '2026-11-27', clockIn(zone))).toEqual({ start: '2026-11-26', end: '2026-11-26' })
    expect(allDayDates('2026-11-22', '2026-11-28', clockIn(zone))).toEqual({ start: '2026-11-22', end: '2026-11-27' })
  })

  it.each(ZONES)('Microsoft’s UTC midnights are their UTC dates in %s: Thanksgiving stays on Thursday', (zone) => {
    // Thu Nov 26, as Graph sends an all-day event: midnight to midnight, UTC, the end exclusive.
    expect(allDayDates('2026-11-26T00:00:00.000Z', '2026-11-27T00:00:00.000Z', clockIn(zone))).toEqual({ start: '2026-11-26', end: '2026-11-26' })
    expect(allDayDates('2026-11-27T00:00:00.000Z', '2026-11-28T00:00:00.000Z', clockIn(zone))).toEqual({ start: '2026-11-27', end: '2026-11-27' })
    // Sun to Fri, six days.
    expect(allDayDates('2026-11-22T00:00:00.000Z', '2026-11-28T00:00:00.000Z', clockIn(zone))).toEqual({ start: '2026-11-22', end: '2026-11-27' })
  })

  it('the Mac’s own midnights (the desktop’s Exchange calendar) are that clock’s dates, east or west of Greenwich', () => {
    // Nov 26 all day on a Mac in Los Angeles (UTC-8): 08:00Z to 07:59:59Z the next day.
    expect(allDayDates('2026-11-26T08:00:00.000Z', '2026-11-27T07:59:59.000Z', clockIn('America/Los_Angeles'))).toEqual({ start: '2026-11-26', end: '2026-11-26' })
    // The same day on a Mac in Berlin (UTC+1): it starts on the 25th by UTC.
    expect(allDayDates('2026-11-25T23:00:00.000Z', '2026-11-26T22:59:59.000Z', clockIn('Europe/Berlin'))).toEqual({ start: '2026-11-26', end: '2026-11-26' })
    // An exclusive end at the Mac's midnight is still the day before.
    expect(allDayDates('2026-11-25T23:00:00.000Z', '2026-11-27T23:00:00.000Z', clockIn('Europe/Berlin'))).toEqual({ start: '2026-11-26', end: '2026-11-27' })
    // Kolkata is half an hour off the hour.
    expect(allDayDates('2026-11-25T18:30:00.000Z', '2026-11-26T18:30:00.000Z', clockIn('Asia/Kolkata'))).toEqual({ start: '2026-11-26', end: '2026-11-26' })
  })

  it('never ends before it starts, and gives up on a start that is no date', () => {
    expect(allDayDates('2026-11-26', '2026-11-26')).toEqual({ start: '2026-11-26', end: '2026-11-26' })
    expect(allDayDates('2026-11-26', '2026-11-20')).toEqual({ start: '2026-11-26', end: '2026-11-26' })
    expect(allDayDates('2026-11-26T00:00:00.000Z', 'nonsense')).toEqual({ start: '2026-11-26', end: '2026-11-26' })
    expect(allDayDates('nonsense', '2026-11-27')).toBeNull()
  })

  it('the adapter hands every view dates for an all-day event, whichever way the provider said it', () => {
    const microsoft = calendarEventToIEvent({ ...base, isAllDay: true, start: '2026-11-26T00:00:00.000Z', end: '2026-11-27T00:00:00.000Z' })
    expect([microsoft.startDate, microsoft.endDate]).toEqual(['2026-11-26', '2026-11-26'])
    const google = calendarEventToIEvent({ ...base, isAllDay: true, start: '2026-11-22', end: '2026-11-28' })
    expect([google.startDate, google.endDate]).toEqual(['2026-11-22', '2026-11-27'])
    // A timed event keeps its instants.
    const timed = calendarEventToIEvent({ ...base, start: '2026-11-26T00:00:00.000Z', end: '2026-11-27T00:00:00.000Z' })
    expect([timed.startDate, timed.endDate]).toEqual(['2026-11-26T00:00:00.000Z', '2026-11-27T00:00:00.000Z'])
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
