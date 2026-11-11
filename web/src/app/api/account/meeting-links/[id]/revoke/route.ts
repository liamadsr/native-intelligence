/**
 * POST /api/account/meeting-links/[id]/revoke → { revoked } the host turns the
 * meeting's link off (574's meeting_revoke, the host only): it answers "this
 * link is no longer active" from now on, guests waiting are let go and
 * guests in the call are taken out of the room (the eject outbox, drained
 * now). The conversation and the members' call go on.
 */
import { after, NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'
import { getServiceClient } from '@/lib/admin'
import { drainTeamCallEjections, liveEjectDeps } from '@/lib/team-calls/eject'
import { revokeMeeting } from '@/lib/meeting-links/store'
import { meetingCalendarChanged } from '@/lib/meeting-links/calendar-events'

type Params = { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: Params) {
  const config = teamCallsConfig()
  if (!config) return teamCallsUnavailable()
  // Out of the room now (the minute's drain is the floor).
  const drainNow = () => drainTeamCallEjections(getServiceClient(), liveEjectDeps(config)).then(() => undefined, () => undefined)
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const res = await revokeMeeting(auth.supabase, id)
    if (res.revoked && res.callId) after(() => drainNow())
    // Its calendar event (if it was put on one) goes too, on the calendar it was written to; never fails the revoke.
    if (res.revoked) after(() => meetingCalendarChanged(getServiceClient(), id, { kind: 'revoked' }).then(() => undefined))
    console.info(`[meetings] meeting=${id} outcome=${res.revoked ? 'revoked' : 'revoked_already'}`)
    return NextResponse.json({ revoked: true })
  } catch (err) {
    return teamChatErrorResponse(err, 'meeting revoke')
  }
}
