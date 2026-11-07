import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { seedCaptureParticipants, seedSelfParticipant, type EventAttendee } from '@/lib/crm/contacts'
import {
  deriveSeriesIdentity,
  parseGoogleSeriesFromInstanceId,
} from '@/lib/integrations/meeting-series'
import { NextResponse, type NextRequest } from 'next/server'

interface CalendarEventBody {
  calendar_event_id: string
  calendar_provider?: string
  title: string
  start: string
  end: string
  attendees?: EventAttendee[] | string[]
  organizer?: string
  conference_url?: string
  location?: string
  description?: string
  // Recurring-series identity (see src/lib/integrations/meeting-series.ts)
  series_master_id?: string
  ical_uid?: string
  has_recurrence?: boolean
  source?: string
  /** Retroactive capture for a past meeting (event panel "Add capture") — the
   *  row is created already closed so it never occupies the live slot. */
  retro?: boolean
}

/** Timestamps round-trip through PostgREST in a different ISO shape — compare instants. */
function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return new Date(a).getTime() === new Date(b).getTime()
}

/** A live row that saved a transcript this recently is treated as actively
 *  recording, not as a crash orphan — closing it out would lock the transcript
 *  under a still-running recorder (e.g. desktop recording while a second
 *  window starts a different occurrence of the same EventKit event id). */
const ACTIVE_RECORDING_WINDOW_MS = 10 * 60 * 1000

/** A capture of this same occurrence that ended this recently is the same
 *  meeting, interrupted: the app restarted mid-call and its resume was declined
 *  or lost. Starting the meeting again resumes it instead of splitting the call
 *  in two (the 2026-10-19 Owen call: a 20:52 restart closed the capture and the
 *  20:55 Start made a second one, with the summary starting over). Measured
 *  from when the capture was closed: a declined recovery stamps `ended_at` at
 *  the recorder's last write, up to the recovery marker's 10 minutes earlier,
 *  so its `metadata.finalized.at` is used when present. */
export const RESUME_RECENT_WINDOW_MS = 15 * 60 * 1000
/** How far back `ended_at` is searched, to cover that backdating. */
const RESUME_RECENT_LOOKBACK_MS = RESUME_RECENT_WINDOW_MS + 10 * 60 * 1000

/**
 * POST /api/account/captures/from-event
 *
 * Manually start a capture for a calendar event. Find-or-create, scoped to the
 * CALLER's captures — teammates capturing the same event each get their own row.
 *
 * Reuse rules (one live capture per user per event, enforced by a partial
 * unique index from migration 226):
 * - A live row (ended_at NULL) that has no transcript, or belongs to this same
 *   occurrence, is reused — pending rows pre-created by calendar sync land here.
 * - An ENDED capture is never reused: recurring meetings whose occurrences
 *   share one provider event id (EventKit) get a NEW capture per occurrence,
 *   threaded via series_key/ical_uid/occurrence_start instead of being
 *   recorded over (the old behavior silently lost the new transcript against
 *   the lock trigger).
 * - The same sitting is RESUMED instead: when this occurrence's capture, with
 *   a transcript, was closed within RESUME_RECENT_WINDOW_MS, the answer is
 *   `{ capture_id, created: false, resume: true }` and nothing is written. The
 *   caller resumes it through POST /captures/[id]/resume (resumeCapture), which
 *   unlocks it only once the client can record, and absorbs a transcript-less
 *   placeholder.
 *
 * Body: CalendarEventBody
 */
