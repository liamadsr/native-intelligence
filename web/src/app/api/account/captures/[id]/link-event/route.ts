import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { seedCaptureParticipants, type EventAttendee } from '@/lib/crm/contacts'
import {
  deriveSeriesIdentity,
  parseGoogleSeriesFromInstanceId,
} from '@/lib/integrations/meeting-series'
import { NextResponse, type NextRequest } from 'next/server'

interface LinkEventBody {
  /** Set to null to unlink the event */
  calendar_event_id: string | null
  calendar_provider?: string
  title?: string
  start?: string
  end?: string
  attendees?: EventAttendee[] | string[]
  organizer?: string
  conference_url?: string
  location?: string
  // Recurring-series identity (see src/lib/integrations/meeting-series.ts)
  series_master_id?: string
  ical_uid?: string
  has_recurrence?: boolean
  source?: string
}

/**
 * POST /api/account/captures/[id]/link-event
 *
 * Links or re-links a calendar event to an existing capture.
 * - Updates calendar_event_id, calendar_provider, scheduled_start/end on the capture
 * - Removes existing auto-seeded participants (from previous event link, if any)
 * - Seeds fresh capture_participant rows from the new event's attendees
 * - Matches attendees against workspace members and CRM contacts
 *
 * Pass calendar_event_id: null to unlink (clears the event association).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params
  const body: LinkEventBody = await request.json()

  // Verify capture belongs to this user/workspace
  const { data: capture } = await supabase
    .from('captures')
    .select('id, calendar_event_id, metadata, ended_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!capture) {
    return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
  }

  const supabaseAdmin = getServiceClient()

  const existingMetadata =
    capture.metadata && typeof capture.metadata === 'object'
      ? (capture.metadata as Record<string, unknown>)
      : {}

  // Unlink case
  if (body.calendar_event_id === null) {
    const { linked_event_title: _dropped, ...restMetadata } = existingMetadata
    const { error: unlinkError } = await supabaseAdmin
      .from('captures')
      .update({
        calendar_event_id: null,
        calendar_provider: null,
        scheduled_start: null,
        scheduled_end: null,
        organizer_email: null,
        series_key: null,
        ical_uid: null,
        occurrence_start: null,
        metadata: restMetadata,
      })
      .eq('id', id)
    if (unlinkError) {
      return NextResponse.json({ error: unlinkError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  }

  // Guard: the unique index (mig 226) allows one LIVE capture per user per
  // event — so the conflict only exists when the TARGET capture is itself
  // live. Linking an ENDED capture into the meeting's history is always
  // allowed (that's the feature: ended captures sharing the id are the series
  // thread), and teammates may each link their own capture of the same call.
  if (capture.ended_at === null) {
    const { data: conflicting } = await supabaseAdmin
      .from('captures')
      .select('id')
      .eq('calendar_event_id', body.calendar_event_id)
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .neq('status', 'archived')
      .is('ended_at', null)
      .neq('id', id)
      .limit(1)
      .maybeSingle()

    if (conflicting) {
      return NextResponse.json(
        { error: 'Another capture already links this event', capture_id: conflicting.id },
        { status: 409 },
      )
    }
  }

  const identity = deriveSeriesIdentity({
    id: body.calendar_event_id,
    start: body.start,
    seriesMasterId: body.series_master_id,
    icalUid: body.ical_uid,
    hasRecurrence: body.has_recurrence,
    source: body.source,
  })
  const seriesKey =
    identity.seriesKey ??
    (body.source !== 'local_exchange'
      ? parseGoogleSeriesFromInstanceId(body.calendar_event_id)
      : null)

  // Update capture with new event data
  const updates: Record<string, unknown> = {
    calendar_event_id: body.calendar_event_id,
    calendar_provider: body.calendar_provider || null,
    series_key: seriesKey,
    ical_uid: identity.icalUid,
    occurrence_start: identity.occurrenceStart,
  }
  if (body.start) updates.scheduled_start = body.start
  if (body.end) updates.scheduled_end = body.end
  if (body.title) {
    updates.title = body.title
    // The panel's "Linked event" row reads this — the capture title drifts
    // once the user renames the capture, so remember the event's own name.
    updates.metadata = { ...existingMetadata, linked_event_title: body.title }
  }
  if (body.conference_url || body.location) updates.meeting_url = body.conference_url || body.location
  if (body.organizer) updates.organizer_email = body.organizer

  const { error: linkError } = await supabaseAdmin.from('captures').update(updates).eq('id', id)
  if (linkError) {
    // The pre-check guard doesn't close the race: a concurrent from-event can
    // claim the live slot between check and write. Surface it as the same 409
    // instead of reporting success for a link that never happened.
    if (linkError.code === '23505') {
      return NextResponse.json(
        { error: 'Another capture already links this event' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: linkError.message }, { status: 500 })
  }

  // Re-seed participants if attendees provided
  console.log('[link-event] body.attendees:', body.attendees)
  if (body.attendees && body.attendees.length > 0) {
    // Remove existing participants that came from calendar sync (have external_email set, no voice data)
    // We keep manually-added participants (those without external_email or with speaker_label)
    await supabaseAdmin
      .from('capture_participant')
      .delete()
      .eq('capture_id', id)
      .not('external_email', 'is', null)
      .is('speaker_label', null)

    await seedCaptureParticipants(id, workspaceId, body.attendees, body.organizer)
  }

  return NextResponse.json({ success: true })
}
