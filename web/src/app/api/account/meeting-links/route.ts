/**
 * /api/account/meeting-links (calls plan, phase 7, migrations 572-575)
 *   POST { title, startsAt?, minutes? } → { meeting } a meeting link in the
 *        current workspace, made as the person (they are its host): its
 *        conversation (kind 'meeting'), its link (`<app>/m/<token>`), and
 *        when the link works (src/lib/meeting-links/create.ts). The conversation
 *        shows in team chat once it is used.
 *   GET ?channel=<id> → { meeting } the meeting a conversation is, with its
 *        link, for whoever may read the conversation (RLS), or null.
 * 404 for both while calling is off (the LiveKit settings unset): there is
 * nothing a meeting could be.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser, requireWorkspace } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { TeamChatError } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isUuid } from '@/lib/team-chat/types'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'
import { createMeetingLink } from '@/lib/meeting-links/create'
import { meetingLink } from '@/lib/meeting-links/link'
import { meetingNonce, meetingOfChannel } from '@/lib/meeting-links/store'
import { getServiceClient } from '@/lib/admin'

export async function GET(request: NextRequest) {
  if (!teamCallsConfig()) return teamCallsUnavailable()
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const channelId = request.nextUrl.searchParams.get('channel')
  if (!isUuid(channelId)) return badRequest('channel must be a conversation id')
  try {
    const meeting = await meetingOfChannel(auth.supabase, channelId)
    if (!meeting) return NextResponse.json({ meeting: null })
    const { workspace_id: _ws, ...rest } = meeting
    // The link's nonce is the server's alone (no client grant): read with the service role once RLS let the person see the meeting.
    const nonce = await meetingNonce(getServiceClient(), meeting.id)
    return NextResponse.json({ meeting: { ...rest, url: nonce ? meetingLink(meeting.id, nonce) : null } })
  } catch (err) {
    return teamChatErrorResponse(err, 'meeting read')
  }
}

export async function POST(request: NextRequest) {
  if (!teamCallsConfig()) return teamCallsUnavailable()
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const startsAt = typeof input.startsAt === 'string' && input.startsAt ? input.startsAt : null
  const minutes = typeof input.minutes === 'number' ? input.minutes : null
  try {
    const made = await createMeetingLink(auth.supabase, { workspaceId: auth.workspaceId, title: String(input.title ?? ''), startsAt, minutes })
    return NextResponse.json({ meeting: made })
  } catch (err) {
    if (err instanceof TeamChatError && err.code === 'bad_request') return badRequest(err.message)
    return teamChatErrorResponse(err, 'meeting create')
  }
}
