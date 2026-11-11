/**
 * POST /api/account/team-calls/[id]/notice → { ok: true } the person has
 * seen that this call's notes (or its recording) are on, and joins with their
 * microphone: their listen-only connection (a join that did not say
 * `noticeSeen: true`, see src/lib/team-calls/routes.ts joinsListenOnly) may
 * publish from now on. LiveKit raises their permissions in the room to a
 * token's, never more.
 *
 * For a client (web, desktop, iOS): either send `noticeSeen: true` with the
 * join (start, token, ring answer) after showing the notice, or join without
 * it, show the notice, then POST here before publishing.
 *
 * 404 for a call the person may not read, or when calling is off; 409 once it
 * ended, or when they are not connected to it (join first); 503 when LiveKit
 * can't be asked.
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { apiError, notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { allowTeamCallPublish, teamCallsConfig } from '@/lib/team-calls/livekit'
import { getCall } from '@/lib/team-calls/store'
import { callEnded, callsUnreachable, memberIn, teamCallsUnavailable } from '@/lib/team-calls/routes'

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
    if (call.status !== 'live' || call.channel_archived) return callEnded()
    const me = await memberIn(auth.supabase, auth.user.id, call.workspace_id)
    if (!me) return notFound()
    try {
      await allowTeamCallPublish(config, call.room, me.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/not.?found|does not exist/i.test(message)) return apiError('You are not connected to this call', { status: 409, code: 'NOT_IN_CALL' })
      console.warn(`[team-calls] call=${call.id} publish not allowed:`, message.slice(0, 120))
      return callsUnreachable()
    }
    console.info(`[team-calls] call=${call.id} member=${me.id} outcome=notice_seen`)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return teamChatErrorResponse(err, 'call notice')
  }
}
