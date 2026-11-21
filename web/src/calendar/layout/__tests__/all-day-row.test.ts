/**
 * The week's all-day row: one bar per event across its days, on one row all
 * week. The events are made up (the shapes are the ones that used to break:
 * a six-day stay, a holiday beside it, events that begin mid-week).
 */
import { describe, expect, it } from 'vitest'
import type { IEvent } from '@/calendar/interfaces'
import { eventDaySpan, layoutAllDayRow } from '../all-day-row'

const WEEK = new Date(2026, 10, 22) // Sunday Nov 22, 2026
const allDay = (id: string, startDate: string, endDate: string): IEvent => ({ id, title: id, startDate, endDate, isAllDay: true, color: 'blue', description: '' })
const bar = (bars: ReturnType<typeof layoutAllDayRow>, id: string) => {
  const b = bars.find((x) => x.event.id === id)!
  return { days: [b.startIndex, b.endIndex], lane: b.lane, startsBefore: b.startsBefore, endsAfter: b.endsAfter }
}

describe('layoutAllDayRow', () => {
  it('draws each event as ONE bar over its days', () => {
    const bars = layoutAllDayRow([allDay('Conference in SF', '2026-11-22', '2026-11-27'), allDay('Thanksgiving Day', '2026-11-26', '2026-11-26')], WEEK)
    expect(bars).toHaveLength(2)
    expect(bar(bars, 'Conference in SF')).toEqual({ days: [0, 5], lane: 0, startsBefore: false, endsAfter: false })
    // A one-day holiday sits on its own day, Thursday, and only there.
    expect(bar(bars, 'Thanksgiving Day')).toEqual({ days: [4, 4], lane: 1, startsBefore: false, endsAfter: false })
  })

  it('keeps an event on the same row all week, the longest bars first, with no two sharing a day on a row', () => {
    const events = [
      allDay('Day After Thanksgiving', '2026-11-27', '2026-11-27'),
      allDay('Stay at the lodge', '2026-11-24', '2026-11-26'),
      allDay('US markets: short week', '2026-11-23', '2026-11-27'),
      allDay('Conference in SF', '2026-11-22', '2026-11-27'),
      allDay('Thanksgiving Day', '2026-11-26', '2026-11-26'),
      allDay('Garden week', '2026-11-22', '2026-11-23'),
    ]
    const bars = layoutAllDayRow(events, WEEK)
    expect(bar(bars, 'Conference in SF').lane).toBe(0)
    expect(bar(bars, 'US markets: short week').lane).toBe(1)
    expect(bar(bars, 'Stay at the lodge').lane).toBe(2)
    // The shorter ones fill the gaps the longer ones leave.
    expect(bar(bars, 'Garden week')).toMatchObject({ days: [0, 1], lane: 2 })
    expect(bar(bars, 'Day After Thanksgiving')).toMatchObject({ days: [5, 5], lane: 2 })
    expect(bar(bars, 'Thanksgiving Day')).toMatchObject({ days: [4, 4], lane: 3 })
    // One lane per event, and never two on the same day of a lane.
    for (let lane = 0; lane < 4; lane++) {
      const taken = new Set<number>()
      for (const b of bars.filter((x) => x.lane === lane)) {
        for (let day = b.startIndex; day <= b.endIndex; day++) {
          expect(taken.has(day)).toBe(false)
          taken.add(day)
        }
      }
    }
  })

  it('is the same layout whatever order the events arrive in', () => {
    const events = [allDay('a', '2026-11-22', '2026-11-27'), allDay('b', '2026-11-23', '2026-11-27'), allDay('c', '2026-11-24', '2026-11-26'), allDay('d', '2026-11-26', '2026-11-26')]
    const lanes = (list: IEvent[]) => Object.fromEntries(layoutAllDayRow(list, WEEK).map((b) => [b.event.id, b.lane]))
    expect(lanes([...events].reverse())).toEqual(lanes(events))
    expect(lanes([events[2], events[0], events[3], events[1]])).toEqual(lanes(events))
  })

  it('clips an event to the week and marks the side that runs on, so the bar continues across the week’s edge', () => {
    const trip = allDay('Trip', '2026-11-19', '2026-12-02')
    expect(bar(layoutAllDayRow([trip], WEEK), 'Trip')).toEqual({ days: [0, 6], lane: 0, startsBefore: true, endsAfter: true })
    expect(bar(layoutAllDayRow([trip], new Date(2026, 10, 15)), 'Trip')).toEqual({ days: [4, 6], lane: 0, startsBefore: false, endsAfter: true })
    expect(bar(layoutAllDayRow([trip], new Date(2026, 10, 29)), 'Trip')).toEqual({ days: [0, 3], lane: 0, startsBefore: true, endsAfter: false })
    // Not in the week at all: no bar.
    expect(layoutAllDayRow([trip], new Date(2026, 11, 6))).toEqual([])
    expect(layoutAllDayRow([allDay('bad', 'nonsense', '2026-11-23')], WEEK)).toEqual([])
  })

  it('reads a timed event that runs over midnight by the reader’s days, and stops at a midnight end', () => {
    const overnight: IEvent = { id: 'flight', title: 'flight', color: 'blue', description: '', startDate: new Date(2026, 10, 24, 22, 0).toISOString(), endDate: new Date(2026, 10, 25, 6, 30).toISOString() }
    expect(bar(layoutAllDayRow([overnight], WEEK), 'flight').days).toEqual([2, 3])
    const toMidnight: IEvent = { ...overnight, id: 'gala', title: 'gala', endDate: new Date(2026, 10, 25, 0, 0).toISOString() }
    expect(bar(layoutAllDayRow([toMidnight], WEEK), 'gala').days).toEqual([2, 2])
  })

  it('counts days across a clock change without losing or gaining one', () => {
    // US clocks go back on Sunday Nov 1, 2026: the week of Nov 1 has a 25-hour day.
    const span = eventDaySpan(allDay('x', '2026-10-30', '2026-11-03'))!
    expect(span.last - span.first).toBe(4)
    expect(bar(layoutAllDayRow([allDay('x', '2026-10-30', '2026-11-03')], new Date(2026, 10, 1)), 'x')).toMatchObject({ days: [0, 2], startsBefore: true })
  })
})
