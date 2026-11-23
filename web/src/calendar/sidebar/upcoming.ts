/**
 * The sidebar's "Upcoming events": the next few events from now, whatever
 * date the grid is at. An event stays while it hasn't ended (one in progress
 * reads "Now"); declined events and tasks are left out; all-day events count.
 *
 * Pure. The behaviour follows the reference product's calendar sidebar
 * (AGPL-3.0); none of its code is here.
 */
import type { IEvent } from '@/calendar/interfaces'

export const UPCOMING_LIMIT = 5

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** A date-only value is that calendar day in the reader's zone, not midnight UTC. */
function localDay(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function eventStart(event: Pick<IEvent, 'startDate' | 'isAllDay'>): Date {
  return DATE_ONLY.test(event.startDate) ? localDay(event.startDate) : new Date(event.startDate)
}

/** The instant an event is over. An all-day event's endDate is the last day it covers: it ends when that day does. */
export function eventEnd(event: Pick<IEvent, 'endDate' | 'isAllDay'>): Date {
  if (DATE_ONLY.test(event.endDate)) {
    const day = localDay(event.endDate)
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  }
  return new Date(event.endDate)
}

/** The next `limit` events that haven't ended, soonest first. */
export function upcomingEvents(events: readonly IEvent[], now: Date, limit = UPCOMING_LIMIT): IEvent[] {
  const at = now.getTime()
  return events
    .filter((event) => !event.isAction && event.response !== 'declined')
    .map((event) => ({ event, start: eventStart(event).getTime(), end: eventEnd(event).getTime() }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end > at)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .slice(0, limit)
    .map(({ event }) => event)
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/**
 * When a row is: "Now", "2:00 PM" (later today), "Tomorrow · 9:30 AM",
 * "Dec 3 · 9:30 AM"; an all-day event says its day and "All day".
 */
export function upcomingLabel(event: Pick<IEvent, 'startDate' | 'endDate' | 'isAllDay'>, now: Date, locale = 'en-US'): string {
  const start = eventStart(event)
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const day = sameDay(start, now) || start < now ? 'Today' : sameDay(start, tomorrow) ? 'Tomorrow' : start.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  if (event.isAllDay) return `${day} · All day`
  if (start <= now) return 'Now'
  const time = start.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  return day === 'Today' ? time : `${day} · ${time}`
}
