import { NextResponse, after } from 'next/server'
import { authenticateUser } from '@/lib/ai/auth'
import { listCalendarEventsUnified, listCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, getCalendarProvider } from '@/lib/integrations/calendar'
import { ensureContactsForCalendarEvents } from '@/lib/crm/calendar-contacts'
import { requireWorkspace } from '@/lib/api-auth'
import { meetingLinkForNewEvent } from '@/lib/meeting-links/calendar'
import { changeMeeting, meetingIdOfEvent, meetingOfProviderEvent } from '@/lib/meeting-links/calendar-events'
import { revokeMeetingAs } from '@/lib/meeting-links/store'
import { getServiceClient } from '@/lib/admin'
import { writableCalendarAccounts } from '@/lib/time-offers/host-calendar'
import { drainTeamCallEjections, liveEjectDeps } from '@/lib/team-calls/eject'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { TeamChatError } from '@/lib/team-chat/store'

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
      // The app's calendar view: the person's scheduled meeting links show too (phase 7).
      includeMeetingLinks: true,
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

    const { title, start, end, attendees, isAllDay, accountId } = body
    let { description, location } = body

    if (!title || !start || !end) {
      return NextResponse.json(
        { error: 'title, start, and end are required' },
        { status: 400 },
      )
    }

    // "Add a meeting link" (phase 7): a meeting of ours, named and timed as the event, its link the event's location.
    let meetingUrl: string | null = null
    let meetingId: string | null = null
    let onAccount: string | undefined = accountId || undefined
    if (body.meetingLink === true) {
      const ws = await requireWorkspace()
      if (ws instanceof Response) return ws
      if (ws.user.id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      const made = await meetingLinkForNewEvent(ws.supabase, { workspaceId: ws.workspaceId, title: String(title), start, end, isAllDay, location, description })
      if (!made.ok) return NextResponse.json({ error: made.error }, { status: 400 })
      meetingUrl = made.link.url
      meetingId = made.link.meetingId
      // The calendar it goes on, known (not the provider's guess), so the meeting can keep the event in step later.
      if (!onAccount) onAccount = (await writableCalendarAccounts(getServiceClient(), user.id, ws.workspaceId).catch(() => []))[0]?.id
      location = made.location
      description = made.description
    }

    const event = await createCalendarEvent(user.id, {
      title,
      start,
      end,
      description,
      location,
      attendees,
      isAllDay,
    }, onAccount)

    // The meeting remembers the event (586): the PERSON's, so it only ever swaps or takes out its own link in it.
    if (meetingId) {
      const { error } = await getServiceClient().from('meeting').update({ calendar_event_id: event.id, calendar_account_id: event.accountId ?? onAccount ?? null, calendar_event_kind: 'person' }).eq('id', meetingId)
      if (error) console.warn(`[meetings] meeting=${meetingId} its calendar event not kept:`, error.message.slice(0, 120))
    }

    return NextResponse.json(meetingUrl ? { event, meetingUrl } : { event })
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

    // A meeting link the app's calendar shows from the meeting itself: moving or renaming it moves or renames the meeting.
    const shownMeeting = meetingIdOfEvent(eventId)
    if (shownMeeting) {
      const changed = await changeMeeting(getServiceClient(), { meetingId: shownMeeting, userId: user.id, title: typeof title === 'string' ? title : undefined, startsAt: start || undefined, endsAt: end || undefined })
      if (!changed.ok) return NextResponse.json({ error: changed.error }, { status: changed.status })
      return NextResponse.json({ event: { id: eventId, title: changed.title, start: changed.startsAt, end: changed.endsAt } })
    }

    const updates: Record<string, string> = {}
    if (start) updates.start = start
    if (end) updates.end = end
    if (title !== undefined) updates.title = title
    if (description !== undefined) updates.description = description
    if (location !== undefined) updates.location = location

    const event = await updateCalendarEvent(user.id, eventId, updates)

    // A meeting's event, moved or renamed on the calendar: the meeting follows (its event already did). Never fails the edit.
    // A length a meeting can't have: the event keeps it, the link's window takes the nearest it can, and the person is told.
    let notice: string | undefined
    if (start || end || typeof title === 'string') {
      const svc = getServiceClient()
      const tied = await meetingOfProviderEvent(svc, user.id, eventId).catch(() => null)
      if (tied) {
        const followed = await changeMeeting(svc, { meetingId: tied, userId: user.id, title: typeof title === 'string' ? title : undefined, startsAt: start || undefined, endsAt: end || undefined, clamp: true }, { updateEvent: async () => event }).catch((err) => {
          console.warn(`[meetings] meeting=${tied} didn't follow its event:`, err instanceof Error ? err.message.slice(0, 120) : 'unknown')
          return null
        })
        if (followed?.ok && followed.clamped === 'longest') notice = 'Saved. Its meeting link stays open for the first 8 hours only (a meeting’s longest).'
        if (followed?.ok && followed.clamped === 'shortest') notice = 'Saved. Its meeting link keeps a 5-minute window (a meeting’s shortest).'
        if (followed && !followed.ok) notice = `Saved. Its meeting link didn’t move: ${followed.error}`
      }
    }

    return NextResponse.json(notice ? { event, notice } : { event })
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

    const svc = getServiceClient()
    // Revoked as its host (586's meeting_revoke_as: the person from their sign-in, a device's token included);
    // anyone still in its call is taken out now (the minute's drain is the floor).
    const revoke = async (meetingId: string) => {
      const out = await revokeMeetingAs(svc, meetingId, user.id)
      const config = out.revoked && out.callId ? teamCallsConfig() : null
      if (config) await drainTeamCallEjections(svc, liveEjectDeps(config)).catch(() => undefined)
      return out
    }

    // Deleting a meeting link the calendar shows from the meeting itself revokes it.
    const shownMeeting = meetingIdOfEvent(eventId)
    if (shownMeeting) {
      try {
        await revoke(shownMeeting)
      } catch (err) {
        if (err instanceof TeamChatError && err.code === 'forbidden') return NextResponse.json({ error: 'Only the host can remove this meeting' }, { status: 403 })
        throw err
      }
      return NextResponse.json({ success: true })
    }

    await deleteCalendarEvent(user.id, eventId)

    // A meeting's event deleted: the meeting's link is revoked too (it has no event any more). Never fails the delete.
    const tied = await meetingOfProviderEvent(svc, user.id, eventId).catch(() => null)
    if (tied) {
      await svc.from('meeting').update({ calendar_event_id: null, calendar_event_kind: null }).eq('id', tied)
      await revoke(tied).catch((err) => console.warn(`[meetings] meeting=${tied} not revoked with its event:`, err instanceof Error ? err.message.slice(0, 120) : 'unknown'))
    }

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