export async function POST(request: NextRequest) {
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

  const body: CalendarEventBody = await request.json()
  const {
    calendar_event_id,
    calendar_provider,
    title,
    start,
    end,
    attendees,
    organizer,
    conference_url,
    location,
    series_master_id,
    ical_uid,
    has_recurrence,
    source,
    retro,
  } = body

  if (!calendar_event_id || !title || !start || !end) {
    return NextResponse.json({ error: 'calendar_event_id, title, start, and end are required' }, { status: 400 })
  }
  if (Number.isNaN(new Date(start).getTime()) || Number.isNaN(new Date(end).getTime())) {
    return NextResponse.json({ error: 'start and end must be valid dates' }, { status: 400 })
  }

  const supabaseAdmin = getServiceClient()

  const identity = deriveSeriesIdentity({
    id: calendar_event_id,
    start,
    seriesMasterId: series_master_id,
    icalUid: ical_uid,
    hasRecurrence: has_recurrence,
    source,
  })
  let seriesKey = identity.seriesKey
  let provider = calendar_provider || (source === 'local_exchange' ? 'local_exchange' : null)

  // Fallbacks for callers that predate the series fields (older desktop tray
  // caches send only the bare event). Google instance ids carry the master as
  // a prefix; EventKit series membership is recoverable from the local-event
  // cache the desktop app pushes.
  if (!seriesKey && source !== 'local_exchange') {
    seriesKey = parseGoogleSeriesFromInstanceId(calendar_event_id)
  }
  if (!seriesKey && has_recurrence === undefined) {
    const { data: localEvent } = await supabaseAdmin
      .from('local_calendar_event')
      .select('has_recurrence')
      .eq('user_id', user.id)
      .eq('external_id', calendar_event_id)
      .limit(1)
      .maybeSingle()
    if (localEvent) {
      provider = provider || 'local_exchange'
      if (localEvent.has_recurrence) seriesKey = calendar_event_id
    }
  }

  const LIVE_ROW_FIELDS =
    'id, transcript, occurrence_start, started_at, recorded_at, updated_at, metadata, series_key, ical_uid, calendar_provider, organizer_email, meeting_url'

  interface LiveRow {
    id: string
    transcript: string | null
    occurrence_start: string | null
    started_at: string | null
    recorded_at: string | null
    updated_at: string | null
    metadata: Record<string, unknown> | null
    series_key: string | null
    ical_uid: string | null
    calendar_provider: string | null
    organizer_email: string | null
    meeting_url: string | null
  }

  const isReusable = (row: LiveRow) =>
    !row.transcript?.trim() || sameInstant(row.occurrence_start, identity.occurrenceStart)

  // Reuse: refresh event metadata without ever null-overwriting identity the
  // calendar sync already stamped (tray callers can't send series fields yet),
  // and set started_at so date grouping + duration math work.
  const reuseRow = async (row: LiveRow) => {
    const nowIso = new Date().toISOString()
    const rowMetadata =
      row.metadata && typeof row.metadata === 'object'
        ? (row.metadata as Record<string, unknown>)
        : {}
    const { error: updateError } = await supabaseAdmin
      .from('captures')
      .update({
        title,
        calendar_event_id,
        calendar_provider: provider ?? row.calendar_provider,
        scheduled_start: start,
        scheduled_end: end,
        meeting_url: conference_url || location || row.meeting_url,
        organizer_email: organizer || row.organizer_email,
        series_key: seriesKey ?? row.series_key,
        ical_uid: identity.icalUid ?? row.ical_uid,
        occurrence_start: identity.occurrenceStart ?? row.occurrence_start,
        started_at: row.started_at || nowIso,
        recorded_at: row.recorded_at || nowIso,
        auto_capture_status: 'ready',
        metadata: { ...rowMetadata, linked_event_title: title },
      })
      .eq('id', row.id)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }
    return NextResponse.json({ capture_id: row.id, created: false })
  }

  // At most one live (un-ended) capture per user per event exists — ended
  // captures are this meeting's history, never reused (the same sitting is
  // resumed instead, below).
  const { data: live } = await supabaseAdmin
    .from('captures')
    .select(LIVE_ROW_FIELDS)
    .eq('calendar_event_id', calendar_event_id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')
    .is('ended_at', null)
    .limit(1)
    .maybeSingle<LiveRow>()

  const liveHasText = !!live?.transcript?.trim()
  if (live && liveHasText && isReusable(live)) {
    return reuseRow(live)
  }

  // The same sitting, interrupted: this occurrence's capture was closed
  // moments ago (a restart whose resume was declined or lost). Hand it back to
  // be resumed rather than start the meeting over in a new capture. Never for
  // a retro capture, and never past a live row with text (decided below).
  if (retro !== true && !liveHasText) {
    const now = Date.now()
    const { data: recent } = await supabaseAdmin
      .from('captures')
      .select('id, transcript, occurrence_start, ended_at, metadata')
      .eq('calendar_event_id', calendar_event_id)
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .neq('status', 'archived')
      .gte('ended_at', new Date(now - RESUME_RECENT_LOOKBACK_MS).toISOString())
      .order('ended_at', { ascending: false })
      .limit(1)
      .maybeSingle<Pick<LiveRow, 'id' | 'transcript' | 'occurrence_start' | 'metadata'> & { ended_at: string }>()
    if (recent?.transcript?.trim() && sameInstant(recent.occurrence_start, identity.occurrenceStart)) {
      const finalizedAt = (recent.metadata?.finalized as { at?: unknown } | undefined)?.at
      const closedAt = Date.parse(typeof finalizedAt === 'string' ? finalizedAt : recent.ended_at)
      if (now - closedAt <= RESUME_RECENT_WINDOW_MS) {
        return NextResponse.json({ capture_id: recent.id, created: false, resume: true })
      }
    }
  }

  // Retro captures for past meetings are created already CLOSED: they must
  // never occupy the live slot (a transcript-less live retro row would be
  // silently re-stamped to the next occurrence by the reuse rule, and would
  // suppress calendar sync's pending row for the shared EventKit event id).
  // A closed insert never contends with the live row either, so a retro
  // request leaves the live row (often that pending row) untouched instead of
  // re-stamping it with this past occurrence or closing it.
  const isRetro = retro === true && new Date(end).getTime() < Date.now()

  if (live && !isRetro && isReusable(live)) {
    return reuseRow(live)
  }

  if (live && !isRetro) {
    // A live row bound to a DIFFERENT occurrence with content. If it saved a
    // transcript recently it is actively recording (another window/device) —
    // refuse rather than end it out from under the running recorder (setting
    // ended_at fires the transcript-lock trigger and every subsequent save
    // from that session would be rejected).
    const lastActivity = new Date(live.updated_at || live.started_at || 0).getTime()
    if (Date.now() - lastActivity < ACTIVE_RECORDING_WINDOW_MS) {
      return NextResponse.json(
        {
          error: 'Another session of this meeting is currently recording',
          capture_id: live.id,
        },
        { status: 409 },
      )
    }
    // Genuine crash orphan: retire it (the lock trigger preserves its
    // transcript). ended_at = last activity keeps its duration truthful.
    const { error: closeError } = await supabaseAdmin
      .from('captures')
      .update({ ended_at: live.updated_at || live.started_at || new Date().toISOString() })
      .eq('id', live.id)
    if (closeError) {
      return NextResponse.json({ error: closeError.message }, { status: 500 })
    }
  }

  const nowIso = new Date().toISOString()

  const { data: newCapture, error: insertError } = await supabaseAdmin
    .from('captures')
    .insert({
      user_id: user.id,
      workspace_id: workspaceId,
      title,
      calendar_event_id,
      calendar_provider: provider,
      scheduled_start: start,
      scheduled_end: end,
      meeting_url: conference_url || location || null,
      organizer_email: organizer || null,
      series_key: seriesKey,
      ical_uid: identity.icalUid,
      occurrence_start: identity.occurrenceStart,
      auto_capture_status: isRetro ? 'completed' : 'ready',
      status: 'active',
      recorded_at: isRetro ? start : nowIso,
      started_at: isRetro ? start : nowIso,
      ...(isRetro ? { ended_at: end } : {}),
      metadata: { linked_event_title: title },
    })
    .select('id')
    .single()

  if (insertError || !newCapture) {
    // Unique-index race: another window created the live capture between our
    // check and insert. Hand back the winner ONLY if it passes the same reuse
    // rules (restamped like any reuse) — never a row bound to another
    // occurrence's content.
    if (insertError?.code === '23505') {
      const { data: winner } = await supabaseAdmin
        .from('captures')
        .select(LIVE_ROW_FIELDS)
        .eq('calendar_event_id', calendar_event_id)
        .eq('user_id', user.id)
        .eq('workspace_id', workspaceId)
        .neq('status', 'archived')
        .is('ended_at', null)
        .limit(1)
        .maybeSingle<LiveRow>()
      if (winner && isReusable(winner)) {
        return reuseRow(winner)
      }
      return NextResponse.json(
        { error: 'Another session of this meeting is currently recording' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: insertError?.message || 'Failed to create capture' }, { status: 500 })
  }

  // Seed participants from event attendees
  if (attendees && attendees.length > 0) {
    await seedCaptureParticipants(newCapture.id, workspaceId, attendees, organizer)
  }

  // Identity anchor for the capture owner (after attendee seeding so an
  // attendee row matching this member gets promoted instead of duplicated).
  try {
    await seedSelfParticipant(workspaceId, newCapture.id, user)
  } catch (err) {
    console.warn('[captures from-event] seedSelfParticipant failed:', err)
  }

  return NextResponse.json({ capture_id: newCapture.id, created: true })
}
