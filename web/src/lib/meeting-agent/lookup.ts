/**
 * The meeting the person is sending their agent to, read from their own
 * calendar (roadmap #12): it never attends a meeting the person isn't on.
 * Calendar events are not rows, so it is read live, in a narrow window
 * around the start, from every calendar the person connected.
 */
import { listCalendarEventsUnified, type CalendarEvent } from '@/lib/integrations/calendar'
import { dialInOfEvent, type DialIn } from './dial-in'

export interface FoundMeeting {
  event: CalendarEvent
  dialIn: DialIn | null
}

/** The window the event is looked for in, around its start. */
const WINDOW_MS = 60 * 60_000

/** The person's meeting with this id at this start, and its dial-in; null when it isn't on their calendar (or was cancelled). */
export async function findMeeting(
  userId: string,
  args: { calendarEventId: string; startsAt: string },
  deps: { list?: typeof listCalendarEventsUnified } = {},
): Promise<FoundMeeting | null> {
  const start = Date.parse(args.startsAt)
  if (!Number.isFinite(start)) return null
  const events = await (deps.list ?? listCalendarEventsUnified)(userId, {
    timeMin: new Date(start - WINDOW_MS).toISOString(),
    timeMax: new Date(start + WINDOW_MS).toISOString(),
  })
  const event = events.find((e) => e.id === args.calendarEventId && Date.parse(e.start) === start && e.status !== 'cancelled')
  return event ? { event, dialIn: dialInOfEvent(event) } : null
}
