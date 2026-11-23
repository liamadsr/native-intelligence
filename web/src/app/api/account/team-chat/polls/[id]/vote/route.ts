/**
 * /api/account/team-chat/polls/[id]/vote (migration 703)
 *   POST { option_ids: uuid[] } → { poll } the person's whole answer: one
 *        option (several when the poll allows it), or none to take a vote
 *        back. 703's team_chat_poll_vote holds that they may post in the
 *        channel, the poll is open (not closed, not past its closing time),
 *        and the options are its own; it replaces their answer under the
 *        poll's lock and rewrites the tally.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { tidyOptionIds, votePoll } from '@/lib/team-chat/poll-store'
import { TeamChatError } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isUuid } from '@/lib/team-chat/types'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const optionIds = tidyOptionIds(input.option_ids)
  if (!optionIds) return badRequest('option_ids must be a list of option ids')
  try {
    const poll = await votePoll(auth.supabase, id, optionIds)
    return NextResponse.json({ poll })
  } catch (err) {
    // 703 refuses a closed poll, someone else's options, or two options on a one-choice poll (22023).
    if (err instanceof TeamChatError && err.code === 'bad_request') return badRequest('This poll is closed, or that isn’t one of its choices')
    return teamChatErrorResponse(err, 'vote')
  }
}
