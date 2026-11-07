/**
 * GET /api/local-agent/sessions?conversationId=…&live=1 — the person's local
 * agents (newest first, at most 100), optionally one conversation's, or only
 * the live ones. Returns {sessions: SessionRow[]}.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { errorResponse, requireLocalAgentUser } from '@/lib/local-agent/http'
import { isUuid, listSessions } from '@/lib/local-agent/store'

export async function GET(request: Request) {
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  const params = new URL(request.url).searchParams
  const conversationId = params.get('conversationId')
  const live = params.get('live') === '1' || params.get('live') === 'true'
  if (conversationId && !isUuid(conversationId)) return NextResponse.json({ sessions: [] })
  try {
    const sessions = await listSessions(getServiceClient(), auth.user.id, {
      ...(conversationId ? { conversationId } : {}),
      ...(live ? { live } : {}),
    })
    return NextResponse.json({ sessions })
  } catch (err) {
    return errorResponse(err, 'list sessions')
  }
}
