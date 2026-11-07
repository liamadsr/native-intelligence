import { NextResponse, after } from 'next/server'
import { authenticateUser } from '@/lib/ai/auth'
import { listCalendarEventsUnified, listCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, getCalendarProvider } from '@/lib/integrations/calendar'
import { ensureContactsForCalendarEvents } from '@/lib/crm/calendar-contacts'

export async function GET(req: Request) {
  try {
    const { user } = await authenticateUser(req)
    const url = new URL(req.url)

    const accountIds = url.searchParams.get('accountIds')
      ? url.searchParams.get('accountIds')!.split(',').filter(Boolean)
      : undefined
    const calendarIdsParam = url.searchParams.get('calendarIds')
    const calendarIds = calendarIdsParam ? JSON.parse(calendarIdsParam) : undefined

    const workspaceId = url.searchParams.get('workspaceId') || undefined

    const options = {
      timeMin: url.searchParams.get('timeMin') || undefined,
      timeMax: url.searchParams.get('timeMax') || undefined,
      maxResults: parseInt(url.searchParams.get('maxResults') || '100'),
      accountIds,
      calendarIds,
      workspaceId,
    }

    console.log('[Calendar Events] workspaceId:', workspaceId, 'accountIds:', accountIds, 'userId:', user.id)

    // Unified multi-account fetch + provider lookup in parallel — the provider
    // check is informational and must not serialize after the events fetch.
    const [events, provider] = await Promise.all([
      listCalendarEventsUnified(user.id, options),
      getCalendarProvider(user.id),
    ])

    console.log('[Calendar Events] returning', events.length, 'events')

    // Seed CRM contacts for external attendees AFTER the response is sent —
    // seeing a meeting is what should make its attendees exist in the CRM, but
    // that must never add latency to the calendar. The helper is throttled
    // per-workspace and swallows its own errors.
    if (workspaceId) {
      const seedWorkspaceId = workspaceId
      const seedUserId = user.id
      after(async () => {
        await ensureContactsForCalendarEvents(seedWorkspaceId, seedUserId, events)
      })
    }

    return NextResponse.json({ events, provider })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('Calendar events API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch calendar events' },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  try {
    const { user } = await authenticateUser(req)
    const body = await req.json()

    const { title, start, end, description, location, attendees, isAllDay, accountId } = body

    if (!title || !start || !end) {
      return NextResponse.json(
        { error: 'title, start, and end are required' },
        { status: 400 },
      )
    }

    const event = await createCalendarEvent(user.id, {
      title,
      start,
      end,
      description,
      location,
      attendees,
      isAllDay,
    }, accountId)

    return NextResponse.json({ event })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('Calendar create event error:', error)
    return NextResponse.json(
      { error: 'Failed to create calendar event' },
      { status: 500 },
    )
  }
}

export async function PATCH(req: Request) {
  try {
    const { user } = await authenticateUser(req)
    const body = await req.json()

    const { eventId, start, end, title, description, location } = body

    if (!eventId) {
      return NextResponse.json(
        { error: 'eventId is required' },
        { status: 400 },
      )
    }

    const updates: Record<string, string> = {}
    if (start) updates.start = start
    if (end) updates.end = end
    if (title !== undefined) updates.title = title
    if (description !== undefined) updates.description = description
    if (location !== undefined) updates.location = location

    const event = await updateCalendarEvent(user.id, eventId, updates)

    return NextResponse.json({ event })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('Calendar update event error:', error)
    return NextResponse.json(
      { error: 'Failed to update calendar event' },
      { status: 500 },
    )
  }
}

export async function DELETE(req: Request) {
  try {
    const { user } = await authenticateUser(req)
    const url = new URL(req.url)
    const eventId = url.searchParams.get('eventId')

    if (!eventId) {
      return NextResponse.json(
        { error: 'eventId is required' },
        { status: 400 },
      )
    }

    await deleteCalendarEvent(user.id, eventId)

    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('Calendar delete event error:', error)
    return NextResponse.json(
      { error: 'Failed to delete calendar event' },
      { status: 500 },
    )
  }
}
