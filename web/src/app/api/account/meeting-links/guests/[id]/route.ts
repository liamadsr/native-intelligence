/**
 * POST /api/account/meeting-links/guests/[id] { action } a member answers for a
 * meeting's guest (phase 7):
 *   'admit' | 'decline'  someone in the meeting's live call lets a waiting
 *                        guest in, or not (574's meeting_guest_decide; the
 *                        first answer settles it). → { state }
 *   'remove'             a member of the conversation removes the guest for
 *                        good (574's meeting_guest_remove): out of the room
 *                        now (the eject outbox, drained at once), no token
 *                        again, and the link stays shut to them. → { state }
 * As the person, under the functions' own checks.
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'
import { getServiceClient } from '@/lib/admin'
import { drainTeamCallEjections, liveEjectDeps } from '@/lib/team-calls/eject'
import { decideGuest, removeGuest } from '@/lib/meeting-links/store'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const config = teamCallsConfig()
  if (!config) return teamCallsUnavailable()
  // Out of the room now (the minute's drain is the floor).
  const drainNow = () => drainTeamCallEjections(getServiceClient(), liveEjectDeps(config)).then(() => undefined, () => undefined)
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  let input: { action?: unknown }
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  try {
    if (input.action === 'admit' || input.action === 'decline') {
      const res = await decideGuest(auth.supabase, id, input.action === 'admit')
      console.info(`[meetings] guest=${id} outcome=${res.state}`)
      return NextResponse.json({ state: res.state })
    }
    if (input.action === 'remove') {
      const res = await removeGuest(auth.supabase, id)
      if (res.ejected) after(() => drainNow())
      console.info(`[meetings] guest=${id} outcome=removed ejected=${res.ejected}`)
      return NextResponse.json({ state: 'removed' })
    }
    return badRequest('action must be admit, decline or remove')
  } catch (err) {
    return teamChatErrorResponse(err, 'guest answer')
  }
}
