import type { CalendarEvent } from '@/lib/integrations/calendar'
import type { IEvent } from '@/calendar/interfaces'
import type { TEventColor } from '@/calendar/types'

const EVENT_COLORS: TEventColor[] = ['blue', 'green', 'red', 'yellow', 'purple', 'orange', 'gray']

function hashColor(str: string): TEventColor {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  return EVENT_COLORS[Math.abs(hash) % EVENT_COLORS.length]
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

/**
 * An all-day event's end as the LAST day it covers. Google sends all-day ends
 * as an exclusive date ('YYYY-MM-DD', the day after: a one-day event on Oct 21
 * ends '2026-10-22'), while every calendar view reads endDate as inclusive.
 */
function inclusiveAllDayEnd(event: CalendarEvent): string {
  if (!event.isAllDay || !DATE_ONLY.test(event.end) || event.end <= event.start.slice(0, 10)) {
    return event.end
  }
  const [y, m, d] = event.end.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
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
  return {
    id: event.id,
    startDate: event.start,
    endDate: inclusiveAllDayEnd(event),
    title: event.title,
    color: hashColor(event.calendarName || event.id),
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
