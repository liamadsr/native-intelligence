import { describe, expect, it } from 'vitest'
import { isSameDay, parseISO } from 'date-fns'

import { buildEventsByDay, compactTime, compactTimeRange, getEventsForDay, positionDayEvents } from '@/calendar/helpers'
import type { IEvent } from '@/calendar/interfaces'

/**
 * The day index replaced a per-cell `events.filter(...)` in the month and year
 * grids (O(cells x events) ISO parses — ~150k of them per year-view render).
 * These tests pin the index to the exact semantics of the predicates it
 * replaced, so a future change can't quietly drop events from a cell.
 */

function ev(id: string, start: Date, end: Date): IEvent {
  return {
    id,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    title: id,
    color: 'blue',
    description: '',
  }
}

/** The predicate month cells used before the index. */
function legacyMonthCellFilter(date: Date, events: IEvent[]) {
  return events.filter((event) => {
    const start = parseISO(event.startDate)
    const end = parseISO(event.endDate)
    return (date >= start && date <= end) || isSameDay(date, start) || isSameDay(date, end)
  })
}

/** The predicate year cells used before the index. */
function legacyYearCellFilter(date: Date, events: IEvent[]) {
  return events.filter(
    (event) => isSameDay(parseISO(event.startDate), date) || isSameDay(parseISO(event.endDate), date),
  )
}

const ids = (events: IEvent[]) => events.map((e) => e.id).sort()

describe('buildEventsByDay', () => {
  it('indexes a single-day event on its own day only', () => {
    const events = [ev('a', new Date(2026, 5, 10, 9, 0), new Date(2026, 5, 10, 10, 0))]
    const index = buildEventsByDay(events)

    expect(ids(getEventsForDay(index, new Date(2026, 5, 10)))).toEqual(['a'])
    expect(getEventsForDay(index, new Date(2026, 5, 9))).toEqual([])
    expect(getEventsForDay(index, new Date(2026, 5, 11))).toEqual([])
  })

  it('indexes a multi-day event on every day it spans, inclusive', () => {
    const events = [ev('m', new Date(2026, 5, 10, 22, 0), new Date(2026, 5, 13, 2, 0))]
    const index = buildEventsByDay(events)

    for (const day of [10, 11, 12, 13]) {
      expect(ids(getEventsForDay(index, new Date(2026, 5, day)))).toEqual(['m'])
    }
    expect(getEventsForDay(index, new Date(2026, 5, 14))).toEqual([])
  })

  it('spans across month and year boundaries', () => {
    const events = [ev('y', new Date(2025, 11, 30, 10, 0), new Date(2026, 0, 2, 10, 0))]
    const index = buildEventsByDay(events)

    expect(ids(getEventsForDay(index, new Date(2025, 11, 31)))).toEqual(['y'])
    expect(ids(getEventsForDay(index, new Date(2026, 0, 1)))).toEqual(['y'])
    expect(ids(getEventsForDay(index, new Date(2026, 0, 2)))).toEqual(['y'])
  })

  it('keeps an inverted range visible on both of its days', () => {
    // Corrupt provider data: end before start. The old predicates still showed
    // it on both days via their isSameDay checks — don't silently drop it.
    const events = [ev('bad', new Date(2026, 4, 10, 12, 0), new Date(2026, 4, 9, 12, 0))]
    const index = buildEventsByDay(events)

    expect(ids(getEventsForDay(index, new Date(2026, 4, 10)))).toEqual(['bad'])
    expect(ids(getEventsForDay(index, new Date(2026, 4, 9)))).toEqual(['bad'])
  })

  it('skips unparseable dates instead of throwing', () => {
    const broken = { ...ev('x', new Date(2026, 5, 1), new Date(2026, 5, 1)), startDate: 'not-a-date' }
    expect(() => buildEventsByDay([broken])).not.toThrow()
    expect(getEventsForDay(buildEventsByDay([broken]), new Date(2026, 5, 1))).toEqual([])
  })

  it('returns the same array reference for every empty day', () => {
    // Lets the memoized year/month cells bail out on a shallow prop compare.
    const index = buildEventsByDay([])
    expect(getEventsForDay(index, new Date(2026, 1, 1))).toBe(getEventsForDay(index, new Date(2026, 7, 9)))
  })

  it('matches the legacy per-cell predicates across a full year', () => {
    // A deliberately awkward mix: same-day, multi-day, month-spanning, all-day,
    // and both US DST transitions.
    const events: IEvent[] = []
    for (let i = 0; i < 120; i++) {
      const start = new Date(2026, 2, 1 + (i % 60), i % 23, 15, 0)
      const spanDays = i % 7 === 0 ? 5 : i % 11 === 0 ? 31 : 0
      const end = new Date(start.getTime() + spanDays * 86_400_000 + 90 * 60_000)
      events.push(ev(`e${i}`, start, end))
    }
    events.push(ev('dst-spring', new Date(2026, 2, 8, 1, 30), new Date(2026, 2, 8, 3, 30)))
    events.push(ev('dst-fall', new Date(2026, 10, 1, 1, 0), new Date(2026, 10, 1, 2, 0)))
    events.push(ev('all-day', new Date(2026, 6, 4, 0, 0, 0), new Date(2026, 6, 4, 23, 59, 59)))

    const index = buildEventsByDay(events)

    for (let month = 0; month < 12; month++) {
      const daysInMonth = new Date(2026, month + 1, 0).getDate()
      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(2026, month, day)
        const indexed = ids(getEventsForDay(index, date))

        // Month cells: the index must reproduce the old result exactly.
        expect(indexed).toEqual(ids(legacyMonthCellFilter(date, events)))

        // Year cells matched only the start/end day, so the spanning index is a
        // superset — it must never LOSE an event the old filter showed.
        for (const id of ids(legacyYearCellFilter(date, events))) {
          expect(indexed).toContain(id)
        }
      }
    }
  })
})

