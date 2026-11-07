import { getServiceClient } from '@/lib/admin'
import { listCalendarEvents, getCalendarProvider, type CalendarEvent } from './calendar'
import { deriveSeriesIdentity } from './meeting-series'
import { getValidToken } from '@/lib/oauth/token-manager'
import { findOrCreateContact } from '@/lib/crm/contacts'
import { ensureContactsForCalendarEvents } from '@/lib/crm/calendar-contacts'
import { findMemberByEmail } from '@/lib/workspace-member-emails'
import { fetchAllRows, inChunks } from '@/lib/supabase/paging'

interface SyncResult {
  synced: number
  total: number
}

/**
 * Syncs upcoming calendar events to captures for a given user + workspace.
 * Creates pending captures for meetings worth capturing (2+ attendees, >10min, not all-day, not declined).
 * Idempotent — won't create duplicates for the same calendar_event_id.
 */
export async function syncCalendarToCaptures(
  userId: string,
  workspaceId: string,
): Promise<SyncResult> {
  const provider = await getCalendarProvider(userId)
  if (!provider) return { synced: 0, total: 0 }

  // Fetch events for the next 7 days
  const now = new Date()
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  let allEvents: (CalendarEvent & { provider: string })[]
  try {
    const events = await listCalendarEvents(userId, {
      timeMin: now.toISOString(),
      timeMax: nextWeek.toISOString(),
      maxResults: 100,
    })
    allEvents = events.map((e) => ({ ...e, provider }))
  } catch {
    return { synced: 0, total: 0 }
  }

  // Every external attendee of a real meeting becomes a CRM contact, whether or
  // not the meeting is worth capturing — seeing the invite is the trigger, not
  // recording the call. Throttled per-workspace and never throws.
  await ensureContactsForCalendarEvents(workspaceId, userId, allEvents)

  // Filter to events worth capturing
  const meetingEvents = allEvents.filter((event) => {
    const attendees = event.attendees || []
    const startMs = new Date(event.start).getTime()
    const endMs = new Date(event.end).getTime()
    const durationMinutes = (endMs - startMs) / 60000
    return attendees.length >= 2 && durationMinutes > 10 && !event.isAllDay
  })

  const supabaseAdmin = getServiceClient()
  let syncedCount = 0

  for (const event of meetingEvents) {
    const identity = deriveSeriesIdentity(event)
    const seriesFields = {
      series_key: identity.seriesKey,
      ical_uid: identity.icalUid,
      occurrence_start: identity.occurrenceStart,
    }

    // A live (un-ended) capture of the CALLER's for this event id — recurring
    // EventKit series share one id across occurrences, so ended captures are
    // history, not duplicates, and don't block a new pending row.
    const { data: existing } = await supabaseAdmin
      .from('captures')
      .select('id, auto_capture_status')
      .eq('calendar_event_id', event.id)
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .neq('status', 'archived')
      .is('ended_at', null)
      .limit(1)
      .maybeSingle()

    if (existing) {
      // Update if still pending (event may have changed)
      if (existing.auto_capture_status === 'pending') {
        await supabaseAdmin
          .from('captures')
          .update({
            title: event.title,
            scheduled_start: event.start,
            scheduled_end: event.end,
            meeting_url: event.conferenceUrl || event.location || null,
            organizer_email: event.organizer || null,
            ...seriesFields,
          })
          .eq('id', existing.id)
      }
      continue
    }

    // This occurrence may already be captured and ended — don't recreate it.
    if (identity.occurrenceStart) {
      const { data: captured } = await supabaseAdmin
        .from('captures')
        .select('id')
        .eq('calendar_event_id', event.id)
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
        .neq('status', 'archived')
        .eq('occurrence_start', identity.occurrenceStart)
        .limit(1)
        .maybeSingle()
      if (captured) continue
    }

    // Create pending capture
    const { data: newCapture } = await supabaseAdmin
      .from('captures')
      .insert({
        workspace_id: workspaceId,
        user_id: userId,
        title: event.title,
        calendar_event_id: event.id,
        calendar_provider: event.provider,
        scheduled_start: event.start,
        scheduled_end: event.end,
        meeting_url: event.conferenceUrl || event.location || null,
        organizer_email: event.organizer || null,
        auto_capture_status: 'pending',
        status: 'active',
        ...seriesFields,
      })
      .select('id')
      .single()

    if (!newCapture) continue

    // Create participants from attendees. attendeeDetails carries the provider's
    // display names; the bare `attendees` array (all a local-calendar event has)
    // is the fallback.
    const attendees: { email: string; name?: string }[] = event.attendeeDetails?.length
      ? event.attendeeDetails.map((a) => ({ email: a.email, name: a.name }))
      : (event.attendees || []).map((email) => ({ email }))
    for (const attendee of attendees) {
      const email = attendee.email
      const lowerEmail = email.trim().toLowerCase()
      // Local-calendar attendees arrive as bare strings and may be display
      // labels rather than addresses; never persist a non-email as external_email.
      if (!lowerEmail.includes('@')) continue

      // Try to find a workspace member by email. There is no member.email
      // column; the sign-in address is resolved through the admin API.
      const memberMatch = await findMemberByEmail(workspaceId, lowerEmail)

      // Find OR CREATE the CRM contact. Looking up only was how an external
      // attendee ended up as a participant row with contact_id NULL and no
      // contact anywhere — the bug this fixes. findOrCreateContact still runs
      // the noise filter, so room resources and no-reply addresses are refused.
      let contactMatch: {
        id: string
        first_name: string | null
        last_name: string | null
        job_title: string | null
        company_id: string | null
      } | null = null
      const ensured = await findOrCreateContact(workspaceId, {
        email: lowerEmail,
        fullName:
          attendee.name && attendee.name.toLowerCase() !== lowerEmail ? attendee.name : '',
        source: 'calendar_sync',
      })
      if (ensured) {
        const { data: contactRow } = await supabaseAdmin
          .from('contact')
          .select('id, first_name, last_name, job_title, company_id')
          .eq('id', ensured.id)
          .maybeSingle()
        contactMatch = contactRow
      }

      let companyName: string | null = null
      if (contactMatch?.company_id) {
        const { data: company } = await supabaseAdmin
          .from('company')
          .select('name')
          .eq('id', contactMatch.company_id)
          .single()
        companyName = company?.name || null
      }

      const contactName = contactMatch
        ? [contactMatch.first_name, contactMatch.last_name].filter(Boolean).join(' ')
        : null

      await supabaseAdmin.from('capture_participant').insert({
        capture_id: newCapture.id,
        member_id: memberMatch?.id || null,
        contact_id: contactMatch?.id || null,
        external_name: attendee.name || contactName || email,
        external_email: lowerEmail,
        company: companyName || null,
        job_title: contactMatch?.job_title || null,
        role: email === event.organizer ? 'organizer' : 'attendee',
      })
    }

    syncedCount++
  }

  return { synced: syncedCount, total: meetingEvents.length }
}

