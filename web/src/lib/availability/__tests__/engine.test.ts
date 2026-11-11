/**
 * The availability engine (../engine.ts): working hours in the person's zone
 * minus their busy time. A fixed grid (openTimes) and whole free stretches
 * (freeWindows) over the same days; an override replaces a whole day; a
 * buffer widens each timed block; an all-day block takes its own local day;
 * worked across the Nov 1 2026 daylight-saving change in New York.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_WEEKLY, freeWindows, openTimes, subtractSpans, suggestTimes, type AvailabilitySchedule, type DayRange, type Span } from '../engine'

const NY = 'America/New_York'
const iso = (at: number) => new Date(at).toISOString()
const isos = (spans: readonly Span[]) => spans.map((s) => [iso(s.start), iso(s.end)])
const at = (value: string) => Date.parse(value)
const span = (start: string, end: string): Span => ({ start: at(start), end: at(end) })

/** The same ranges every day of the week. */
const everyDay = (ranges: DayRange[]): DayRange[][] => [0, 1, 2, 3, 4, 5, 6].map(() => ranges)
const schedule = (weekly: readonly (readonly DayRange[])[], overrides?: Record<string, DayRange[]>): AvailabilitySchedule => ({ timeZone: NY, weekly, ...(overrides ? { overrides } : {}) })

// Monday Nov 2 2026 (EST, UTC-5).
const MON = { y: 2026, m: 11, d: 2 }
// Friday Oct 30 2026 (EDT, UTC-4).
const FRI = { y: 2026, m: 10, d: 30 }

describe('the default hours', () => {
  it('are weekdays 9 to 6, weekends off', () => {
    expect(DEFAULT_WEEKLY).toHaveLength(7)
    expect(DEFAULT_WEEKLY[0]).toEqual([])
    expect(DEFAULT_WEEKLY[6]).toEqual([])
    for (let d = 1; d <= 5; d++) expect(DEFAULT_WEEKLY[d]).toEqual([{ start: '09:00', end: '18:00' }])
  })
})

describe('openTimes: the grid', () => {
  it('cuts each working range from its start, keeps only times that fit, soonest first', () => {
    const weekly = everyDay([
      { start: '09:00', end: '10:00' },
      { start: '13:00', end: '14:30' },
    ])
    const times = openTimes({ schedule: schedule(weekly), busy: [], firstDay: MON, days: 1, durationMinutes: 60 })
    // 13:00 fits; 14:00 would run past 14:30.
    expect(isos(times)).toEqual([
      ['2026-11-02T14:00:00.000Z', '2026-11-02T15:00:00.000Z'],
      ['2026-11-02T18:00:00.000Z', '2026-11-02T19:00:00.000Z'],
    ])
  })

  it('a shorter step than the duration overlaps the times; the cap stops it', () => {
    const weekly = everyDay([{ start: '09:00', end: '11:00' }])
    const times = openTimes({ schedule: schedule(weekly), busy: [], firstDay: MON, days: 1, durationMinutes: 60, stepMinutes: 30 })
    expect(times.map((t) => iso(t.start))).toEqual(['2026-11-02T14:00:00.000Z', '2026-11-02T14:30:00.000Z', '2026-11-02T15:00:00.000Z'])
    expect(openTimes({ schedule: schedule(weekly), busy: [], firstDay: MON, days: 3, durationMinutes: 30, max: 2 })).toHaveLength(2)
  })

  it('weekends off by default; a day with no ranges offers nothing', () => {
    // Fri Oct 30 to Mon Nov 2: Friday and Monday only.
    const times = openTimes({ schedule: schedule(DEFAULT_WEEKLY), busy: [], firstDay: FRI, days: 4, durationMinutes: 540 })
    expect(isos(times)).toEqual([
      ['2026-10-30T13:00:00.000Z', '2026-10-30T22:00:00.000Z'],
      ['2026-11-02T14:00:00.000Z', '2026-11-02T23:00:00.000Z'],
    ])
  })

  it('leaves out a time a busy block overlaps, and keeps one that only touches it', () => {
    const weekly = everyDay([{ start: '09:00', end: '12:00' }])
    const busy = [{ start: '2026-11-02T15:00:00.000Z', end: '2026-11-02T16:00:00.000Z' }]
    const times = openTimes({ schedule: schedule(weekly), busy, firstDay: MON, days: 1, durationMinutes: 60 })
    expect(times.map((t) => iso(t.start))).toEqual(['2026-11-02T14:00:00.000Z', '2026-11-02T16:00:00.000Z'])
  })

  it('a buffer widens the block on both sides', () => {
    const weekly = everyDay([{ start: '09:00', end: '12:00' }])
    // 10:00 to 11:00 local, 15 minutes kept clear each side.
    const busy = [{ start: '2026-11-02T15:00:00.000Z', end: '2026-11-02T16:00:00.000Z' }]
    const times = openTimes({ schedule: schedule(weekly), busy, firstDay: MON, days: 1, durationMinutes: 30, stepMinutes: 15, bufferMinutes: 15 })
    expect(times.map((t) => iso(t.start))).toEqual([
      '2026-11-02T14:00:00.000Z', // 9:00
      '2026-11-02T14:15:00.000Z', // 9:15, ends 9:45
      '2026-11-02T16:15:00.000Z', // 11:15
      '2026-11-02T16:30:00.000Z', // 11:30
    ])
  })

  it('nothing starts before notBefore or after startNotAfter', () => {
    const weekly = everyDay([{ start: '09:00', end: '12:00' }])
    const times = openTimes({
      schedule: schedule(weekly),
      busy: [],
      firstDay: MON,
      days: 1,
      durationMinutes: 60,
      notBefore: at('2026-11-02T14:30:00.000Z'),
      startNotAfter: at('2026-11-02T16:00:00.000Z'),
    })
    // 9:00 is before notBefore; 11:00 starts exactly at the limit and stays.
    expect(times.map((t) => iso(t.start))).toEqual(['2026-11-02T15:00:00.000Z', '2026-11-02T16:00:00.000Z'])
  })

  it('a range may end at 24:00', () => {
    const weekly = everyDay([{ start: '22:00', end: '24:00' }])
    const times = openTimes({ schedule: schedule(weekly), busy: [], firstDay: MON, days: 1, durationMinutes: 60 })
    expect(isos(times)).toEqual([
      ['2026-11-03T03:00:00.000Z', '2026-11-03T04:00:00.000Z'],
      ['2026-11-03T04:00:00.000Z', '2026-11-03T05:00:00.000Z'],
    ])
  })

  it('stays on the wall clock across the daylight-saving change', () => {
    // Fri Oct 30 (EDT) to Mon Nov 2 (EST): 9:00 local is 13:00Z, then 14:00Z.
    const times = openTimes({ schedule: schedule(DEFAULT_WEEKLY), busy: [], firstDay: FRI, days: 4, durationMinutes: 60, max: 100 })
    expect(times[0].start).toBe(at('2026-10-30T13:00:00.000Z'))
    expect(times.find((t) => t.start >= at('2026-11-01T00:00:00.000Z'))?.start).toBe(at('2026-11-02T14:00:00.000Z'))
    expect(times.filter((t) => iso(t.start).startsWith('2026-11-02'))).toHaveLength(9)
  })
})

