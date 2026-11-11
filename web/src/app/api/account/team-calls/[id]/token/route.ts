/**
 * POST /api/account/team-calls/[id]/token → { join } a fresh join for a live
 * call the person may read (its channel's readers: team_chat_can_read, by
 * RLS): the Join button on a call's message, and a full rejoin after the
 * connection was lost for good (LiveKit refreshes a connected participant's
 * token itself). One room, the person's member id as the identity, ten
 * minutes (src/lib/team-calls/livekit.ts). 409 once the call has ended; 404
 * for a call they may not read, or when calling is off.
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { apiError, notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { getCall } from '@/lib/team-calls/store'
import { joinAnswer, memberIn, teamCallsUnavailable } from '@/lib/team-calls/routes'

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
    if (call.status !== 'live') return apiError('This call has ended', { status: 409, code: 'CALL_ENDED' })
    const me = await memberIn(auth.supabase, auth.user.id, call.workspace_id)
    if (!me) return notFound()
    const join = await joinAnswer(config, { callId: call.id, room: call.room, memberId: me.id, name: me.display_name })
    return NextResponse.json({ join, call: { id: call.id, channelId: call.channel_id, workspaceId: call.workspace_id, messageId: call.message_id, channelKind: call.channel_kind } })
  } catch (err) {
    return teamChatErrorResponse(err, 'call token')
  }
}