/**
 * Get upcoming captures (pending/ready) from calendar sync for the next 24 hours.
 */
export async function getUpcomingCaptures(
  userId: string,
  workspaceId: string,
  hoursAhead = 24,
) {
  const supabaseAdmin = getServiceClient()
  const now = new Date()
  const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000)

  const { data: captures } = await supabaseAdmin
    .from('captures')
    .select(`
      id, title, calendar_event_id, calendar_provider,
      scheduled_start, scheduled_end, meeting_url,
      organizer_email, auto_capture_status, ai_processed
    `)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .in('auto_capture_status', ['pending', 'ready'])
    .gte('scheduled_start', now.toISOString())
    .lte('scheduled_start', cutoff.toISOString())
    .order('scheduled_start', { ascending: true })

  if (!captures?.length) return []

  // Batch fetch participant counts
  const captureIds = captures.map((c) => c.id)
  const { data: participants } = await supabaseAdmin
    .from('capture_participant')
    .select('capture_id')
    .in('capture_id', captureIds)

  const participantCounts: Record<string, number> = {}
  for (const p of participants || []) {
    participantCounts[p.capture_id] = (participantCounts[p.capture_id] || 0) + 1
  }

  return captures.map((c) => {
    const startTime = new Date(c.scheduled_start!)
    const minutesUntil = Math.round((startTime.getTime() - now.getTime()) / 60000)

    return {
      id: c.id,
      title: c.title,
      calendar_event_id: c.calendar_event_id,
      calendar_provider: c.calendar_provider,
      scheduled_start: c.scheduled_start,
      scheduled_end: c.scheduled_end,
      meeting_url: c.meeting_url,
      auto_capture_status: c.auto_capture_status,
      participant_count: participantCounts[c.id] || 0,
      minutes_until_start: minutesUntil,
    }
  })
}

