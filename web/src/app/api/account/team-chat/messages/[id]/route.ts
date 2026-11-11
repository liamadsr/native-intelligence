/**
 * /api/account/team-chat/messages/[id] (roadmap #7, migration 474).
 *   GET   → { message, root } one message the person may read (RLS), and the
 *         root of the thread it is a reply in (null for a message in the
 *         channel itself): where a search hit or a notification opens
 *         (migrations 560, 561). 404 for one they may not read, or deleted.
 * Edit and delete: the person's own messages only (RLS and 474's guard hold
 * it to the author).
 *   PATCH { body, mentions?, records? } → { message } edited (edited_at
 *         stamped). An edit never calls the agent again. Never their agent's
 *         reply. `records` as on a post; the message's `mentions` edges
 *         follow the edit (added and removed). No `records` (a client from
 *         before 480): it keeps the ones it had that the words still name.
 *         A record the edit newly mentions is shared with the channel as on
 *         a post (`shared`, `shared_with`; src/lib/entity-access/share.ts).
 *         An edit asks for the link preview again after the answer (the words'
 *         first link may have changed: src/lib/team-chat/link-preview.ts).
 *   DELETE → { ok: true } deleted (soft: its words, files and link preview
 *         are cleared for everyone): their own message, or their own agent's
 *         reply. Its `mentions` edges are removed, its files (the
 *         person's own uploads) removed from storage, and its notifications
 *         go (migration 560: nobody is told, or emailed, about words that
 *         are gone).
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { deleteMessage, editMessage, getChannel, getMessage, removeFiles, workspaceMemberIds } from '@/lib/team-chat/store'
import { removeTeamChatNotifications } from '@/lib/team-chat/notify'
import { requestLinkPreview } from '@/lib/team-chat/link-preview'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { fenceRecordMentions, storedRecordMentions, syncMessageMentions } from '@/lib/team-chat/record-mentions'
import { shareMentionedRecords } from '@/lib/entity-access/share'
import { isUuid, tidyBody, tidyMentionIds } from '@/lib/team-chat/types'
import { mentionKey, tidyLabeledMentionRefs } from '@/lib/entity-links/mentionable'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const message = await getMessage(auth.supabase, id)
    if (!message || message.deleted_at) return notFound()
    // This workspace's only (RLS reads every workspace the person is in).
    const channel = await getChannel(auth.supabase, message.channel_id)
    if (!channel || channel.workspace_id !== auth.workspaceId) return notFound()
    const root = message.thread_root_id ? await getMessage(auth.supabase, message.thread_root_id) : null
    return NextResponse.json({ message, root })
  } catch (err) {
    return teamChatErrorResponse(err, 'message read')
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
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
    const mentions = await workspaceMemberIds(auth.supabase, auth.workspaceId, tidyMentionIds(input.mentions))
    const scope = { workspaceId: auth.workspaceId, userId: auth.user.id }
    // A client from before 480 sends no `records`: the message keeps the ones
    // it had that its words still name (never wiped by an older tab's edit).
    const records = input.records !== undefined ? input.records : await storedRecordMentions(auth.supabase, id)
    const recordMentions = await fenceRecordMentions(auth.supabase, scope, records, body)
    // What it mentioned before the edit: only a NEW mention shares (an Undo stays undone across edits).
    const before = recordMentions.length > 0 ? tidyLabeledMentionRefs(await storedRecordMentions(auth.supabase, id)) : []
    const message = await editMessage(auth.supabase, id, { body, mentions, recordMentions })
    if (!message) return notFound()
    // A link added, changed or taken out: its preview follows (requestLinkPreview asks only then).
    if (message.link_preview || /https?:\/\//i.test(message.body)) after(() => requestLinkPreview(message))
    // The edges follow the edit: new mentions added, the ones taken out removed.
    await syncMessageMentions(auth.supabase, { ...scope, messageId: message.id, memberId: auth.member.id, records: recordMentions })
    const had = new Set(before.map(mentionKey))
    const added = recordMentions.filter((r) => !had.has(mentionKey(r)))
    // Sharing reads the channel only when the edit adds a record (most edits don't).
    const channel = added.length > 0 ? await getChannel(auth.supabase, message.channel_id) : null
    const { shared, shared_with } =
      channel && channel.workspace_id === auth.workspaceId
        ? await shareMentionedRecords(auth.supabase, { ...scope, memberId: auth.member.id, channel, records: added, source: 'mention' })
        : { shared: [], shared_with: null }
    return NextResponse.json({ message, shared, shared_with })
  } catch (err) {
    return teamChatErrorResponse(err, 'message edit')
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const deleted = await deleteMessage(auth.supabase, id)
    if (!deleted) return notFound()
    // Its files go with it (558's policy lets the person remove only their own uploads).
    await removeFiles(auth.supabase, deleted.paths)
    // And everyone's notifications of it (others' rows: the service role, for this message only).
    after(() => removeTeamChatNotifications(getServiceClient(), id))
    // A deleted message mentions nothing (the guard cleared its words): its edges go too.
    await syncMessageMentions(auth.supabase, {
      workspaceId: auth.workspaceId,
      messageId: id,
      userId: auth.user.id,
      memberId: auth.member.id,
      records: [],
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return teamChatErrorResponse(err, 'message delete')
  }
}
