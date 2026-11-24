/**
 * /api/account/team-chat/channels/[id] (migration 714, docs/plans/team-chat-manage.md)
 *   PATCH  { name?, topic? } → { channel: { id, kind, name, topic } } edit a
 *          channel's name or topic, or rename a meeting chat (its meeting
 *          too). A topic of '' or null clears it. A name another live channel
 *          has (ignoring case) is a 409 that says so.
 *   DELETE → { deleted: true, filesLeft } delete a channel or a meeting chat
 *          completely (its call notes stay, as their owner's own private
 *          capture). A 409 while its call is live; a DM is a 400.
 * Both run as the person (714's functions decide: a channel's creator, a
 * meeting's host, or the workspace's owner or admin; someone who can't read
 * it gets a 404). Only the delete's files are removed with the service role, after
 * the delete (src/lib/team-chat/manage.ts).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, conflict, forbidden, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { TeamChatError } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { deleteConversation, parseChannelEdit, updateChannel } from '@/lib/team-chat/manage'
import { isUuid } from '@/lib/team-chat/types'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('Invalid JSON body')
  const edit = parseChannelEdit(body)
  if (typeof edit === 'string') return badRequest(edit)
  try {
    const channel = await updateChannel(auth.supabase, id, edit)
    return NextResponse.json({ channel })
  } catch (err) {
    if (err instanceof TeamChatError) {
      if (err.code === 'conflict') return conflict(`There’s already a channel called #${edit.name ?? ''}. Pick another name.`, undefined, 'NAME_TAKEN')
      if (err.code === 'forbidden') return forbidden('Only the person who made it or a workspace admin can change it')
      if (err.code === 'bad_request') return badRequest('A direct message has no name to change')
    }
    return teamChatErrorResponse(err, 'channel edit')
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const { filesLeft } = await deleteConversation(auth.supabase, getServiceClient(), id)
    return NextResponse.json({ deleted: true, filesLeft })
  } catch (err) {
    if (err instanceof TeamChatError) {
      if (err.code === 'forbidden') return forbidden('Only the person who made it or a workspace admin can delete it')
      if (err.code === 'bad_request') return badRequest('A direct message can’t be deleted')
    }
    return teamChatErrorResponse(err, 'conversation delete')
  }
}
