/**
 * /api/account/team-chat/messages/[id] (roadmap #7, migration 474): the
 * person's own messages only (RLS and 474's guard hold it to the author).
 *   PATCH { body, mentions? } → { message } edited (edited_at stamped). An
 *         edit never calls the agent again.
 *   DELETE → { ok: true } deleted (soft: its words are cleared for everyone).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { deleteMessage, editMessage, workspaceMemberIds } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isUuid, tidyBody, tidyMentionIds } from '@/lib/team-chat/types'

type Params = { params: Promise<{ id: string }> }

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
    const message = await editMessage(auth.supabase, id, { body, mentions })
    if (!message) return notFound()
    return NextResponse.json({ message })
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
    return NextResponse.json({ ok: true })
  } catch (err) {
    return teamChatErrorResponse(err, 'message delete')
  }
}
