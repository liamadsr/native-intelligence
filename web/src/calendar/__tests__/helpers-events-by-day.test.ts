import { describe, expect, it } from 'vitest'
import { isSameDay, parseISO } from 'date-fns'

import { buildEventsByDay, getEventsForDay } from '@/calendar/helpers'
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
