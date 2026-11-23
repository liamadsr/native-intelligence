/**
 * /api/account/team-chat/channels/[id]/contents (migration 714)
 *   GET → { contents: MeetingChatContents } what deleting this meeting chat
 *         would take, counted for its confirmation: messages, files, polls,
 *         calls, the call notes that stay, whether a call is live, whether
 *         its link still works, whether it is a booking's. Only for someone
 *         who may delete it (its host, or the workspace's owner or admin).
 * Runs as the person (714's team_chat_meeting_chat_contents).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, notFound } from '@/lib/api-errors'
import { TeamChatError } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { meetingChatContents } from '@/lib/team-chat/manage'
import { isUuid } from '@/lib/team-chat/types'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const contents = await meetingChatContents(auth.supabase, id)
    return NextResponse.json({ contents })
  } catch (err) {
    if (err instanceof TeamChatError) {
      if (err.code === 'forbidden') return forbidden('Only the meeting’s host or a workspace admin can delete it')
      if (err.code === 'bad_request') return badRequest('Only a meeting chat can be deleted')
    }
    return teamChatErrorResponse(err, 'meeting chat contents')
  }
}
