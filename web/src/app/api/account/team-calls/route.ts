/**
 * /api/account/team-calls (calls plan, phase 5, migrations 564-565)
 *   GET  → { available: false } when calling is off (the LiveKit settings
 *        unset: the app then shows no call button and listens for no ring);
 *        else { available: true, rings } the person's rings still open, in
 *        any workspace (an app that opens mid-ring draws it).
 *   POST { channelId } → { call, join } start a call in a channel or DM the
 *        person may post in, or join the one live there (one per
 *        conversation: a second start joins it). A new call gets its LiveKit
 *        room (with LiveKit's own timers: nobody comes, or the last person
 *        leaves, and it closes) and its message in the conversation; in a DM
 *        the other person is rung, in a channel nobody is (its people get
 *        one ordinary notification of the call's message, by their levels:
 *        src/lib/team-chat/notify.ts). A live call whose room is gone (its
 *        end never arrived) is ended and a new one started. `join` is the
 *        address and a ten-minute token for the room (src/lib/team-calls/
 *        livekit.ts); the API secret never leaves the server.
 * As the person, under RLS, for every read and the start; the room's
 * failure and a stale call's end run with the service role.
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { getChannel } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { requestTeamChatNotify } from '@/lib/team-chat/notify'
import { dmOtherMember, isUuid } from '@/lib/team-chat/types'
import { createTeamCallRoom, openTeamCallRooms, teamCallsConfig, type TeamCallsConfig } from '@/lib/team-calls/livekit'
import { endCall, getCall, notifyMissedCalls, openRings, requestRingTimers, ringMembers, startCall, type MadeRing, type StartedCall } from '@/lib/team-calls/store'
import { joinAnswer, memberIn, teamCallsUnavailable } from '@/lib/team-calls/routes'
import type { SupabaseClient } from '@supabase/supabase-js'

/** A live call older than this whose room is gone is ended, not joined. */
const STALE_CALL_MS = 60_000

export async function GET() {
  const config = teamCallsConfig()
  if (!config) return NextResponse.json({ available: false })
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  try {
    const rings = await openRings(auth.supabase)
    return NextResponse.json({ available: true, rings })
  } catch (err) {
    return teamChatErrorResponse(err, 'calls read')
  }
}

/** The live call there, ended and started again when its room has gone (its room_finished was lost). */
async function startFresh(supabase: SupabaseClient, config: TeamCallsConfig, channelId: string): Promise<StartedCall> {
  const started = await startCall(supabase, channelId)
  if (started.created) return started
  const call = await getCall(supabase, started.callId)
  if (!call || Date.now() - Date.parse(call.started_at) < STALE_CALL_MS) return started
  let open: Set<string>
  try {
    open = await openTeamCallRooms(config, [started.room])
  } catch {
    // The server can't be asked: join as it is (the token will tell).
    return started
  }
  if (open.has(started.room)) return started
  const svc = getServiceClient()
  const missed = await endCall(svc, started.callId, 'swept')
  if (missed.length) after(() => notifyMissedCalls(svc, missed).catch(() => undefined))
  return startCall(supabase, channelId)
}

export async function POST(request: NextRequest) {
  const config = teamCallsConfig()
  if (!config) return teamCallsUnavailable()
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const channelId = input.channelId
  if (!isUuid(channelId)) return badRequest('channelId must be a channel id')
  try {
    const channel = await getChannel(auth.supabase, channelId)
    if (!channel) return notFound()
    const me = await memberIn(auth.supabase, auth.user.id, channel.workspace_id)
    if (!me) return notFound()

    const started = await startFresh(auth.supabase, config, channelId)
    let rings: MadeRing[] = []
    if (started.created) {
      try {
        await createTeamCallRoom(config, started.room)
      } catch (err) {
        console.error(`[team-calls] call=${started.callId} room not made:`, err instanceof Error ? err.message : 'unknown')
        await endCall(getServiceClient(), started.callId, 'failed').catch(() => undefined)
        return apiError('The call server could not be reached', { status: 503, code: 'CALLS_UNREACHABLE' })
      }
      if (channel.kind === 'dm') {
        // A DM's start rings the other person (a note to self rings nobody).
        const other = dmOtherMember(channel.dm_key, me.id)
        if (other && other !== me.id) rings = await ringMembers(auth.supabase, started.callId, [other])
      }
    }
    const join = await joinAnswer(config, { callId: started.callId, room: started.room, memberId: me.id, name: me.display_name })
    const messageId = started.messageId
    after(async () => {
      await requestRingTimers(rings)
      // A channel's people hear of it as of any message (a DM's ring is its notice).
      if (started.created && channel.kind === 'channel' && messageId) await requestTeamChatNotify(messageId)
    })
    console.info(`[team-calls] call=${started.callId} channel=${channelId} created=${started.created} rung=${rings.length}`)
    return NextResponse.json({
      call: { id: started.callId, channelId, workspaceId: channel.workspace_id, messageId, created: started.created, channelKind: channel.kind, channelName: channel.name },
      rings: rings.map((r) => ({ memberId: r.memberId, state: r.state })),
      join,
    })
  } catch (err) {
    return teamChatErrorResponse(err, 'call start')
  }
}
