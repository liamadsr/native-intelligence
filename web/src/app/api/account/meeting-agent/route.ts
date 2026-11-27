import { type NextRequest, NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, featureDisabled, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { findMeeting } from '@/lib/meeting-agent/lookup'
import { cancelAttendance, checkSend, sendAgentToMeeting, type SendRefusal } from '@/lib/meeting-agent/send'
import { meetingAgentCard } from '@/lib/meeting-agent/card'
import { meetingAgentOn } from '@/lib/meeting-agent/settings'
import { listAttendances, publicAttendance } from '@/lib/meeting-agent/store'
import { listSeries, pauseSeries, publicSeries, removeSeries, saveSeries, seriesIdOf, seriesRefsOf } from '@/lib/meeting-agent/series'
import { normalizeEventId, normalizeStartsAt } from '@/lib/meetings/meeting-goal'
import { isUuid } from '@/lib/presence/presence'

export const dynamic = 'force-dynamic'

/**
 * /api/account/meeting-agent: the caller's own assistant in meetings
 * (roadmap #12, migration 723). Liam, 11-27: "let's do it". Off (403 with
 * FEATURE_DISABLED) unless MEETING_AGENT is on.
 *
 *   GET     ?probe=1 → { on: true } (Settings' nav: whether to show the page).
 *   GET     → { attendances, series }: theirs from a day ago on, soonest
 *           first, each with its status (scheduled, dialling, in_meeting,
 *           ended, …) and the questions it put to them; and the recurring
 *           meetings they sent it to (727). Never a dial-in PIN.
 *   POST    { calendar_event_id, starts_at, brief, dial_in?: { number, digits },
 *           every_occurrence?: true } → { attendance, series? }: send it. The
 *           person's own Send in the app is the opt-in (the chat's route is
 *           its card). The meeting is read from their calendar (it never
 *           attends one they're not on), its dial-in from the invite unless
 *           they gave one. With every_occurrence, the same brief also covers
 *           every later occurrence of its series (400 NOT_RECURRING for a
 *           one-off).
 *   POST    { …the same, preview: true } → { card: { title, why } }: every
 *           check a send makes, and the approval card's words for it, with
 *           nothing written (the prep card's brief editor, its Review step).
 *   PATCH   { series_id, paused } → { ok }: pause or turn back on a series.
 *   DELETE  ?id → { outcome: cancelled | pulled_out | over }: call it off
 *           ("skip this one" for an occurrence of a series), or pull it out of
 *           the meeting. ?series_id → { removed }: stop a series (its
 *           occurrences not yet started are cancelled).
 *
 * Private to the caller: every query fences on them and the current
 * workspace (the service role writes, so the fence is what holds).
 */

function refusal(r: SendRefusal) {
  if (r.reason === 'error') return serverError(r.message)
  return apiError(r.message, { status: r.reason === 'busy' ? 409 : 400, code: r.reason.toUpperCase() })
}

function off() {
  return featureDisabled('Sending your assistant to meetings is not turned on.')
}

export async function GET(request?: NextRequest) {
  if (!meetingAgentOn()) return off()
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  // Settings' nav asks only whether the page exists here.
  if (request?.nextUrl.searchParams.get('probe') === '1') return NextResponse.json({ on: true })
  try {
    const scope = { workspaceId: auth.workspaceId, userId: auth.user.id }
    const [rows, series] = await Promise.all([listAttendances(getServiceClient(), { ...scope, since: new Date(Date.now() - 24 * 60 * 60_000).toISOString() }), listSeries(getServiceClient(), scope)])
    const refs = await seriesRefsOf(getServiceClient(), { userId: auth.user.id, ids: rows.map((r) => r.id) })
    return NextResponse.json({ attendances: rows.map((r) => ({ ...publicAttendance(r), seriesRef: refs.get(r.id) ?? null })), series: series.map(publicSeries) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'read failed')
  }
}

export async function POST(request: NextRequest) {
  if (!meetingAgentOn()) return off()
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return badRequest('A JSON body is required')
  const calendarEventId = normalizeEventId(body.calendar_event_id)
  const startsAt = normalizeStartsAt(body.starts_at)
  if (!calendarEventId || !startsAt) return badRequest('calendar_event_id and starts_at are required')
  const given = body.dial_in && typeof body.dial_in === 'object' ? (body.dial_in as Record<string, unknown>) : null
  try {
    const found = await findMeeting(auth.user.id, { calendarEventId, startsAt })
    if (!found) return notFound("That meeting isn't on your calendar")
    const everyOccurrence = body.every_occurrence === true
    const seriesId = seriesIdOf(found.event)
    if (everyOccurrence && !seriesId) return apiError("That meeting doesn't repeat, so there are no other occurrences to send your assistant to.", { status: 400, code: 'NOT_RECURRING' })
    const dialIn = given && typeof given.number === 'string' && typeof given.digits === 'string' ? { number: given.number, digits: given.digits } : found.dialIn
    const input = {
      workspaceId: auth.workspaceId,
      userId: auth.user.id,
      calendarEventId,
      startsAt,
      endsAt: found.event.end || null,
      title: found.event.title,
      dialIn,
      brief: body.brief,
    }
    if (body.preview === true) {
      const check = await checkSend(getServiceClient(), input)
      if (!check.ok) return refusal(check)
      return NextResponse.json({ card: meetingAgentCard({ title: found.event.title, number: check.checked.number, brief: check.checked.brief, everyOccurrence }) })
    }
    const sent = await sendAgentToMeeting(getServiceClient(), input)
    if (!sent.ok) return refusal(sent)
    if (everyOccurrence && seriesId) {
      const a = sent.attendance
      // The brief and dial-in as the send checked them; the person's own dial-in only, never one read from this invite.
      const series = await saveSeries(getServiceClient(), {
        workspaceId: auth.workspaceId,
        userId: auth.user.id,
        seriesId,
        title: found.event.title,
        brief: a.brief,
        dialIn: given && a.dialInNumber && a.dialInPin ? { number: a.dialInNumber, digits: a.dialInPin } : null,
      })
      return NextResponse.json({ attendance: publicAttendance(sent.attendance), series: publicSeries(series) })
    }
    return NextResponse.json({ attendance: publicAttendance(sent.attendance) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'not sent')
  }
}

export async function PATCH(request: NextRequest) {
  if (!meetingAgentOn()) return off()
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const id = typeof body?.series_id === 'string' ? body.series_id : ''
  if (!isUuid(id) || typeof body?.paused !== 'boolean') return badRequest('series_id and paused are required')
  try {
    const ok = await pauseSeries(getServiceClient(), { workspaceId: auth.workspaceId, userId: auth.user.id, id }, body.paused)
    return ok ? NextResponse.json({ ok }) : notFound('Not found')
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'not changed')
  }
}

export async function DELETE(request: NextRequest) {
  if (!meetingAgentOn()) return off()
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const seriesId = request.nextUrl.searchParams.get('series_id')
  if (seriesId !== null) {
    if (!isUuid(seriesId)) return badRequest('series_id must be an id')
    try {
      const removed = await removeSeries(getServiceClient(), { workspaceId: auth.workspaceId, userId: auth.user.id, id: seriesId })
      return removed ? NextResponse.json({ removed }) : notFound('Not found')
    } catch (err) {
      return serverError(err instanceof Error ? err.message : 'not removed')
    }
  }
  const id = request.nextUrl.searchParams.get('id') ?? ''
  if (!isUuid(id)) return badRequest('id is required')
  try {
    const outcome = await cancelAttendance(getServiceClient(), { workspaceId: auth.workspaceId, userId: auth.user.id, id })
    if (outcome === 'not_found') return notFound('Not found')
    return NextResponse.json({ outcome })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'not cancelled')
  }
}
