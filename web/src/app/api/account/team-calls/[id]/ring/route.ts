/**
 * POST /api/account/team-calls/[id]/ring { memberIds } → { rings } ring
 * people into a live call the person may read (a channel's call rings
 * nobody by itself: the caller picks). Each must be able to read the
 * channel; someone in the call already is skipped; someone in another call
 * gets a quiet notice instead of a ring ('busy'). At most 20 at once.
 * Each ring's timer starts after the answer: unanswered for 40 seconds, it
 * is a missed call (src/lib/inngest/team-calls.ts). A ring rings on the web
 * over Realtime and on the person's phones as a call (src/lib/team-calls/
 * ring-push.ts).
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { isUuid, tidyMentionIds } from '@/lib/team-chat/types'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { requestRingTimers, ringMembers } from '@/lib/team-calls/store'
import { liveRingPushDeps, pushRings } from '@/lib/team-calls/ring-push'
import { getServiceClient } from '@/lib/admin'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'
import { TEAM_CALL_MAX_RING } from '@/lib/team-calls/types'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  if (!teamCallsConfig()) return teamCallsUnavailable()
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
  if (!Array.isArray(input.memberIds)) return badRequest('memberIds must be a list')
  const memberIds = tidyMentionIds(input.memberIds)
  if (memberIds.length === 0) return badRequest('Nobody to ring')
  if (memberIds.length > TEAM_CALL_MAX_RING) return badRequest(`At most ${TEAM_CALL_MAX_RING} people at a time`)
  try {
    const rings = await ringMembers(auth.supabase, id, memberIds)
    after(() => Promise.all([requestRingTimers(rings), rings.length ? pushRings(liveRingPushDeps(getServiceClient()), rings) : null]))
    return NextResponse.json({ rings: rings.map((r) => ({ memberId: r.memberId, state: r.state })) })
  } catch (err) {
    return teamChatErrorResponse(err, 'call ring')
  }
}
