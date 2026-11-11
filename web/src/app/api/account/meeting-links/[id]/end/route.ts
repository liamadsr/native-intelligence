/**
 * POST /api/account/meeting-links/[id]/end → { ended } the host ends the
 * meeting's call for everyone: the call ends (565's team_call_end,
 * 'finished', with its notes written as any call's), its room closes (every
 * member and guest out at once) and its admitted guests are let go (574's
 * trigger). The link keeps working for a later call until it is revoked or
 * runs out. The host only; the end runs with the service role.
 */
import { after, NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { forbidden, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { isUuid } from '@/lib/team-chat/types'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { closeTeamCallRoom, teamCallsConfig } from '@/lib/team-calls/livekit'
import { memberIn, teamCallsUnavailable } from '@/lib/team-calls/routes'
import { endCall, requestMissedNotices } from '@/lib/team-calls/store'
import { meetingById } from '@/lib/meeting-links/store'

type Params = { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: Params) {
  const config = teamCallsConfig()
  if (!config) return teamCallsUnavailable()
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const meeting = await meetingById(auth.supabase, id)
    if (!meeting) return notFound()
    const me = await memberIn(auth.supabase, auth.user.id, meeting.workspace_id)
    if (!me || me.id !== meeting.host_member_id) return forbidden('Only the host can end the meeting')
    const { data: live } = await auth.supabase
      .from('team_call')
      .select('id, room')
      .eq('channel_id', meeting.channel_id)
      .eq('status', 'live')
      .maybeSingle<{ id: string; room: string }>()
    if (!live) return NextResponse.json({ ended: false })
    const missed = await endCall(getServiceClient(), live.id, 'finished')
    after(async () => {
      await requestMissedNotices(missed)
      await closeTeamCallRoom(config, live.room).catch((err) => console.warn(`[meetings] call=${live.id} room not closed:`, err instanceof Error ? err.message : 'unknown'))
    })
    console.info(`[meetings] meeting=${id} call=${live.id} outcome=ended_by_host`)
    return NextResponse.json({ ended: true })
  } catch (err) {
    return teamChatErrorResponse(err, 'meeting end')
  }
}