describe('overrides', () => {
  it("a date's ranges replace that whole day; an empty one is a day off; other days keep the week", () => {
    const sched = schedule(DEFAULT_WEEKLY, {
      '2026-11-02': [{ start: '13:00', end: '15:00' }],
      '2026-11-03': [],
      // A Saturday, normally off.
      '2026-11-07': [{ start: '10:00', end: '11:00' }],
    })
    const times = openTimes({ schedule: sched, busy: [], firstDay: MON, days: 6, durationMinutes: 60, max: 100 })
    const byDay = (day: string) => times.filter((t) => iso(t.start).startsWith(day)).map((t) => iso(t.start))
    expect(byDay('2026-11-02')).toEqual(['2026-11-02T18:00:00.000Z', '2026-11-02T19:00:00.000Z'])
    expect(byDay('2026-11-03')).toEqual([])
    expect(byDay('2026-11-04')).toHaveLength(9)
    expect(byDay('2026-11-07')).toEqual(['2026-11-07T15:00:00.000Z'])

    const free = freeWindows({ schedule: sched, busy: [], firstDay: MON, days: 2, minMinutes: 30 })
    expect(isos(free)).toEqual([['2026-11-02T18:00:00.000Z', '2026-11-02T20:00:00.000Z']])
  })
})

describe('all-day blocks', () => {
  it("take their own local day, not the evening before (a provider's dates are UTC midnights)", () => {
    const weekly = everyDay([{ start: '09:00', end: '24:00' }])
    // Google's all-day Nov 3: UTC midnights, which start at 7 PM Monday in New York.
    const busy = [{ start: '2026-11-03T00:00:00.000Z', end: '2026-11-04T00:00:00.000Z', allDay: true as const }]
    const free = freeWindows({ schedule: schedule(weekly), busy, firstDay: MON, days: 3, minMinutes: 30 })
    expect(isos(free)).toEqual([
      // Monday whole, evening included: an all-day block is never a time.
      ['2026-11-02T14:00:00.000Z', '2026-11-03T05:00:00.000Z'],
      ['2026-11-04T14:00:00.000Z', '2026-11-05T05:00:00.000Z'],
    ])
    expect(openTimes({ schedule: schedule(weekly), busy, firstDay: MON, days: 3, durationMinutes: 60, max: 100 }).some((t) => iso(t.start).startsWith('2026-11-03T1'))).toBe(false)
  })

  it('a block over several days takes each of them', () => {
    const busy = [{ start: '2026-11-02T05:00:00.000Z', end: '2026-11-04T05:00:00.000Z', allDay: true as const }]
    const free = freeWindows({ schedule: schedule(DEFAULT_WEEKLY), busy, firstDay: MON, days: 3, minMinutes: 30 })
    expect(isos(free)).toEqual([['2026-11-04T14:00:00.000Z', '2026-11-04T23:00:00.000Z']])
  })
})

