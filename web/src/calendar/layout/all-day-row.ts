/**
 * The all-day row above the week grid: every event that spans days (or is
 * all-day) as ONE bar across the days it covers, on the same row all week.
 *
 * The row used to be drawn a day column at a time, each column packing its
 * own events, so one event came out as a block per day and stepped between
 * rows from one day to the next. Here the week is laid out once:
 *
 *  - an event's days are calendar days (an all-day event's dates are floating:
 *    adapters' allDayDates), clipped to the week; a part cut off by the
 *    week's edge is marked, so the bar is squared there and runs on in the
 *    neighbouring week;
 *  - lanes are packed greedily, the longest bar first (then the earliest, then
 *    by title), each into the first lane free on all of its days.
 *
 * Written for this app. Pure: events and the week's first day in, bars out.
 */
import type { IEvent } from '@/calendar/interfaces'

export interface AllDayBar {
  event: IEvent
  /** First and last day column of the week it covers, 0-6. */
  startIndex: number
  endIndex: number
  /** The row it is on, 0 first. */
  lane: number
  /** It began before this week / runs on after it: no rounded end there. */
  startsBefore: boolean
  endsAfter: boolean
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

/** A calendar day as a whole number (days since 1970 on a clock with no zone), so day arithmetic never meets a DST change. */
function dayNumber(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m, d) / DAY_MS)
}

/** The first and last calendar day an event touches, in the reader's zone. Null for a date that can't be read. */
export function eventDaySpan(event: Pick<IEvent, 'startDate' | 'endDate'>): { first: number; last: number } | null {
  let first: number
  if (DATE_ONLY.test(event.startDate)) {
    const [y, m, d] = event.startDate.split('-').map(Number)
    first = dayNumber(y, m - 1, d)
  } else {
    const start = new Date(event.startDate)
    if (Number.isNaN(start.getTime())) return null
    first = dayNumber(start.getFullYear(), start.getMonth(), start.getDate())
  }
  let last: number
  if (DATE_ONLY.test(event.endDate)) {
    // Inclusive already (the adapter's all-day end is the last day covered).
    const [y, m, d] = event.endDate.split('-').map(Number)
    last = dayNumber(y, m - 1, d)
  } else {
    const end = new Date(event.endDate)
    if (Number.isNaN(end.getTime())) return null
    // A timed event that ends exactly at midnight doesn't reach into that day.
    const inside = new Date(Math.max(end.getTime() - 1, new Date(event.startDate).getTime() || 0))
    last = dayNumber(inside.getFullYear(), inside.getMonth(), inside.getDate())
  }
  return { first, last: Math.max(first, last) }
}

/** The week's bars, laid out. `weekStart` is the first day shown (any time of that day); `days` how many columns. */
export function layoutAllDayRow(events: readonly IEvent[], weekStart: Date, days = 7): AllDayBar[] {
  const week = dayNumber(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate())
  const bars: AllDayBar[] = []
  for (const event of events) {
    const span = eventDaySpan(event)
    if (!span) continue
    const from = span.first - week
    const to = span.last - week
    if (to < 0 || from > days - 1) continue
    bars.push({
      event,
      startIndex: Math.max(0, from),
      endIndex: Math.min(days - 1, to),
      lane: 0,
      startsBefore: from < 0,
      endsAfter: to > days - 1,
    })
  }

  bars.sort(
    (a, b) =>
      b.endIndex - b.startIndex - (a.endIndex - a.startIndex) ||
      a.startIndex - b.startIndex ||
      a.event.title.localeCompare(b.event.title) ||
      (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0),
  )

  // occupied[lane][day]
  const occupied: boolean[][] = []
  for (const bar of bars) {
    let lane = occupied.findIndex((taken) => {
      for (let day = bar.startIndex; day <= bar.endIndex; day++) if (taken[day]) return false
      return true
    })
    if (lane === -1) {
      lane = occupied.length
      occupied.push(new Array<boolean>(days).fill(false))
    }
    for (let day = bar.startIndex; day <= bar.endIndex; day++) occupied[lane][day] = true
    bar.lane = lane
  }
  return bars
}
