/**
 * /api/account/team-chat/channels/[id]/messages (roadmap #7, migration 474)
 *   GET  ?before=<created_at> → { messages } a page of the channel, oldest
 *        first (the newest page without `before`).
 *   POST { body, mentions?, mentionsAgent?, records? } → { message } posted
 *        as the person. `mentions` are member ids (anyone not in the
 *        workspace is dropped). `records` are the records it @-mentions
 *        ([{ type, id, label }], migration 480): kept while "@label" is in
 *        the words and the person may read the record, stored on the
 *        message and written to the graph as its `mentions` edges
 *        (src/lib/team-chat/record-mentions.ts); anything else is dropped.
 *        When the message calls on the person's own agent
 *        (`mentionsAgent`, or "@<their assistant name>" in the words), its
 *        turn is requested after the answer (src/lib/team-chat/agent-turn.ts):
 *        the reply arrives in the channel as their agent, live.
 * Reads and the post run as the person, under RLS; only the agent's turn
 * runs with the service role.
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { DEFAULT_ASSISTANT_NAME, sanitizeAssistantName } from '@/lib/voice/assistant-name'
import { getChannel, listMessages, postMessage, workspaceMemberIds } from '@/lib/team-chat/store'
import { deliverTeamChatMention } from '@/lib/team-chat/agent-turn'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { fenceRecordMentions, syncMessageMentions } from '@/lib/team-chat/record-mentions'
import { dmOtherMember, isUuid, mentionsAssistantName, tidyBody, tidyMentionIds } from '@/lib/team-chat/types'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  const before = request.nextUrl.searchParams.get('before') ?? undefined
  if (before !== undefined && Number.isNaN(Date.parse(before))) return badRequest('before must be a timestamp')
  try {
    const channel = await getChannel(auth.supabase, id)
    if (!channel || channel.workspace_id !== auth.workspaceId) return notFound()
    const messages = await listMessages(auth.supabase, id, { before })
    return NextResponse.json({ messages })
  } catch (err) {
    return teamChatErrorResponse(err, 'messages list')
  }
}

export async function POST(request: NextRequest, { params }: Params) {
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
  const body = tidyBody(input.body)
  if (!body) return badRequest('Write a message (up to 8,000 characters)')
  try {
    const channel = await getChannel(auth.supabase, id)
    if (!channel || channel.workspace_id !== auth.workspaceId) return notFound()
    const mentions = await workspaceMemberIds(auth.supabase, auth.workspaceId, tidyMentionIds(input.mentions))
    const agentName = sanitizeAssistantName(auth.user.user_metadata?.assistant_name) ?? DEFAULT_ASSISTANT_NAME
    // "@Joseph Lee" is a teammate, not an agent called Joseph: the name check skips a member's name.
    const { data: names } = await auth.supabase.from('member').select('display_name').eq('workspace_id', auth.workspaceId)
    const memberNames = ((names ?? []) as Array<{ display_name: string | null }>).map((m) => m.display_name)
    const mentionsAgent = input.mentionsAgent === true || mentionsAssistantName(body, agentName, memberNames)
    const scope = { workspaceId: auth.workspaceId, userId: auth.user.id }
    const recordMentions = await fenceRecordMentions(auth.supabase, scope, input.records, body)
    const message = await postMessage(auth.supabase, {
      workspaceId: auth.workspaceId,
      channelId: id,
      memberId: auth.member.id,
      body,
      mentions,
      mentionsAgent,
      recordMentions,
    })
    if (recordMentions.length > 0) {
      await syncMessageMentions(auth.supabase, { ...scope, messageId: message.id, memberId: auth.member.id, records: recordMentions })
    }
    if (mentionsAgent) {
      const userId = auth.user.id
      const memberId = auth.member.id
      after(async () => {
        try {
          const svc = getServiceClient()
          let dmWith: string | null = null
          const other = channel.kind === 'dm' ? dmOtherMember(channel.dm_key, memberId) : null
          if (other) {
            const { data } = await svc.from('member').select('display_name').eq('id', other).eq('workspace_id', channel.workspace_id).maybeSingle<{ display_name: string | null }>()
            dmWith = other === memberId ? 'yourself (a note to self)' : (data?.display_name ?? null)
          }
          const outcome = await deliverTeamChatMention(svc, { message, channel, userId, dmWith })
          console.info(`[team-chat] mention channel=${channel.id} message=${message.id} outcome=${outcome}`)
        } catch (err) {
          console.error(`[team-chat] mention channel=${channel.id} message=${message.id} failed:`, err instanceof Error ? err.message : 'unknown')
        }
      })
    }
    return NextResponse.json({ message }, { status: 201 })
  } catch (err) {
    return teamChatErrorResponse(err, 'message post')
  }
}
