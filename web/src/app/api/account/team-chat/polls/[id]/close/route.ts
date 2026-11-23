/**
 * /api/account/team-chat/polls/[id]/close (migration 703)
 *   POST → { poll } closed now: by its author, or by the person whose agent
 *        posted it (703's team_chat_poll_close; anyone else is refused).
 *        Closing a closed poll answers it as it is.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { closePoll } from '@/lib/team-chat/poll-store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isUuid } from '@/lib/team-chat/types'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const poll = await closePoll(auth.supabase, id)
    return NextResponse.json({ poll })
  } catch (err) {
    return teamChatErrorResponse(err, 'poll close')
  }
}
