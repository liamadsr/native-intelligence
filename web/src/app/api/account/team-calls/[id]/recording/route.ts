/**
 * /api/account/team-calls/[id]/recording (calls plan, phase 6)
 *   POST { action: 'start' } → { recording: 'starting' } record the whole
 *        call (video and audio, one file). Only where the server allows it
 *        (LIVEKIT_EGRESS=on and TEAM_CALL_RECORDING=on, else 404 and the
 *        control is absent), only by someone in the call, one at a time per
 *        call, and at most TEAM_CALL_RECORDING_MAX (default 1) across the
 *        server: past that, 409 RECORDING_BUSY "Another recording is
 *        running". Everyone in the call sees it through the call's row.
 *   POST { action: 'stop' } → { stopping } stop it (anyone in the call). It
 *        also stops when the call ends, and at 2 hours.
 *   GET  → { url } a link to the saved file, for someone who may read the
 *        conversation: minted as them (566's storage policy is the check,
 *        after the call's own read under RLS), lasting an hour, never a
 *        public address. 404 for anyone else, or before it is saved.
 */
import { holdGuestsForNotice } from '@/lib/meeting-links/consent'
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { isUuid } from '@/lib/team-chat/types'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { liveKitEgress, maxLiveRecordings, teamCallEgressConfig, teamCallFeatures } from '@/lib/team-calls/egress'
import { getCall } from '@/lib/team-calls/store'
import { recordingLink, startRecording, stopEgresses } from '@/lib/team-calls/notes-store'
import { TEAM_CALL_RECORDING_URL_TTL_SECONDS } from '@/lib/team-calls/notes'
import { callEnded, memberIn, teamCallsUnavailable } from '@/lib/team-calls/routes'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  if (!teamCallsConfig()) return teamCallsUnavailable()
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const url = await recordingLink(auth.supabase, getServiceClient(), id, TEAM_CALL_RECORDING_URL_TTL_SECONDS)
    if (!url) return notFound()
    return NextResponse.json({ url, expiresIn: TEAM_CALL_RECORDING_URL_TTL_SECONDS })
  } catch (err) {
    return teamChatErrorResponse(err, 'call recording link')
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const config = teamCallEgressConfig()
  if (!config || !teamCallFeatures().recording) return teamCallsUnavailable()
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
  if (input.action !== 'start' && input.action !== 'stop') return badRequest('action must be start or stop')
  try {
    const call = await getCall(auth.supabase, id)
    if (!call) return notFound()
    if (call.status !== 'live' || call.channel_archived) return callEnded()
    const me = await memberIn(auth.supabase, auth.user.id, call.workspace_id)
    if (!me) return notFound()
    const svc = getServiceClient()
    const port = liveKitEgress(config)
    if (input.action === 'stop') {
      // Anyone in the call (its people are readable to its readers, by RLS).
      const { data: inCall } = await auth.supabase
        .from('team_call_participant')
        .select('member_id')
        .eq('call_id', call.id)
        .eq('member_id', me.id)
        .eq('state', 'joined')
        .maybeSingle()
      if (!inCall) return forbidden('Only someone in the call can stop its recording')
      const stopping = await stopEgresses(svc, port, call.id, 'recording')
      console.info(`[team-call-recording] call=${call.id} outcome=stop stopping=${stopping}`)
      return NextResponse.json({ stopping: stopping > 0 })
    }
    // A meeting's guests who haven't said go to a recording are held to listen-only before it starts (phase 7).
    const livekit = teamCallsConfig()
    const outcome = await startRecording(svc, port, { id: call.id, room: call.room }, me.id, maxLiveRecordings(), () =>
      livekit && call.channel_kind === 'meeting' ? holdGuestsForNotice(svc, livekit, call.id) : Promise.resolve(0),
    )
    console.info(`[team-call-recording] call=${call.id} outcome=${outcome}`)
    switch (outcome) {
      case 'claimed':
      case 'already':
        return NextResponse.json({ recording: 'starting' })
      case 'busy':
        return apiError('Another recording is running', { status: 409, code: 'RECORDING_BUSY' })
      case 'saved':
        return apiError('This call was recorded already', { status: 409, code: 'RECORDING_SAVED' })
      case 'ended':
        return callEnded()
      case 'not_in_call':
        return forbidden('Only someone in the call can record it')
      case 'failed':
        return apiError('The recording could not start', { status: 503, code: 'RECORDING_FAILED' })
      default:
        return notFound()
    }
  } catch (err) {
    return teamChatErrorResponse(err, 'call recording')
  }
}
