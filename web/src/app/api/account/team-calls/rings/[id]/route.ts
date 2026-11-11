/**
 * POST /api/account/team-calls/rings/[id] { accept, voipToken?, onlyIfRinging? }
 * → { state, join?, elsewhere? } the person answers their own ring (565's
 * team_call_answer: only theirs, and once). The state lands on the ring's
 * row, which Realtime sends to every tab and device of theirs, so the ring
 * stops everywhere at once; their phones ringing for it get its cancel
 * (src/lib/team-calls/ring-push.ts), all but the one that answered (the iOS
 * app names its own VoIP token, `voipToken`: it is in the call). Accepted:
 * `join` is the address and a token for the call's room. A ring settled
 * already (answered elsewhere, or run out) answers with how it was settled
 * and joins nothing unless it was accepted.
 *
 * The phone (calls plan, phase 8) asks `onlyIfRinging`: a ring settled
 * before this answer (accepted on the web, say) answers { state,
 * elsewhere: true } and no join, so the phone ends its call as answered
 * elsewhere instead of joining under the same identity and pushing the
 * web's session out. The web leaves it off and keeps its behaviour.
 *
 * An accept whose call turns out to be over (ended, archived, its room gone:
 * 409) doesn't leave the ring 'accepted': it is missed, so the person's other
 * devices are never told it was answered when nobody joined.
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { answerRing, getCall } from '@/lib/team-calls/store'
import { callEnded, callsUnreachable, joinAnswer, memberIn, readyRoom, teamCallsUnavailable } from '@/lib/team-calls/routes'
import { cancelRingPushes, liveRingPushDeps, voipTokenOf } from '@/lib/team-calls/ring-push'
import { getServiceClient } from '@/lib/admin'
import type { TeamCallRingState } from '@/lib/team-calls/types'
import type { SupabaseClient } from '@supabase/supabase-js'

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
    // How the ring stood before this answer (the person's own row, by RLS).
    const before = await ringState(auth.supabase, id)
    const wasOpen = before === 'ringing' || before === 'busy'
    if (input.onlyIfRinging === true && before && !wasOpen) return NextResponse.json({ state: before, elsewhere: true })
    const answered = await answerRing(auth.supabase, id, input.accept)
    if (answered.state !== 'ringing' && answered.state !== 'busy') {
      const exceptToken = voipTokenOf(input.voipToken)
      after(() => cancelRingPushes(liveRingPushDeps(getServiceClient()), { ringIds: [id], exceptToken }))
    }
    if (!input.accept || answered.state !== 'accepted') return NextResponse.json({ state: answered.state })
    // This answer accepted a call that is over: the ring is missed, not answered.
    const over = async (response: Response) => {
      if (wasOpen) await unaccept(id)
      return response
    }
    const call = await getCall(auth.supabase, answered.callId)
    if (!call) return notFound()
    if (call.status !== 'live') return over(callEnded())
    // An archived conversation's call is over, even before its end lands.
    if (call.channel_archived) return over(callEnded('This conversation is archived'))
    const me = await memberIn(auth.supabase, auth.user.id, call.workspace_id)
    if (!me) return notFound()
    // Its room open before the token (LiveKit never makes one by itself).
    let room: 'ready' | 'ended'
    try {
      room = await readyRoom(config, call)
    } catch {
      return callsUnreachable()
    }
    if (room === 'ended') return over(callEnded())
    const join = await joinAnswer(config, { callId: call.id, room: call.room, memberId: me.id, name: me.display_name })
    return NextResponse.json({ state: answered.state, join, call: { id: call.id, channelId: call.channel_id, workspaceId: call.workspace_id, messageId: call.message_id, channelKind: call.channel_kind } })
  } catch (err) {
    return teamChatErrorResponse(err, 'call answer')
  }
}

/** The ring's state as the person reads it, or null (not theirs, or gone). */
async function ringState(supabase: SupabaseClient, ringId: string): Promise<TeamCallRingState | null> {
  const { data, error } = await supabase.from('team_call_ring').select('state').eq('id', ringId).maybeSingle<{ state: TeamCallRingState }>()
  if (error) throw new Error(`team calls: ring read failed: ${error.message}`)
  return data?.state ?? null
}

/** An accept of a call that is over becomes a missed ring (service role: rings are no client's to write). */
async function unaccept(ringId: string): Promise<void> {
  const { error } = await getServiceClient().from('team_call_ring').update({ state: 'missed' }).eq('id', ringId).eq('state', 'accepted')
  if (error) console.warn(`[team-calls] ring=${ringId} not set missed after its call was over:`, error.message)
}
