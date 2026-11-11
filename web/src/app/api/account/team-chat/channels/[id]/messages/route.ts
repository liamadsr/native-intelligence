/**
 * /api/account/team-chat/channels/[id]/messages (roadmap #7, migration 474)
 *   GET  ?before=<created_at> → { messages, threads, reactions, calls } a
 *        page of the channel's own messages (never a thread's replies),
 *        oldest first (the newest page without `before`), with the
 *        summaries of the threads under them, their reactions (migrations
 *        556, 557), and the calls a call's message shows, with who is in
 *        them (564).
 *   GET  ?around=<message id> → { messages, threads, reactions, calls,
 *        hasOlder, hasNewer } the page around one of the channel's own
 *        messages (a search hit, a notification, a link opened on an older
 *        message): a few before it, and on from it to the newest when that
 *        fits (hasNewer false: the page runs on unbroken to now), else as
 *        many after it as a page holds (hasNewer true: the view shows that
 *        page alone, with a way to the newest).
 *   GET  ?thread=<root id> → { messages, reactions } that thread's replies,
 *        oldest first, and their reactions.
 *   POST { body, mentions?, mentionsAgent?, records?, thread?, attachments?,
 *        clientId? } → { message } posted as the person. `mentions` are
 *        member ids (anyone not in the workspace is dropped). `records` are
 *        the records it @-mentions ([{ type, id, label }], migration 480):
 *        kept while "@label" is in the words and the person may read the
 *        record, stored on the message and written to the graph as its
 *        `mentions` edges (src/lib/team-chat/record-mentions.ts); anything
 *        else is dropped.
 *        A record the channel's readers can't all see (another member's
 *        private doc, say) is shared with the channel when the person may
 *        share it (src/lib/entity-access/share.ts, migration 492): the
 *        answer's `shared` lists the grants made (each one's id is what
 *        Undo deletes) and `shared_with` says who they reach ("#launch").
 *        `share: true` marks a post made by the Share to a channel action
 *        (its grants' source).
 *        `thread` (migration 556): a message of the thread it replies in
 *        (the database files it under the thread's root). `attachments`
 *        (555): the person's own uploads in this channel's folder of the
 *        team-chat-files bucket (src/lib/team-chat/files.ts), each checked
 *        against storage (its size is storage's, never the client's); with
 *        files, the words may be empty. `clientId`: the uuid the page minted
 *        for this send. A retry with the same one answers 200 with the
 *        message the first try made (`replayed`), and finishes what that try
 *        may not have (its mention edges, its shares, the agent's turn, the
 *        preview), none of it twice.
 *        When the message calls on the person's own agent
 *        (`mentionsAgent`, or "@<their assistant name>" in the words), its
 *        turn is requested after the answer (src/lib/team-chat/agent-turn.ts):
 *        the reply arrives in the channel (or the thread) as their agent,
 *        live. A message with a link asks for its preview after the answer
 *        (src/lib/team-chat/link-preview.ts): it arrives live too. Every
 *        message asks for its notifications after the answer
 *        (src/lib/team-chat/notify.ts, migration 560): the DM, the people it
 *        mentions, the thread's people, whoever set the channel to all.
 * Reads and the post run as the person, under RLS; only the agent's turn
 * and the link preview run with the service role.
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { DEFAULT_ASSISTANT_NAME, sanitizeAssistantName } from '@/lib/voice/assistant-name'
import {
  attachmentsFromStorage,
  getChannel,
  getMessage,
  listMessages,
  listMessagesAround,
  listThread,
  messageReactions,
  postMessage,
  threadSummaries,
  workspaceMemberIds,
} from '@/lib/team-chat/store'
import { deliverTeamChatMention } from '@/lib/team-chat/agent-turn'
import { firstLink, requestLinkPreview } from '@/lib/team-chat/link-preview'
import { requestTeamChatNotify } from '@/lib/team-chat/notify'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { callViews } from '@/lib/team-calls/store'
import { fenceRecordMentions, syncMessageMentions } from '@/lib/team-chat/record-mentions'
import { tidyAttachments } from '@/lib/team-chat/files'
import { shareMentionedRecords } from '@/lib/entity-access/share'
import { dmOtherMember, isUuid, mentionsAssistantName, tidyBody, tidyMentionIds, TEAM_CHAT_MESSAGE_MAX } from '@/lib/team-chat/types'

type Params = { params: Promise<{ id: string }> }

/** The calls a page's call messages show (migration 564). */
function callIdsOf(messages: ReadonlyArray<{ kind?: string; call_id?: string | null }>): string[] {
  return messages.flatMap((m) => (m.kind === 'call' && m.call_id ? [m.call_id] : []))
}

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  const before = request.nextUrl.searchParams.get('before') ?? undefined
  if (before !== undefined && Number.isNaN(Date.parse(before))) return badRequest('before must be a timestamp')
  const around = request.nextUrl.searchParams.get('around')
  if (around !== null && !isUuid(around)) return badRequest('around must be a message id')
  const thread = request.nextUrl.searchParams.get('thread')
  if (thread !== null && !isUuid(thread)) return badRequest('thread must be a message id')
  try {
    const channel = await getChannel(auth.supabase, id)
    if (!channel || channel.workspace_id !== auth.workspaceId) return notFound()
    if (thread) {
      const root = await getMessage(auth.supabase, thread)
      if (!root || root.channel_id !== id || root.thread_root_id) return notFound()
      const messages = await listThread(auth.supabase, thread)
      const reactions = await messageReactions(auth.supabase, [root.id, ...messages.map((m) => m.id)])
      return NextResponse.json({ root, messages, reactions })
    }
    if (around) {
      const page = await listMessagesAround(auth.supabase, id, around)
      if (!page) return notFound()
      const ids = page.messages.map((m) => m.id)
      const [threads, reactions, calls] = await Promise.all([
        threadSummaries(auth.supabase, ids),
        messageReactions(auth.supabase, ids),
        callViews(auth.supabase, callIdsOf(page.messages)),
      ])
      return NextResponse.json({ ...page, threads, reactions, calls })
    }
    const messages = await listMessages(auth.supabase, id, { before })
    const ids = messages.map((m) => m.id)
    const [threads, reactions, calls] = await Promise.all([
      threadSummaries(auth.supabase, ids),
      messageReactions(auth.supabase, ids),
      callViews(auth.supabase, callIdsOf(messages)),
    ])
    return NextResponse.json({ messages, threads, reactions, calls })
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
  const files = tidyAttachments(input.attachments, { channelId: id, userId: auth.user.id })
  if (Array.isArray(input.attachments) && input.attachments.length > files.length) return badRequest('A file isn’t one of yours in this channel')
  const typed = typeof input.body === 'string' ? input.body.trim() : ''
  // Files alone are a message; words, when there are any, are held to their cap.
  const body = typed ? tidyBody(input.body) : files.length > 0 ? '' : null
  if (body === null) return badRequest(`Write a message (up to ${TEAM_CHAT_MESSAGE_MAX.toLocaleString('en-US')} characters)`)
  const threadRootId = input.thread == null ? null : input.thread
  if (threadRootId !== null && !isUuid(threadRootId)) return badRequest('thread must be a message id')
  const clientId = input.clientId == null ? null : input.clientId
  if (clientId !== null && !isUuid(clientId)) return badRequest('clientId must be a uuid')
  try {
    const channel = await getChannel(auth.supabase, id)
    if (!channel || channel.workspace_id !== auth.workspaceId) return notFound()
    const attachments = await attachmentsFromStorage(auth.supabase, files)
    if (attachments.length < files.length) return badRequest('A file didn’t finish uploading. Try attaching it again.')
    const mentions = await workspaceMemberIds(auth.supabase, auth.workspaceId, tidyMentionIds(input.mentions))
    const agentName = sanitizeAssistantName(auth.user.user_metadata?.assistant_name) ?? DEFAULT_ASSISTANT_NAME
    // "@Joseph Lee" is a teammate, not an agent called Joseph: the name check skips a member's name.
    const { data: names } = await auth.supabase.from('member').select('display_name').eq('workspace_id', auth.workspaceId)
    const memberNames = ((names ?? []) as Array<{ display_name: string | null }>).map((m) => m.display_name)
    const mentionsAgent = !!body && (input.mentionsAgent === true || mentionsAssistantName(body, agentName, memberNames))
    const scope = { workspaceId: auth.workspaceId, userId: auth.user.id }
    const recordMentions = await fenceRecordMentions(auth.supabase, scope, input.records, body)
    const { message, replayed } = await postMessage(auth.supabase, {
      workspaceId: auth.workspaceId,
      channelId: id,
      memberId: auth.member.id,
      body,
      mentions,
      mentionsAgent,
      recordMentions,
      threadRootId: threadRootId as string | null,
      attachments,
      clientId: clientId as string | null,
    })
    // Everything after the insert runs again on a retry of a send that went
    // through (`replayed`): the first try may have stored the message and
    // failed before these. Each is keyed by the message and safe to run twice:
    // the mention edges are synced to the stored list; a record the channel
    // already has a grant for isn't granted again; the agent's turn and the
    // preview are events whose ids are the message's, so a second send of
    // either is dropped. They read what was stored, never this request's body.
    const stored = message.record_mentions ?? []
    if (stored.length > 0) {
      await syncMessageMentions(auth.supabase, { ...scope, messageId: message.id, memberId: auth.member.id, records: stored })
    }
    const { shared, shared_with } = await shareMentionedRecords(auth.supabase, {
      ...scope,
      memberId: auth.member.id,
      channel,
      records: stored,
      source: input.share === true ? 'channel_share' : 'mention',
    })
    if (firstLink(message.body)) after(() => requestLinkPreview(message))
    if (message.mentions_agent) {
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
    // Its notifications, last (the event's id is the message's: a replay asks once).
    after(() => requestTeamChatNotify(message.id))
    if (replayed) return NextResponse.json({ message, shared, shared_with, replayed: true })
    return NextResponse.json({ message, shared, shared_with }, { status: 201 })
  } catch (err) {
    return teamChatErrorResponse(err, 'message post')
  }
}
