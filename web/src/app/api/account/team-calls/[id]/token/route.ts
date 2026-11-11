/**
 * POST /api/account/team-calls/[id]/token → { join } a fresh join for a live
 * call the person may read (its channel's readers: team_chat_can_read, by
 * RLS): the Join button on a call's message, and a full rejoin after the
 * connection was lost for good (LiveKit refreshes a connected participant's
 * token itself). One room, the person's member id as the identity, ten
 * minutes (src/lib/team-calls/livekit.ts), with the call's notes and
 * recording (the panel says "Notes are on" before any audio is sent). 409
 * once the call has ended; 404
 * for a call they may not read, or when calling is off.
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { getCall } from '@/lib/team-calls/store'
import { callEnded, callPlaceOf, callsUnreachable, joinAnswer, memberIn, readyRoom, teamCallsUnavailable } from '@/lib/team-calls/routes'

type Params = { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: Params) {
  const config = teamCallsConfig()
  if (!config) return teamCallsUnavailable()
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const call = await getCall(auth.supabase, id)
    if (!call) return notFound()
    if (call.status !== 'live') return callEnded()
    // An archived conversation's call is over, even before its end lands.
    if (call.channel_archived) return callEnded('This conversation is archived')
    const me = await memberIn(auth.supabase, auth.user.id, call.workspace_id)
    if (!me) return notFound()
    // Its room open before the token (LiveKit never makes one by itself).
    let room: 'ready' | 'ended'
    try {
      room = await readyRoom(config, call)
    } catch {
      return callsUnreachable()
    }
    if (room === 'ended') return callEnded()
    const join = await joinAnswer(config, { callId: call.id, room: call.room, memberId: me.id, name: me.display_name })
    return NextResponse.json({
      join,
      call: callPlaceOf(call, me.id),
    })
  } catch (err) {
    return teamChatErrorResponse(err, 'call token')
  }
}