describe('freeWindows', () => {
  it('the working hours minus the busy blocks (buffered), stretches shorter than the minimum dropped', () => {
    const busy = [
      // 10:00 to 11:00 local.
      { start: '2026-11-02T15:00:00.000Z', end: '2026-11-02T16:00:00.000Z' },
      // 11:20 to 17:30 local: buffered, the two blocks meet; 17:45 to 18:00 is left (15 minutes).
      { start: '2026-11-02T16:20:00.000Z', end: '2026-11-02T22:30:00.000Z' },
    ]
    const free = freeWindows({ schedule: schedule(DEFAULT_WEEKLY), busy, firstDay: MON, days: 1, bufferMinutes: 15, minMinutes: 30 })
    expect(isos(free)).toEqual([['2026-11-02T14:00:00.000Z', '2026-11-02T14:45:00.000Z']])
    const short = freeWindows({ schedule: schedule(DEFAULT_WEEKLY), busy, firstDay: MON, days: 1, bufferMinutes: 15, minMinutes: 15 })
    expect(isos(short)).toEqual([
      ['2026-11-02T14:00:00.000Z', '2026-11-02T14:45:00.000Z'],
      ['2026-11-02T22:45:00.000Z', '2026-11-02T23:00:00.000Z'],
    ])
  })

  it('clips to notBefore and notAfter', () => {
    const free = freeWindows({
      schedule: schedule(DEFAULT_WEEKLY),
      busy: [],
      firstDay: MON,
      days: 2,
      minMinutes: 30,
      notBefore: at('2026-11-02T20:00:00.000Z'),
      notAfter: at('2026-11-03T16:00:00.000Z'),
    })
    expect(isos(free)).toEqual([
      ['2026-11-02T20:00:00.000Z', '2026-11-02T23:00:00.000Z'],
      ['2026-11-03T14:00:00.000Z', '2026-11-03T16:00:00.000Z'],
    ])
  })

  it('a range ending at 24:00 runs to the next midnight', () => {
    const free = freeWindows({ schedule: schedule(everyDay([{ start: '20:00', end: '24:00' }])), busy: [], firstDay: MON, days: 1, minMinutes: 30 })
    expect(isos(free)).toEqual([['2026-11-03T01:00:00.000Z', '2026-11-03T05:00:00.000Z']])
  })

  it('the long Sunday of the change is 25 hours', () => {
    const sun = { y: 2026, m: 11, d: 1 }
    const free = freeWindows({ schedule: schedule(everyDay([{ start: '00:00', end: '24:00' }])), busy: [], firstDay: sun, days: 1, minMinutes: 30 })
    expect(isos(free)).toEqual([['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']])
    expect(free[0].end - free[0].start).toBe(25 * 60 * 60_000)
  })

  it('an unreadable busy block is ignored, never read as the whole day', () => {
    const free = freeWindows({ schedule: schedule(DEFAULT_WEEKLY), busy: [{ start: 'soon', end: 'later' }], firstDay: MON, days: 1, minMinutes: 30 })
    expect(isos(free)).toEqual([['2026-11-02T14:00:00.000Z', '2026-11-02T23:00:00.000Z']])
  })
})

describe('subtractSpans', () => {
  const S = (a: number, b: number): Span => ({ start: a, end: b })

  it('no holes: the spans as they were', () => {
    expect(subtractSpans([S(0, 10)], [])).toEqual([S(0, 10)])
  })

  it('a hole inside splits the span; one over an edge trims it; one that covers it removes it', () => {
    expect(subtractSpans([S(0, 10)], [S(3, 5)])).toEqual([S(0, 3), S(5, 10)])
    expect(subtractSpans([S(0, 10)], [S(-5, 2)])).toEqual([S(2, 10)])
    expect(subtractSpans([S(0, 10)], [S(8, 20)])).toEqual([S(0, 8)])
    expect(subtractSpans([S(0, 10)], [S(-1, 11)])).toEqual([])
    expect(subtractSpans([S(0, 10)], [S(0, 10)])).toEqual([])
  })

  it('holes that only touch, or lie outside, cut nothing', () => {
    expect(subtractSpans([S(0, 10)], [S(-5, 0), S(10, 15), S(20, 30)])).toEqual([S(0, 10)])
  })

  it('overlapping holes in any order, over several spans', () => {
    expect(subtractSpans([S(0, 10), S(20, 30)], [S(25, 27), S(4, 6), S(2, 5), S(9, 22)])).toEqual([S(0, 2), S(6, 9), S(22, 25), S(27, 30)])
  })

  it('a hole nested inside another', () => {
    expect(subtractSpans([S(0, 10)], [S(2, 8), S(3, 4)])).toEqual([S(0, 2), S(8, 10)])
  })
})

