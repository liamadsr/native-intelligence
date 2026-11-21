import type { CalendarEvent } from '@/lib/integrations/calendar'
import type { IEvent } from '@/calendar/interfaces'
import type { TEventColor } from '@/calendar/types'
import { CALENDAR_COLORS } from '@/calendar/event-colors'

/**
 * A calendar's colour: one of the calm calendar hues (CALENDAR_COLORS), the
 * same for every event on that calendar of that account. An event that says
 * neither is blue, never a colour of its own.
 */
export function calendarColor(accountId: string | undefined, calendarName: string | undefined): TEventColor {
  const key = `${accountId ?? ''}|${calendarName ?? ''}`
  if (key === '|') return 'blue'
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash)
  }
  return CALENDAR_COLORS[Math.abs(hash) % CALENDAR_COLORS.length]
}

/** The owner's answer as the grid draws it: Google's and Microsoft's words for the same four states. */
export function eventResponse(myResponse: string | undefined): IEvent['response'] {
  switch (myResponse) {
    case 'accepted':
    case 'organizer':
      return 'accepted'
    case 'declined':
      return 'declined'
    case 'tentative':
    case 'tentativelyAccepted':
      return 'tentative'
    case 'needsAction':
    case 'notResponded':
      return 'pending'
    default:
      return undefined
  }
}

function priorityToColor(priority: string): TEventColor {
  switch (priority) {
    case 'urgent': return 'red'
    case 'high': return 'orange'
    case 'medium': return 'yellow'
    case 'low': return 'blue'
    default: return 'gray'
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const utcYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const localYmd = (ms: number) => {
  const d = new Date(ms)
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
}
const dayBefore = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

/**
 * An all-day event's days as floating calendar dates: `start` the first day,
 * `end` the LAST day it covers (inclusive, as every calendar view reads
 * endDate). An all-day event is days on a calendar, never instants: read as
 * instants, "Thursday" from a provider that says midnight UTC becomes
 * Wednesday afternoon in any zone west of Greenwich, and the event is drawn a
 * day early and a day long.
 *
 * The providers say it three ways:
 *  - Google: dates, the end exclusive ('2026-11-26' to '2026-11-27').
 *  - Microsoft Graph: midnight to midnight as UTC date-times, the end
 *    exclusive ('2026-11-26T00:00:00.000Z' to '2026-11-27T00:00:00.000Z'):
 *    the days are the UTC dates.
 *  - The desktop's Exchange calendar (EventKit): the Mac's own midnight to
 *    the end of the last day, as instants: the days are that clock's dates
 *    (the same Mac shows them).
 * A start exactly on a UTC midnight is read the Graph way, any other the
 * Mac's way. `toLocalDate` is the reader's clock (tests pass a zone's).
 */
export function allDayDates(start: string, end: string, toLocalDate: (ms: number) => string = localYmd): { start: string; end: string } | null {
  const startIsDate = DATE_ONLY.test(start)
  const startMs = startIsDate ? NaN : new Date(start).getTime()
  if (!startIsDate && Number.isNaN(startMs)) return null
  const floating = startIsDate || startMs % DAY_MS === 0
  const dateOf = floating ? utcYmd : toLocalDate
  const first = startIsDate ? start : dateOf(startMs)

  let last: string
  if (DATE_ONLY.test(end)) {
    // Exclusive: the day after the last one.
    last = dayBefore(end)
  } else {
    const endMs = new Date(end).getTime()
    // The instant it is over; a millisecond earlier is still inside its last day.
    last = Number.isNaN(endMs) ? first : dateOf(endMs - 1)
  }
  return { start: first, end: last > first ? last : first }
}

/**
 * The inverse, for code that needs an all-day event's end as an INSTANT (a
 * capture's scheduled_end, "is it live now"): the day after the last covered
 * day, i.e. the provider's exclusive end. A timed or non-date-only end is
 * returned unchanged.
 */
export function exclusiveEndDate(event: Pick<IEvent, 'isAllDay' | 'endDate'>): string {
  if (!event.isAllDay || !DATE_ONLY.test(event.endDate)) return event.endDate
  const [y, m, d] = event.endDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

export function calendarEventToIEvent(event: CalendarEvent): IEvent {
  const days = event.isAllDay ? allDayDates(event.start, event.end) : null
  return {
    id: event.id,
    startDate: days?.start ?? event.start,
    endDate: days?.end ?? event.end,
    title: event.title,
    color: calendarColor(event.accountId, event.calendarName),
    description: event.description || '',
    htmlLink: event.htmlLink,
    location: event.location,
    conferenceUrl: event.conferenceUrl,
    calendarName: event.calendarName,
    isAllDay: event.isAllDay,
    attendees: event.attendees,
    attendeeDetails: event.attendeeDetails,
    source: event.source,
    calendarId: event.calendarId,
    hasRecurrence: event.hasRecurrence,
    seriesMasterId: event.seriesMasterId,
    icalUid: event.icalUid,
    provider: event.provider,
    ...(event.accountId ? { accountId: event.accountId } : {}),
    ...(event.accountEmail ? { accountEmail: event.accountEmail } : {}),
    ...(eventResponse(event.myResponse) ? { response: eventResponse(event.myResponse) } : {}),
  }
}

export function actionToIEvent(action: {
  id: string
  identifier: string
  title: string
  due_at: string
  priority: string
}): IEvent {
  return {
    id: `action-${action.id}`,
    startDate: action.due_at,
    endDate: action.due_at,
    title: action.title,
    color: priorityToColor(action.priority),
    description: '',
    isAllDay: false,
    isAction: true,
    actionId: action.id,
    actionIdentifier: action.identifier,
    actionPriority: action.priority,
  }
}
