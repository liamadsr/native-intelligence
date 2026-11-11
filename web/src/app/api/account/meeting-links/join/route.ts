/**
 * POST /api/account/meeting-links/join { token } → { channelId, workspaceId, title }
 * a member opens a meeting link from inside the app (a calendar event's
 * Join): they join its conversation (574's meeting_join, as them: a member
 * of its workspace, holding its token, while the link works), and the page
 * opens it and its call. Anything else, a link of another workspace or one
 * no longer active, is a 404 that says nothing more.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { TeamChatError } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'
import { tokenDigest } from '@/lib/meeting-links/link'
import { isMeetingToken } from '@/lib/meeting-links/shape'
import { joinMeetingByDigest } from '@/lib/meeting-links/store'

export async function POST(request: NextRequest) {
  if (!teamCallsConfig()) return teamCallsUnavailable()
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  let input: { token?: unknown }
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (!isMeetingToken(input.token)) return notFound()
  try {
    const joined = await joinMeetingByDigest(auth.supabase, tokenDigest(input.token))
    return NextResponse.json({ channelId: joined.channelId, workspaceId: joined.workspaceId, title: joined.title, meetingId: joined.meetingId })
  } catch (err) {
    if (err instanceof TeamChatError && (err.code === 'forbidden' || err.code === 'bad_request')) return notFound()
    return teamChatErrorResponse(err, 'meeting join')
  }
}