describe('suggestTimes', () => {
  const opts = { durationMinutes: 30, timeZone: NY }
  const startsOf = (spans: readonly Span[]) => spans.map((s) => iso(s.start))

  it('one per local day, soonest day first, three by default', () => {
    const windows = [
      span('2026-11-02T14:00:00.000Z', '2026-11-02T23:00:00.000Z'),
      span('2026-11-03T14:00:00.000Z', '2026-11-03T23:00:00.000Z'),
      span('2026-11-04T14:00:00.000Z', '2026-11-04T23:00:00.000Z'),
      span('2026-11-05T14:00:00.000Z', '2026-11-05T23:00:00.000Z'),
    ]
    const picks = suggestTimes(windows, opts)
    // 10:00 local each day.
    expect(startsOf(picks)).toEqual(['2026-11-02T15:00:00.000Z', '2026-11-03T15:00:00.000Z', '2026-11-04T15:00:00.000Z'])
    expect(picks.every((p) => p.end - p.start === 30 * 60_000)).toBe(true)
    expect(suggestTimes(windows, { ...opts, max: 1 })).toHaveLength(1)
    // Windows in any order: still soonest day first.
    expect(startsOf(suggestTimes([...windows].reverse(), opts))).toEqual(startsOf(picks))
  })

  it('the first quarter hour from 10:00 to noon', () => {
    // Free 9:00 to 9:45, then 10:20 to noon.
    const picks = suggestTimes([span('2026-11-02T14:00:00.000Z', '2026-11-02T14:45:00.000Z'), span('2026-11-02T15:20:00.000Z', '2026-11-02T17:00:00.000Z')], opts)
    expect(startsOf(picks)).toEqual(['2026-11-02T15:30:00.000Z'])
  })

  it('nothing in the morning: the first quarter hour from 2:00 to 4:00, not an earlier one', () => {
    // Free 9:00 to 9:45, then 12:30 to 1:00, then 2:30 to 5:00.
    const picks = suggestTimes(
      [span('2026-11-02T14:00:00.000Z', '2026-11-02T14:45:00.000Z'), span('2026-11-02T17:30:00.000Z', '2026-11-02T18:00:00.000Z'), span('2026-11-02T19:30:00.000Z', '2026-11-02T22:00:00.000Z')],
      opts,
    )
    expect(startsOf(picks)).toEqual(['2026-11-02T19:30:00.000Z'])
  })

  it('neither: the day’s earliest start', () => {
    // Free 12:00 to 1:00, then 4:30 to 6:00.
    const picks = suggestTimes([span('2026-11-02T21:30:00.000Z', '2026-11-02T23:00:00.000Z'), span('2026-11-02T17:00:00.000Z', '2026-11-02T18:00:00.000Z')], opts)
    expect(startsOf(picks)).toEqual(['2026-11-02T17:00:00.000Z'])
  })

  it('starts on a quarter hour, and only where the whole meeting fits', () => {
    // Free 10:07 to 10:40: 10:15 to 10:45 would not fit a 30-minute meeting; 10:07 is not a quarter hour.
    expect(suggestTimes([span('2026-11-02T15:07:00.000Z', '2026-11-02T15:40:00.000Z')], opts)).toEqual([])
    const picks = suggestTimes([span('2026-11-02T15:07:00.000Z', '2026-11-02T15:50:00.000Z')], opts)
    expect(isos(picks)).toEqual([['2026-11-02T15:15:00.000Z', '2026-11-02T15:45:00.000Z']])
  })

  it('a window past local midnight counts toward the day each start falls on', () => {
    // 10 PM Monday to 1 AM Tuesday, New York.
    const picks = suggestTimes([span('2026-11-03T03:00:00.000Z', '2026-11-03T06:00:00.000Z')], opts)
    expect(startsOf(picks)).toEqual(['2026-11-03T03:00:00.000Z', '2026-11-03T05:00:00.000Z'])
  })

  it('nothing free, nothing suggested', () => {
    expect(suggestTimes([], opts)).toEqual([])
  })
})
