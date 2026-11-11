/**
 * An all-day event is calendar dates (Google's `date`, Outlook's all-day
 * midnights), reaching the engine as UTC midnights: it takes the dates it
 * names in every zone, from UTC+14 to UTC-11, and on a daylight-saving day.
 * The desktop's Exchange rows, stored at the Mac's local midnight, keep the
 * half-day rule. Also: a clock time a spring-forward change skips is the
 * instant the clock jumped to, offered once, and touching working ranges
 * are one free stretch.
 */
import { describe, expect, it } from 'vitest'
import { checkSpansFree } from '../slot-check'
import { freeWindows, openTimes, type DayRange } from '../engine'
import { addDays, allDayTakesDay, dayKey, localDate, zonedTime, type LocalDay } from '../zone'

const everyDay = (ranges: DayRange[]): DayRange[][] => [0, 1, 2, 3, 4, 5, 6].map(() => ranges)
const NINE_TO_FIVE = everyDay([{ start: '09:00', end: '17:00' }])
const dayOff = (date: string, days = 1) => {
  const start = Date.parse(`${date}T00:00:00.000Z`)
  return { start: new Date(start).toISOString(), end: new Date(start + days * 86_400_000).toISOString(), allDay: true as const }
}

/** The local dates the engine offers any time on, over the three days from `first`. */
function offeredDays(timeZone: string, first: LocalDay, busy: ReturnType<typeof dayOff>[]): string[] {
  const times = openTimes({ schedule: { timeZone, weekly: NINE_TO_FIVE }, busy, firstDay: first, days: 3, durationMinutes: 60 })
  return [...new Set(times.map((t) => dayKey(localDate(t.start, timeZone))))]
}

describe('an all-day day off takes its own date in every zone', () => {
  const cases: Array<[string, string, LocalDay]> = [
    ['Pacific/Auckland in summer (UTC+13)', 'Pacific/Auckland', { y: 2026, m: 11, d: 11 }],
    ['Pacific/Auckland in winter (UTC+12)', 'Pacific/Auckland', { y: 2026, m: 7, d: 14 }],
    ['Pacific/Kiritimati (UTC+14)', 'Pacific/Kiritimati', { y: 2026, m: 11, d: 11 }],
    ['Pacific/Pago_Pago (UTC-11)', 'Pacific/Pago_Pago', { y: 2026, m: 11, d: 11 }],
    ['America/New_York on the fall-back day', 'America/New_York', { y: 2026, m: 10, d: 31 }],
    ['America/New_York on the spring-forward day', 'America/New_York', { y: 2026, m: 3, d: 7 }],
  ]
  for (const [name, zone, first] of cases) {
    it(name, () => {
      const off = dayKey(addDays(first, 1))
      const last = dayKey(addDays(first, 2))
      expect(offeredDays(zone, first, [dayOff(off)])).toEqual([dayKey(first), last])
      expect(offeredDays(zone, first, [])).toEqual([dayKey(first), off, last])
    })
  }

  it('a two-day block takes both dates and nothing more (Auckland)', () => {
    const first = { y: 2026, m: 11, d: 11 }
    expect(offeredDays('Pacific/Auckland', first, [dayOff('2026-11-11', 2)])).toEqual(['2026-11-13'])
  })

  it('allDayTakesDay reads a date block by its dates', () => {
    const block = { start: Date.parse('2026-11-12T00:00:00Z'), end: Date.parse('2026-11-13T00:00:00Z') }
    expect(allDayTakesDay(block, { y: 2026, m: 11, d: 12 }, 'Pacific/Kiritimati')).toBe(true)
    expect(allDayTakesDay(block, { y: 2026, m: 11, d: 13 }, 'Pacific/Kiritimati')).toBe(false)
    expect(allDayTakesDay(block, { y: 2026, m: 11, d: 11 }, 'Pacific/Pago_Pago')).toBe(false)
  })

  it("keeps the half-day rule for an Exchange row stored at the Mac's local midnight", () => {
    // Nov 12 in New York (EST): 05:00Z to 05:00Z.
    const block = { start: Date.parse('2026-11-12T05:00:00Z'), end: Date.parse('2026-11-13T05:00:00Z') }
    expect(allDayTakesDay(block, { y: 2026, m: 11, d: 12 }, 'America/New_York')).toBe(true)
    expect(allDayTakesDay(block, { y: 2026, m: 11, d: 13 }, 'America/New_York')).toBe(false)
  })

  it('slot checks read a day off by its date too (Auckland)', async () => {
    const tenAm = zonedTime({ y: 2026, m: 11, d: 12 }, '10:00', 'Pacific/Auckland')
    const nextDay = zonedTime({ y: 2026, m: 11, d: 13 }, '10:00', 'Pacific/Auckland')
    const result = await checkSpansFree(
      { userId: 'u1', timeZone: 'Pacific/Auckland', spans: [{ start: tenAm, end: tenAm + 3_600_000 }, { start: nextDay, end: nextDay + 3_600_000 }] },
      { hasCalendar: async () => true, listEvents: async () => [{ id: 'e1', title: 'Day off', start: '2026-11-12', end: '2026-11-13', isAllDay: true }] },
    )
    expect(result).toEqual({ known: true, busy: [true, false] })
  })
})

describe('daylight-saving clock times', () => {
  const NY = 'America/New_York'
  it('maps a skipped time to the instant the clock jumped to', () => {
    // Mar 8 2026: 02:00 EST jumps to 03:00 EDT (07:00Z).
    expect(new Date(zonedTime({ y: 2026, m: 3, d: 8 }, '02:30', NY)).toISOString()).toBe('2026-03-08T07:30:00.000Z')
    expect(new Date(zonedTime({ y: 2026, m: 3, d: 8 }, '03:00', NY)).toISOString()).toBe('2026-03-08T07:00:00.000Z')
    expect(new Date(zonedTime({ y: 2026, m: 3, d: 8 }, '01:30', NY)).toISOString()).toBe('2026-03-08T06:30:00.000Z')
  })

  it('keeps the first of a repeated time on the fall-back day', () => {
    expect(new Date(zonedTime({ y: 2026, m: 11, d: 1 }, '01:30', NY)).toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('a skipped midnight is the first instant of the day (Santiago)', () => {
    // Sep 6 2026: 00:00 -04 jumps to 01:00 -03 (04:00Z).
    expect(new Date(zonedTime({ y: 2026, m: 9, d: 6 }, '00:00', 'America/Santiago')).toISOString()).toBe('2026-09-06T04:00:00.000Z')
  })

  it('offers each hour of a 23-hour day once', () => {
    const times = openTimes({ schedule: { timeZone: NY, weekly: everyDay([{ start: '00:00', end: '24:00' }]) }, busy: [], firstDay: { y: 2026, m: 3, d: 8 }, days: 1, durationMinutes: 60 })
    const starts = times.map((t) => t.start)
    expect(new Set(starts).size).toBe(starts.length)
    expect(starts).toHaveLength(23)
  })
})

describe('touching working ranges', () => {
  it('are one free stretch, so a meeting across noon is found', () => {
    const windows = freeWindows({
      schedule: { timeZone: 'America/New_York', weekly: everyDay([{ start: '09:00', end: '12:00' }, { start: '12:00', end: '18:00' }]) },
      busy: [],
      firstDay: { y: 2026, m: 11, d: 2 },
      days: 1,
      minMinutes: 30,
    })
    expect(windows.map((w) => [new Date(w.start).toISOString(), new Date(w.end).toISOString()])).toEqual([['2026-11-02T14:00:00.000Z', '2026-11-02T23:00:00.000Z']])
  })
})
