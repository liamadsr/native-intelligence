/**
 * GET /api/account/team-calls/[id]/live-notes → { captureId, summary, state }
 * the call's shared live notes, for someone in the call (phase 2: the live
 * agent writes them on the server as people speak, src/lib/team-calls/
 * live-turns.ts). `summary`: the capture's summary as it stands; `state`: what
 * the agent is doing (655's metadata.live_notes: working, ready, failed or
 * stopped, with when), or null before its first turn.
 *
 * Read as the person, so the call's capture is theirs to read only as it
 * always is: a member of the call's conversation (566's fence), never anyone
 * else in the workspace. After this first read the panel follows the
 * capture's row over Realtime, as the capture page follows its transcript.
 *
 * 404 while the live agent is off here, or when the call or its notes are not
 * the person's to read; `captureId: null` while the call has no notes yet.
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { getCall } from '@/lib/team-calls/store'
import { teamCallLiveAgentOn } from '@/lib/team-calls/live-turns'
import { liveNotesOf } from '@/lib/team-calls/live-notes'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  if (!teamCallLiveAgentOn()) return teamCallsUnavailable()
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const call = await getCall(auth.supabase, id)
    if (!call) return notFound()
    if (!call.capture_id) return NextResponse.json({ captureId: null, summary: '', state: null })
    const { data: capture, error } = await auth.supabase
      .from('captures')
      .select('id, ai_summary, metadata')
      .eq('id', call.capture_id)
      .maybeSingle<{ id: string; ai_summary: string | null; metadata: Record<string, unknown> | null }>()
    if (error) throw new Error(error.message)
    if (!capture) return notFound()
    return NextResponse.json({ captureId: capture.id, ...liveNotesOf(capture) })
  } catch (err) {
    console.error('[call-live-notes] read failed:', err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return serverError()
  }
}
