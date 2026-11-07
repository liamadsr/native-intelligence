import { describe, it, expect } from 'vitest'
import {
  describeDay,
  describeDue,
  describeDuration,
  describeWhen,
  isPastDay,
  isPastDue,
  safeTimeZone,
  type Clock,
} from '../when'

// Sunday Sep 27 2026, 3:00 PM in Los Angeles (22:00 UTC).
const clock: Clock = { now: new Date('2026-09-27T22:00:00Z'), timeZone: 'America/Los_Angeles' }
const la = (local: string) => new Date(`${local}-07:00`) // PDT

describe('describeWhen — past', () => {
  it('minutes and hours today', () => {
    expect(describeWhen(la('2026-09-27T14:59:40'), clock)).toBe('just now')
    expect(describeWhen(la('2026-09-27T14:57:00'), clock)).toBe('a few minutes ago')
    expect(describeWhen(la('2026-09-27T14:35:00'), clock)).toBe('about 25 minutes ago')
    expect(describeWhen(la('2026-09-27T14:33:00'), clock)).toBe('about 25 minutes ago') // to the nearest five
    expect(describeWhen(la('2026-09-27T09:00:00'), clock)).toBe('today at 9 AM')
    expect(describeWhen(la('2026-09-27T11:30:00'), clock)).toBe('today at 11:30 AM')
  })

  it('yesterday, this week, last week', () => {
    expect(describeWhen(la('2026-09-26T15:00:00'), clock)).toBe('yesterday at 3 PM')
    // Tuesday Sep 22 is in this ISO week (Mon Sep 21 – Sun Sep 27).
    expect(describeWhen(la('2026-09-22T14:00:00'), clock)).toBe('on Tuesday')
    const wed: Clock = { ...clock, now: new Date('2026-09-30T22:00:00Z') }
    expect(describeWhen(la('2026-09-25T10:00:00'), wed)).toBe('last Friday')
  })

  it('days, weeks, then a plain date (the year only when it differs)', () => {
    expect(describeWhen(la('2026-09-17T10:00:00'), clock)).toBe('10 days ago')
    expect(describeWhen(la('2026-09-03T10:00:00'), clock)).toBe('3 weeks ago')
    expect(describeWhen(la('2026-06-01T10:00:00'), clock)).toBe('on June 1')
    expect(describeWhen(la('2025-12-03T10:00:00'), clock)).toBe('on December 3, 2025')
  })

  it('uses the wall clock of the given zone', () => {
    // 01:00 UTC Sep 27 is 6 PM Sep 26 in LA: yesterday there, today in UTC.
    expect(describeWhen('2026-09-27T01:00:00Z', clock)).toBe('yesterday at 6 PM')
    expect(describeWhen('2026-09-27T01:00:00Z', { ...clock, timeZone: 'UTC' })).toBe('today at 1 AM')
  })

  it('nothing, or an unreadable time, is null', () => {
    expect(describeWhen(null, clock)).toBeNull()
    expect(describeWhen('not a date', clock)).toBeNull()
  })
})

describe('describeWhen — ahead', () => {
  it('soon, later today, tomorrow, this week, later', () => {
    expect(describeWhen(la('2026-09-27T15:02:00'), clock)).toBe('in a few minutes')
    expect(describeWhen(la('2026-09-27T15:25:00'), clock)).toBe('in about 25 minutes')
    expect(describeWhen(la('2026-09-27T15:58:00'), clock)).toBe('in about 55 minutes')
    expect(describeWhen(la('2026-09-27T18:00:00'), clock)).toBe('today at 6 PM')
    expect(describeWhen(la('2026-09-28T10:00:00'), clock)).toBe('tomorrow at 10 AM')
    expect(describeWhen(la('2026-10-01T14:00:00'), clock)).toBe('on Thursday at 2 PM')
    expect(describeWhen(la('2026-10-12T14:30:00'), clock)).toBe('on October 12 at 2:30 PM')
  })
})

