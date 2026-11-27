import { type NextRequest, NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, featureDisabled, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { findMeeting } from '@/lib/meeting-agent/lookup'
import { cancelAttendance, sendAgentToMeeting } from '@/lib/meeting-agent/send'
import { meetingAgentOn } from '@/lib/meeting-agent/settings'
import { listAttendances, publicAttendance } from '@/lib/meeting-agent/store'
import { normalizeEventId, normalizeStartsAt } from '@/lib/meetings/meeting-goal'
import { isUuid } from '@/lib/presence/presence'

export const dynamic = 'force-dynamic'

/**
 * /api/account/meeting-agent: the caller's own assistant in meetings
 * (roadmap #12, migration 723). Liam, 11-27: "let's do it". Off (403 with
 * FEATURE_DISABLED) unless MEETING_AGENT is on.
 *
 *   GET     → { attendances }: theirs from a day ago on, soonest first, each
 *           with its status (scheduled, dialling, in_meeting, ended, …) and
 *           the questions it put to them. Never the dial-in PIN.
 *   POST    { calendar_event_id, starts_at, brief, dial_in?: { number, digits } }
 *           → { attendance }: send it. The person's own Send in the app is
 *           the opt-in (the chat's route is its card). The meeting is read
 *           from their calendar (it never attends one they're not on), its
 *           dial-in from the invite unless they gave one.
 *   DELETE  ?id → { outcome: cancelled | pulled_out | over }: call it off, or
 *           pull it out of the meeting.
 *
 * Private to the caller: every query fences on them and the current
 * workspace (the service role writes, so the fence is what holds).
 */

function off() {
  return featureDisabled('Sending your assistant to meetings is not turned on.')
}

export async function GET() {
  if (!meetingAgentOn()) return off()
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  try {
    const rows = await listAttendances(getServiceClient(), { workspaceId: auth.workspaceId, userId: auth.user.id, since: new Date(Date.now() - 24 * 60 * 60_000).toISOString() })
    return NextResponse.json({ attendances: rows.map(publicAttendance) })
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
    const dialIn = given && typeof given.number === 'string' && typeof given.digits === 'string' ? { number: given.number, digits: given.digits } : found.dialIn
    const sent = await sendAgentToMeeting(getServiceClient(), {
      workspaceId: auth.workspaceId,
      userId: auth.user.id,
      calendarEventId,
      startsAt,
      endsAt: found.event.end || null,
      title: found.event.title,
      dialIn,
      brief: body.brief,
    })
    if (!sent.ok) {
      if (sent.reason === 'error') return serverError(sent.message)
      return apiError(sent.message, { status: sent.reason === 'busy' ? 409 : 400, code: sent.reason.toUpperCase() })
    }
    return NextResponse.json({ attendance: publicAttendance(sent.attendance) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'not sent')
  }
}

export async function DELETE(request: NextRequest) {
  if (!meetingAgentOn()) return off()
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
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