describe('positionDayEvents and the compact clock', () => {
  const day = new Date(2026, 10, 20)
  const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m).toISOString()
  const ev = (id: string, start: string, end: string): IEvent => ({ id, title: id, description: '', color: 'blue', startDate: start, endDate: end })

  it('places a later meeting on top of an earlier one, further in, both reaching the same right edge', () => {
    const placed = positionDayEvents([ev('long', at(10), at(12)), ev('late', at(10, 30), at(11))], day, { from: 8, to: 18 })
    const style = (id: string) => placed.find((p) => p.event.id === id)!.style as Record<string, string | number>
    expect(style('long').left).toBe('0%')
    expect(parseFloat(String(style('late').left))).toBeGreaterThan(0)
    expect(parseFloat(String(style('late').left)) + parseFloat(String(style('late').width))).toBeCloseTo(parseFloat(String(style('long').width)))
    // Painted in the order they come back in (one layer): the later one after the earlier one, whatever order they arrived in.
    expect(placed.map((p) => p.event.id)).toEqual(['long', 'late'])
    const reversed = positionDayEvents([ev('late', at(10, 30), at(11)), ev('long', at(10), at(12))], day, { from: 8, to: 18 })
    expect(reversed.map((p) => p.event.id)).toEqual(['long', 'late'])
    expect(style('late')['--event-z']).toBe(style('long')['--event-z'])
    expect(style('long').top).toBe('20%')
    expect(style('long').height).toBe('192px')
  })

  it('draws a five-minute event a quarter of an hour tall', () => {
    const [placed] = positionDayEvents([ev('ping', at(9), at(9, 5))], day, { from: 8, to: 18 })
    expect(placed.style.height).toBe('24px')
  })

  it('says a time range with am/pm once when both ends share it', () => {
    expect(compactTimeRange(new Date(2026, 10, 20, 10), new Date(2026, 10, 20, 11, 30))).toBe('10 – 11:30am')
    expect(compactTimeRange(new Date(2026, 10, 20, 11, 30), new Date(2026, 10, 20, 13))).toBe('11:30am – 1pm')
    expect(compactTime(new Date(2026, 10, 20, 9))).toBe('9am')
  })
})
