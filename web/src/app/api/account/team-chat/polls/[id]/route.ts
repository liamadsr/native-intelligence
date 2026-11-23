/**
 * /api/account/team-chat/polls/[id] (migration 703)
 *   GET → { poll } as the person sees it (703's team_chat_poll_read): its
 *       counts, their own choices, who chose what unless it's anonymous, and
 *       whether they may close it. 404 for a poll they may not read (its
 *       channel), whose message is deleted, or that isn't there.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { readPoll } from '@/lib/team-chat/poll-store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isUuid } from '@/lib/team-chat/types'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const poll = await readPoll(auth.supabase, id)
    if (!poll) return notFound()
    return NextResponse.json({ poll })
  } catch (err) {
    return teamChatErrorResponse(err, 'poll read')
  }
}
