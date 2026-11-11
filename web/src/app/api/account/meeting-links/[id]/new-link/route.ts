/**
 * POST /api/account/meeting-links/[id]/new-link → { url } the host replaces
 * the meeting's link (a leaked one, say): a new random token, so the old
 * link stops working at once; a revoked link's meeting works again; guests
 * waiting on the old link are let go. The meeting and its conversation stay.
 * The host only (574's meeting_new_link, as the person).
 */
import { after, NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { TeamChatError } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'
import { newMeetingLink } from '@/lib/meeting-links/create'
import { meetingCalendarChanged } from '@/lib/meeting-links/calendar-events'
import { getServiceClient } from '@/lib/admin'

type Params = { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: Params) {
  if (!teamCallsConfig()) return teamCallsUnavailable()
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const url = await newMeetingLink(auth.supabase, id)
    // Its calendar event (if any) carries the new link; never fails the new link.
    after(() => meetingCalendarChanged(getServiceClient(), id, { kind: 'relinked', url }).then(() => undefined))
    return NextResponse.json({ url })
  } catch (err) {
    if (err instanceof TeamChatError && err.code === 'bad_request') return badRequest(err.message)
    return teamChatErrorResponse(err, 'meeting new link')
  }
}
