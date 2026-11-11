/**
 * POST /api/account/team-calls/[id]/leave → { ended } the person hung up.
 * A DM's call is between two people, so either one hanging up ends it at
 * once (its ring stops, it is a missed call if nobody answered, and its
 * room closes, which sends the other person out too). A channel's call goes
 * on until its last person leaves (LiveKit's own timer, then room_finished:
 * src/lib/team-calls/webhook.ts); nothing to do here.
 * The person must be able to read the call (RLS); the end runs with the
 * service role (565's team_call_end, once: a second leave finds it ended).
 */
import { after, NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { isUuid } from '@/lib/team-chat/types'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { closeTeamCallRoom, teamCallsConfig } from '@/lib/team-calls/livekit'
import { endCall, getCall, requestMissedNotices } from '@/lib/team-calls/store'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'

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
    if (call.status !== 'live' || call.channel_kind !== 'dm') return NextResponse.json({ ended: false })
    const svc = getServiceClient()
    const missed = await endCall(svc, call.id, 'left')
    after(async () => {
      // One notice per ring, through Inngest (the sweeper finds any not asked for).
      await requestMissedNotices(missed)
      await closeTeamCallRoom(config, call.room).catch((err) => console.warn(`[team-calls] call=${call.id} room not closed:`, err instanceof Error ? err.message : 'unknown'))
    })
    console.info(`[team-calls] call=${call.id} outcome=left missed=${missed.length}`)
    return NextResponse.json({ ended: true })
  } catch (err) {
    return teamChatErrorResponse(err, 'call leave')
  }
}
