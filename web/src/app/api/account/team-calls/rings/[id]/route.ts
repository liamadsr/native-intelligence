/**
 * POST /api/account/team-calls/rings/[id] { accept } → { state, join? } the
 * person answers their own ring (565's team_call_answer: only theirs, and
 * once). The state lands on the ring's row, which Realtime sends to every
 * tab and device of theirs, so the ring stops everywhere at once. Accepted:
 * `join` is the address and a token for the call's room. A ring settled
 * already (answered elsewhere, or run out) answers with how it was settled
 * and joins nothing unless it was accepted.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { answerRing, getCall } from '@/lib/team-calls/store'
import { joinAnswer, memberIn, teamCallsUnavailable } from '@/lib/team-calls/routes'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const config = teamCallsConfig()
  if (!config) return teamCallsUnavailable()
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (typeof input.accept !== 'boolean') return badRequest('accept must be true or false')
  try {
    const answered = await answerRing(auth.supabase, id, input.accept)
    if (!input.accept || answered.state !== 'accepted') return NextResponse.json({ state: answered.state })
    const call = await getCall(auth.supabase, answered.callId)
    if (!call) return notFound()
    if (call.status !== 'live') return apiError('This call has ended', { status: 409, code: 'CALL_ENDED' })
    const me = await memberIn(auth.supabase, auth.user.id, call.workspace_id)
    if (!me) return notFound()
    const join = await joinAnswer(config, { callId: call.id, room: call.room, memberId: me.id, name: me.display_name })
    return NextResponse.json({ state: answered.state, join, call: { id: call.id, channelId: call.channel_id, workspaceId: call.workspace_id, messageId: call.message_id, channelKind: call.channel_kind } })
  } catch (err) {
    return teamChatErrorResponse(err, 'call answer')
  }
}