/**
 * Get captures linked to calendar events for a date range.
 * Used by the calendar view to overlay capture status on events.
 */
export async function getCapturesForCalendarEvents(
  userId: string,
  workspaceId: string,
  eventIds: string[],
) {
  if (!eventIds.length) return {}

  const supabaseAdmin = getServiceClient()

  // Chunked: a month view posts every visible event id (Outlook ids run ~150
  // chars), and one `in.(…)` overflowed the URL, so no event showed its capture.
  const { data: captures, error: capturesError } = await inChunks(eventIds, 50, (ids) =>
    supabaseAdmin
      .from('captures')
      .select(`
        id, title, calendar_event_id, auto_capture_status, ai_processed, status, ended_at, started_at
      `)
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .in('calendar_event_id', ids)
      .neq('status', 'archived'),
  )
  if (capturesError) console.error('[getCapturesForCalendarEvents] capture read failed:', capturesError.message)

  if (!captures.length) return {}

  // Batch fetch action counts for completed captures
  const completedIds = captures.filter((c) => c.auto_capture_status === 'completed' || c.ai_processed).map((c) => c.id)
  let actionCounts: Record<string, number> = {}

  if (completedIds.length) {
    const { data: actions, error: actionsError } = await inChunks(completedIds, 100, (ids) =>
      fetchAllRows(() => supabaseAdmin.from('actions').select('id, source_capture_id').in('source_capture_id', ids)),
    )
    if (actionsError) console.error('[getCapturesForCalendarEvents] action count read failed:', actionsError.message)

    for (const a of actions) {
      if (a.source_capture_id) {
        actionCounts[a.source_capture_id] = (actionCounts[a.source_capture_id] || 0) + 1
      }
    }
  }

  // Return map keyed by calendar_event_id. Multiple non-archived captures now
  // legitimately share one event id (per-occurrence history; EventKit series
  // share one id) — pick deterministically: a LIVE capture beats an ended one,
  // then the newest started_at wins. Last-wins over an unordered result set
  // previously made the Recording pill / "View Capture" target arbitrary.
  type OverlayRow = (typeof captures)[number]
  const preferred = new Map<string, OverlayRow>()
  const beats = (a: OverlayRow, b: OverlayRow) => {
    const aLive = a.ended_at == null
    const bLive = b.ended_at == null
    if (aLive !== bLive) return aLive
    return (a.started_at || '') > (b.started_at || '')
  }
  for (const c of captures) {
    if (!c.calendar_event_id) continue
    const current = preferred.get(c.calendar_event_id)
    if (!current || beats(c, current)) preferred.set(c.calendar_event_id, c)
  }

  const result: Record<string, {
    capture_id: string
    auto_capture_status: string | null
    ai_processed: boolean
    source_action_count: number
  }> = {}

  for (const [eventId, c] of preferred) {
    result[eventId] = {
      capture_id: c.id,
      auto_capture_status: c.auto_capture_status,
      ai_processed: c.ai_processed,
      source_action_count: actionCounts[c.id] || 0,
    }
  }

  return result
}

