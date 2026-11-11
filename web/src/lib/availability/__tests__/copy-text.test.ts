/**
 * Copy availability (../copy-text.ts): the ranges end at a local day's end;
 * the text is one line per day in the person's zone, the zone named; it is
 * worked out by the engine (working hours, counted calendars, all-day
 * events); a calendar that can't be read is unknown, never a guess.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '@/lib/integrations/calendar'
import { memoryDb } from '@/test/memory-db'
import { availabilityText, copyRangeSpan, formatAvailabilityText, isCopyRange } from '../copy-text'

const NY = 'America/New_York'
const at = (value: string) => Date.parse(value)
const iso = (ms: number) => new Date(ms).toISOString()
// Tuesday Nov 10 2026, 8:00 in New York (EST).
const TUE_8AM = at('2026-11-10T13:00:00.000Z')

describe('the ranges', () => {
  it('end at the end of a local day', () => {
    expect(iso(copyRangeSpan('today', TUE_8AM, NY).end)).toBe('2026-11-11T05:00:00.000Z')
    // The calendar's weeks run Sunday to Saturday: this week ends Saturday night.
    expect(iso(copyRangeSpan('this_week', TUE_8AM, NY).end)).toBe('2026-11-15T05:00:00.000Z')
    expect(iso(copyRangeSpan('next_7_days', TUE_8AM, NY).end)).toBe('2026-11-17T05:00:00.000Z')
    expect(iso(copyRangeSpan('next_14_days', TUE_8AM, NY).end)).toBe('2026-11-24T05:00:00.000Z')
    expect(copyRangeSpan('today', TUE_8AM, NY).start).toBe(TUE_8AM)
  })

  it('this week on a Saturday is the rest of Saturday', () => {
    const sat = at('2026-11-14T15:00:00.000Z')
    expect(iso(copyRangeSpan('this_week', sat, NY).end)).toBe('2026-11-15T05:00:00.000Z')
  })

  it('knows its four ranges only', () => {
    for (const r of ['today', 'this_week', 'next_7_days', 'next_14_days']) expect(isCopyRange(r)).toBe(true)
    expect(isCopyRange('next_month')).toBe(false)
  })
})

describe('formatAvailabilityText', () => {
  it('one line per day, the zone named, plain spaces', () => {
    const text = formatAvailabilityText(
      [
        { start: at('2026-11-12T19:00:00.000Z'), end: at('2026-11-12T23:00:00.000Z') },
        { start: at('2026-11-12T14:00:00.000Z'), end: at('2026-11-12T16:30:00.000Z') },
        { start: at('2026-11-13T14:00:00.000Z'), end: at('2026-11-13T15:00:00.000Z') },
      ],
      NY,
      TUE_8AM,
    )
    expect(text).toBe(['My availability (EST):', 'Thu, Nov 12: 9:00 AM – 11:30 AM, 2:00 PM – 6:00 PM', 'Fri, Nov 13: 9:00 AM – 10:00 AM'].join('\n'))
    expect(text).not.toMatch(/[  ]/)
  })

  it('across a daylight-saving change: the place in the heading, each day its own zone', () => {
    const text = formatAvailabilityText(
      [
        { start: at('2026-10-30T13:00:00.000Z'), end: at('2026-10-30T15:00:00.000Z') },
        { start: at('2026-11-03T14:00:00.000Z'), end: at('2026-11-03T16:00:00.000Z') },
      ],
      NY,
      TUE_8AM,
    )
    expect(text).toBe(['My availability (New York time):', 'Fri, Oct 30 (EDT): 9:00 AM – 11:00 AM', 'Tue, Nov 3 (EST): 9:00 AM – 11:00 AM'].join('\n'))
  })

  it('nothing free: says so', () => {
    expect(formatAvailabilityText([], NY, TUE_8AM)).toBe('My availability (EST):\nNo open time in this range.')
  })
})

describe('availabilityText', () => {
  const tables = () => ({ availability_schedule: [], member: [{ id: 'm-ada', workspace_id: 'ws-fernhill', user_id: 'user-ada', time_zone: NY }], user_profiles: [] })
  const event = (start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: start, title: 'Busy', start, end, attendees: [], ...extra })
  const base = { userId: 'user-ada', workspaceId: 'ws-fernhill', range: 'today' as const, now: TUE_8AM }

  it("today's free time inside working hours, around meetings, with no gap kept", async () => {
    const listEvents = vi.fn(async () => [event('2026-11-10T16:00:00.000Z', '2026-11-10T17:00:00.000Z')])
    const out = await availabilityText(base, { supabase: memoryDb(tables()), calendarProvider: async () => 'google', listEvents })
    expect(out).toEqual({ known: true, timeZone: NY, text: 'My availability (EST):\nTue, Nov 10: 9:00 AM – 11:00 AM, 12:00 PM – 6:00 PM' })
    expect(listEvents).toHaveBeenCalledWith('user-ada', expect.objectContaining({ workspaceId: 'ws-fernhill', strict: true }))
  })

  it('an all-day event takes the day', async () => {
    const listEvents = vi.fn(async () => [event('2026-11-10', '2026-11-11', { isAllDay: true })])
    const out = await availabilityText(base, { supabase: memoryDb(tables()), calendarProvider: async () => 'google', listEvents })
    expect(out).toMatchObject({ known: true, text: 'My availability (EST):\nNo open time in this range.' })
  })

  it("the browser's zone when the hours follow the person", async () => {
    const listEvents = vi.fn(async () => [])
    const out = await availabilityText({ ...base, browserTimeZone: 'America/Chicago' }, { supabase: memoryDb(tables()), calendarProvider: async () => 'google', listEvents })
    expect(out).toMatchObject({ known: true, timeZone: 'America/Chicago' })
    expect(out.known && out.text.split('\n')[0]).toBe('My availability (CST):')
  })

  it('unknown, never a guess: a calendar that cannot be read, or none connected', async () => {
    const failing = vi.fn(async () => Promise.reject(new Error('A calendar account needs signing in again')))
    expect(await availabilityText(base, { supabase: memoryDb(tables()), calendarProvider: async () => 'google', listEvents: failing })).toEqual({ known: false, reason: 'A calendar account needs signing in again' })
    const none = vi.fn(async () => [])
    expect(await availabilityText(base, { supabase: memoryDb(tables()), calendarProvider: async () => null, listEvents: none })).toEqual({ known: false, reason: 'No calendar is connected' })
    expect(none).not.toHaveBeenCalled()
  })
})
