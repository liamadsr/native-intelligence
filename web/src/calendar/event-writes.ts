/**
 * Writing a calendar event from the event card (components/dialogs/event-details-popover.tsx):
 * an edit, a delete and a "Going?" answer. The same routes and the same local
 * Exchange bridge as the full event panel
 * (app/account/(dashboard)/views/calendar-event-detail-panel.tsx), and each
 * folds what was saved into the shared events cache so every calendar on
 * screen shows it without waiting for the next poll.
 */
import { patchCalendarEventsCache } from '@/calendar/hooks/use-calendar-events'
import type { IEvent } from '@/calendar/interfaces'

export interface EventEdits {
  title: string
  start: Date
  end: Date
  location: string
  description: string
}

/** A write that didn't happen, in words to show. */
export class EventWriteError extends Error {}

function replaceInCache(updated: IEvent) {
  patchCalendarEventsCache((prev) => {
    const index = prev.findIndex((e) => e.id === updated.id)
    if (index === -1) return prev
    return [...prev.slice(0, index), updated, ...prev.slice(index + 1)]
  })
}

/** The event with these edits, as the grid draws it (an all-day event keeps its days: they aren't edited here). */
export function withEdits(event: IEvent, edits: EventEdits): IEvent {
  return {
    ...event,
    title: edits.title.trim(),
    startDate: event.isAllDay ? event.startDate : edits.start.toISOString(),
    endDate: event.isAllDay ? event.endDate : edits.end.toISOString(),
    location: edits.location.trim() || undefined,
    description: edits.description.trim(),
  }
}

/**
 * Save the edits. Resolves with the saved event and the provider's word, if
 * it had one (a meeting link that couldn't follow the new length exactly).
 */
export async function saveEventEdits(event: IEvent, edits: EventEdits): Promise<{ event: IEvent; notice?: string }> {
  if (!edits.title.trim()) throw new EventWriteError('An event needs a title')
  if (!event.isAllDay && edits.end <= edits.start) throw new EventWriteError('The event has to end after it starts')
  const updated = withEdits(event, edits)
  // An all-day event's endDate is the LAST day it covers: written back it would cut a day off, and as a
  // dateTime it would turn the event into a timed one, so its times are left out.
  const timing = event.isAllDay ? {} : { start: updated.startDate, end: updated.endDate }
  let notice: string | undefined
  if (event.source === 'local_exchange') {
    const { tauriBridge } = await import('@/lib/tauri-bridge')
    const result = await tauriBridge.updateLocalExchangeEvent({
      eventId: event.id,
      title: updated.title,
      ...timing,
      location: updated.location,
      notes: updated.description || undefined,
    })
    if (!result?.success) throw new EventWriteError('Could not save the event')
  } else {
    const res = await fetch('/api/calendar/events', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: event.id,
        title: updated.title,
        ...timing,
        description: updated.description,
        location: updated.location ?? '',
      }),
    })
    if (!res.ok) throw new EventWriteError('Could not save the event')
    const saved = (await res.json().catch(() => null)) as { notice?: string } | null
    notice = saved?.notice
  }
  replaceInCache(updated)
  return { event: updated, notice }
}

/** Delete the event from its calendar. */
export async function deleteCalendarEvent(event: IEvent): Promise<void> {
  if (event.source === 'local_exchange') {
    const { tauriBridge } = await import('@/lib/tauri-bridge')
    const result = await tauriBridge.deleteLocalExchangeEvent(event.id)
    if (!result?.success) throw new EventWriteError('Could not delete the event')
  } else {
    const res = await fetch(`/api/calendar/events?eventId=${encodeURIComponent(event.id)}`, { method: 'DELETE' })
    if (!res.ok) throw new EventWriteError('Could not delete the event')
  }
  patchCalendarEventsCache((prev) => (prev.some((e) => e.id === event.id) ? prev.filter((e) => e.id !== event.id) : prev))
}

export type GoingAnswer = 'accepted' | 'tentative' | 'declined'

/** What the reply route says about the event (GET /api/calendar/rsvp), the parts the card reads. */
export interface GoingStatus {
  found: boolean
  canAnswer?: boolean
  blocked?: 'organizer' | 'not_invited' | 'cancelled'
  response?: GoingAnswer | 'pending' | null
  recurring?: boolean
  reason?: string
}

/** Where the event stands for the person on their calendar (by its iCalendar UID). Null when it can't be read. */
export async function readGoingStatus(event: IEvent, signal?: AbortSignal): Promise<GoingStatus | null> {
  if (!event.icalUid) return null
  try {
    const res = await fetch(`/api/calendar/rsvp?uid=${encodeURIComponent(event.icalUid)}`, { signal })
    if (!res.ok) return null
    return (await res.json()) as GoingStatus
  } catch {
    return null
  }
}

/**
 * Answer "Going?" as the person. A repeating event is answered for the whole
 * series: the route's single-occurrence reply is for the series' NEXT one,
 * which needn't be the occurrence that was clicked.
 */
export async function answerGoing(event: IEvent, answer: GoingAnswer): Promise<IEvent> {
  if (!event.icalUid) throw new EventWriteError('This event can’t be answered from here')
  let res: Response
  try {
    res = await fetch('/api/calendar/rsvp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: event.icalUid, response: answer }),
    })
  } catch {
    throw new EventWriteError('Your answer didn’t reach us. Check your connection and try again.')
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new EventWriteError(body?.error || 'Couldn’t answer the invitation')
  }
  const updated: IEvent = { ...event, response: answer }
  // Every occurrence of the series takes the answer on the grid, as it does on the calendar.
  patchCalendarEventsCache((prev) => {
    let changed = false
    const next = prev.map((e) => {
      if (e.icalUid !== event.icalUid || e.response === answer) return e
      changed = true
      return { ...e, response: answer }
    })
    return changed ? next : prev
  })
  return updated
}
