/**
 * /api/account/team-chat/channels/[id]/polls (migration 703)
 *   POST { question, options[], multiple?, anonymous?, closes_at?, thread_root_id?, client_id? }
 *        → 201 { message, poll } a poll posted into the channel (or a thread
 *        of it) as the person: its message ("Poll: <question>") and the poll
 *        behind it. Checked here (src/lib/team-chat/polls.ts planPoll) and
 *        again by 703's team_chat_poll_create, which also holds that they
 *        may post here. The message notifies like any other (Signal and
 *        Noise apply). A retry with the same client_id answers the first.
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { getChannel, getMessage } from '@/lib/team-chat/store'
import { createPoll, readPoll } from '@/lib/team-chat/poll-store'
import { planPoll } from '@/lib/team-chat/polls'
import { requestTeamChatNotify } from '@/lib/team-chat/notify'
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
  const plan = planPoll(input)
  if (!plan.ok) return badRequest(plan.error)
  const threadRootId = input.thread_root_id ?? null
  if (threadRootId !== null && !isUuid(threadRootId)) return badRequest('thread_root_id must be a message id')
  const clientId = input.client_id ?? null
  if (clientId !== null && !isUuid(clientId)) return badRequest('client_id must be a uuid')
  try {
    const channel = await getChannel(auth.supabase, id)
    if (!channel || channel.workspace_id !== auth.workspaceId) return notFound()
    const { messageId, pollId } = await createPoll(auth.supabase, { channelId: id, draft: plan.draft, threadRootId, clientId })
    const [message, poll] = await Promise.all([getMessage(auth.supabase, messageId), readPoll(auth.supabase, pollId)])
    if (!message || !poll) return notFound()
    // Its notifications, as any message's (the event's id is the message's: a retry asks once).
    after(() => requestTeamChatNotify(message.id))
    return NextResponse.json({ message, poll }, { status: 201 })
  } catch (err) {
    return teamChatErrorResponse(err, 'poll create')
  }
}