describe('describeDay', () => {
  it('a day relative to today', () => {
    expect(describeDay('2026-09-27', clock)).toBe('today')
    expect(describeDay('2026-09-28', clock)).toBe('tomorrow')
    expect(describeDay('2026-09-26', clock)).toBe('yesterday')
    expect(describeDay('2026-10-02', clock)).toBe('on Friday')
    expect(describeDay('2026-09-24', clock)).toBe('on Thursday') // earlier this week
    expect(describeDay('2026-09-24', { ...clock, now: new Date('2026-09-29T22:00:00Z') })).toBe('last Thursday')
    expect(describeDay('2026-09-10', clock)).toBe('on September 10')
    expect(describeDay('2026-11-02', clock)).toBe('on November 2')
    expect(describeDay('2026-09-28T00:00:00Z', clock)).toBe('tomorrow') // a timestamp's date part
    expect(describeDay(null, clock)).toBeNull()
    expect(describeDay('soon', clock)).toBeNull()
  })
})

describe('describeDue', () => {
  it('a day for dates and all-day stamps (midnight or end of day, UTC), a moment otherwise', () => {
    expect(describeDue('2026-09-28', clock)).toBe('tomorrow')
    expect(describeDue('2026-10-02T00:00:00+00:00', clock)).toBe('on Friday')
    expect(describeDue('2026-10-02T00:00:00.000Z', clock)).toBe('on Friday')
    expect(describeDue('2026-10-02T23:59:59+00:00', clock)).toBe('on Friday')
    expect(describeDue('2026-10-02T23:59:59.999Z', clock)).toBe('on Friday')
    // A bare-day due date as dueAtFromDate writes it (noon UTC) is still a day.
    expect(describeDue('2026-10-02T12:00:00.000Z', clock)).toBe('on Friday')
    // ...and as PostgREST returns that timestamptz.
    expect(describeDue('2026-10-02T12:00:00+00:00', clock)).toBe('on Friday')
    expect(describeDue(la('2026-09-28T16:00:00').toISOString(), clock)).toBe('tomorrow at 4 PM')
    expect(describeDue(null, clock)).toBeNull()
  })
})

describe('isPastDay / isPastDue', () => {
  it('a day is past once it is over in the user’s zone; a moment once it has passed', () => {
    expect(isPastDay('2026-09-26', clock)).toBe(true)
    expect(isPastDay('2026-09-27', clock)).toBe(false) // today: not over yet
    expect(isPastDay(null, clock)).toBe(false)
    expect(isPastDue('2026-09-27', clock)).toBe(false)
    expect(isPastDue('2026-09-26T00:00:00Z', clock)).toBe(true) // an all-day date
    expect(isPastDue(la('2026-09-27T14:00:00').toISOString(), clock)).toBe(true)
    expect(isPastDue(la('2026-09-27T16:00:00').toISOString(), clock)).toBe(false)
    expect(isPastDue('soon', clock)).toBe(false)
  })
})

describe('describeDuration', () => {
  it('rounds the way people say it', () => {
    expect(describeDuration(null)).toBeNull()
    expect(describeDuration(0)).toBeNull()
    expect(describeDuration(20)).toBe('under a minute')
    expect(describeDuration(60)).toBe('about 1 minute')
    expect(describeDuration(7 * 60)).toBe('about 7 minutes')
    expect(describeDuration(41 * 60)).toBe('about 40 minutes')
    expect(describeDuration(58 * 60)).toBe('about an hour')
    expect(describeDuration(92 * 60)).toBe('about an hour and a half')
    expect(describeDuration(125 * 60)).toBe('about 2 hours')
    expect(describeDuration(150 * 60)).toBe('about 2 and a half hours')
  })
})

describe('safeTimeZone', () => {
  it('keeps a real zone, and falls back to UTC', () => {
    expect(safeTimeZone('Europe/London')).toBe('Europe/London')
    expect(safeTimeZone('Mars/Olympus')).toBe('UTC')
    expect(safeTimeZone(undefined)).toBe('UTC')
  })
})
