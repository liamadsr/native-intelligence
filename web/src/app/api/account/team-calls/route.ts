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
 *        the other person is rung, on the web over Realtime and on their
 *        phones as a call (src/lib/team-calls/ring-push.ts; 565's limits
 *        may say not: a decline there
 *        a moment ago), in a channel nobody is (its people get one ordinary
 *        notification of the call's message, by their levels:
 *        src/lib/team-chat/notify.ts). Every token is for an open room: the
 *        app makes rooms, LiveKit never does (src/lib/team-calls/routes.ts
 *        readyRoom); a live call whose room went long ago (its end never
 *        arrived) is ended and a new one started. `join` is the
 *        address and a ten-minute token for the room (src/lib/team-calls/
 *        livekit.ts); the API secret never leaves the server.
 *        A NEW call starts with its notes on wherever the call recorder takes
 *        them (TEAM_CALL_RECORDER): every call, whoever starts it and from
 *        whatever client (web, desktop, iPhone, a meeting link's or a
 *        booking's meeting); nothing is heard, and no capture made, until a
 *        second person is in the call (src/lib/team-calls/recorder.ts
 *        recorderWork). The in-call switch still turns them off and on. Where Egress takes the notes
 *        (LIVEKIT_EGRESS=on and a Deepgram key), only when the starter asks
 *        (`notes: true`, the desktop app's "Auto-record meetings").
 *        Joining a live call never changes its notes. The answer carries what
 *        the server offers (`features`) and the call's notes and recording
 *        (`notes`).
 * As the person, under RLS, for every read and the start; the room's
 * failure and a stale call's end run with the service role.
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { getChannel, TeamChatError } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { requestTeamChatNotify } from '@/lib/team-chat/notify'
import { dmOtherMember, isUuid } from '@/lib/team-chat/types'
import { createTeamCallRoom, teamCallsConfig, type TeamCallsConfig } from '@/lib/team-calls/livekit'
import { endCall, getCall, openRings, requestRingTimers, ringMembers, startCall, type MadeRing, type StartedCall } from '@/lib/team-calls/store'
import { callsUnreachable, joinAnswer, joinsListenOnly, memberIn, notesViewOf, readyRoom, teamCallsUnavailable } from '@/lib/team-calls/routes'
import { teamCallFeatures } from '@/lib/team-calls/egress'
import { setNotes } from '@/lib/team-calls/notes-store'
import { newCallTakesNotes } from '@/lib/team-calls/notes'
import { liveRingPushDeps, pushRings } from '@/lib/team-calls/ring-push'
import type { SupabaseClient } from '@supabase/supabase-js'

export async function GET() {
  const config = teamCallsConfig()
  if (!config) return NextResponse.json({ available: false })
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  try {
    const rings = await openRings(auth.supabase)
    return NextResponse.json({ available: true, rings, features: teamCallFeatures() })
  } catch (err) {
    return teamChatErrorResponse(err, 'calls read')
  }
}

/**
 * The live call there with its room open (made again when it went and the
 * call is young), or a new one: a live call whose room went long ago (its
 * end was lost) is ended and a new one started. A new call's room is made
 * by the caller below. Throws when LiveKit can't be asked.
 */
async function startReady(supabase: SupabaseClient, config: TeamCallsConfig, channelId: string): Promise<StartedCall> {
  const started = await startCall(supabase, channelId)
  if (started.created) return started
  const call = await getCall(supabase, started.callId)
  if (!call) return started
  if ((await readyRoom(config, call)) === 'ready') return started
  return startCall(supabase, channelId)
}

const isTeamChatError = (err: unknown): boolean => err instanceof TeamChatError

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

    let started: StartedCall
    try {
      started = await startReady(auth.supabase, config, channelId)
    } catch (err) {
      if (isTeamChatError(err)) throw err
      console.error(`[team-calls] channel=${channelId} room check failed:`, err instanceof Error ? err.message : 'unknown')
      return callsUnreachable()
    }
    let rings: MadeRing[] = []
    if (started.created) {
      try {
        // LiveKit never makes a room by itself: the call's room, before its first token.
        await createTeamCallRoom(config, started.room)
      } catch (err) {
        console.error(`[team-calls] call=${started.callId} room not made:`, err instanceof Error ? err.message : 'unknown')
        await endCall(getServiceClient(), started.callId, 'failed').catch(() => undefined)
        return callsUnreachable()
      }
      if (channel.kind === 'dm') {
        // A DM's start rings the other person (a note to self rings nobody).
        const other = dmOtherMember(channel.dm_key, me.id)
        if (other && other !== me.id) rings = await ringMembers(auth.supabase, started.callId, [other])
      }
    }
    const features = teamCallFeatures()
    let notes = notesViewOf(null)
    if (started.created && newCallTakesNotes(features, input.notes)) {
      try {
        const on = await setNotes(auth.supabase, started.callId, true)
        // The recorder's notes (src/lib/team-calls/recorder.ts): no capture yet. The recorder's
        // session makes it once a second person is in the call (nothing is heard before).
        notes = notesViewOf({ notes: on.notes, notes_by: on.notes ? me.id : null, notes_state: on.notes ? 'capturing' : 'none', capture_id: null })
        if (!on.notes) console.error(`[team-calls] call=${started.callId} notes not turned on at the start: refused`)
      } catch (err) {
        // The call goes on without notes (every call is to be captured: this is an error); the panel offers them.
        console.error(`[team-calls] call=${started.callId} notes not turned on at the start:`, err instanceof Error ? err.message : 'unknown')
      }
    } else if (!started.created) {
      notes = notesViewOf(await getCall(auth.supabase, started.callId))
    }
    const join = await joinAnswer(config, {
      callId: started.callId,
      room: started.room,
      memberId: me.id,
      name: me.display_name,
      listenOnly: joinsListenOnly(notes, me.id, input.noticeSeen, features),
    })
    const messageId = started.messageId
    after(async () => {
      await Promise.all([requestRingTimers(rings), rings.length ? pushRings(liveRingPushDeps(getServiceClient()), rings) : null])
      // A channel's people hear of it as of any message (a DM's ring is its notice).
      if (started.created && channel.kind === 'channel' && messageId) await requestTeamChatNotify(messageId)
    })
    console.info(`[team-calls] call=${started.callId} channel=${channelId} created=${started.created} rung=${rings.length}`)
    return NextResponse.json({
      call: {
        id: started.callId,
        channelId,
        workspaceId: channel.workspace_id,
        messageId,
        created: started.created,
        channelKind: channel.kind,
        channelName: channel.name,
        memberId: me.id,
        features,
        notes,
      },
      rings: rings.map((r) => ({ memberId: r.memberId, state: r.state })),
      join,
    })
  } catch (err) {
    return teamChatErrorResponse(err, 'call start')
  }
}
