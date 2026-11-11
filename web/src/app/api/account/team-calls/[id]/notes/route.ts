/**
 * POST /api/account/team-calls/[id]/notes { on } → { notes } turn a live
 * call's notes on or off (calls plan, phase 6, migrations 566-567). Anyone
 * in the call may (567's team_call_set_notes, as the person: someone in it
 * now, or its starter); the change lands on the call's row, which Realtime
 * sends to everyone in it, so all of them see "Notes are on" at once.
 *
 * On: every microphone published in the room now gets its file (LiveKit
 * Egress, audio only); one published later gets its own from the
 * track_published webhook. Off: the running files are stopped and kept;
 * they become the call's notes when it ends.
 *
 * 404 when the server offers no notes (LIVEKIT_EGRESS off, or no Deepgram
 * key) or the call isn't the person's to read; 409 once it ended; 403 for
 * someone not in it; 400 at the 3-hour bound.
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { isUuid } from '@/lib/team-chat/types'
import { TeamChatError } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { liveKitEgress, teamCallEgressConfig, teamCallFeatures } from '@/lib/team-calls/egress'
import { getCall } from '@/lib/team-calls/store'
import { setNotes, startNotesForRoom, stopEgresses } from '@/lib/team-calls/notes-store'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const config = teamCallEgressConfig()
  if (!config || !teamCallFeatures().notes) return teamCallsUnavailable()
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
  if (typeof input.on !== 'boolean') return badRequest('on must be true or false')
  const on = input.on
  try {
    const call = await getCall(auth.supabase, id)
    if (!call) return notFound()
    if (call.status !== 'live') return apiError('This call has ended', { status: 409, code: 'CALL_ENDED' })
    let changed: Awaited<ReturnType<typeof setNotes>>
    try {
      changed = await setNotes(auth.supabase, id, on)
    } catch (err) {
      if (err instanceof TeamChatError && err.code === 'forbidden') return forbidden('Only someone in the call can change its notes')
      if (err instanceof TeamChatError && err.code === 'bad_request') return apiError('This call’s notes are full (3 hours)', { status: 400, code: 'NOTES_FULL' })
      throw err
    }
    if (changed.changed) {
      const port = liveKitEgress(config)
      const svc = getServiceClient()
      after(async () => {
        try {
          if (on) await startNotesForRoom(svc, port, { id: call.id, room: call.room })
          else await stopEgresses(svc, port, call.id, 'notes')
        } catch (err) {
          console.warn(`[team-call-notes] call=${call.id} egresses not ${on ? 'started' : 'stopped'}:`, err instanceof Error ? err.message : 'unknown')
        }
      })
    }
    console.info(`[team-call-notes] call=${call.id} notes=${changed.notes} changed=${changed.changed}`)
    return NextResponse.json({ notes: changed.notes })
  } catch (err) {
    return teamChatErrorResponse(err, 'call notes')
  }
}
