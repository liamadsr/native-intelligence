/**
 * /api/account/support-chat/[id] (migration 715)
 *   DELETE → { ok: true } the person deletes their own support conversation,
 *            completely and for both sides: it, its messages and everyone's
 *            notifications about it go (715's support_chat_remove, which
 *            checks it is theirs), and their files in it are removed from
 *            storage. Nothing starts another by itself; an admin can.
 *            404 for anything that isn't the person's own.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { removeFiles } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isUuid } from '@/lib/team-chat/types'
import { removeSupportConversation } from '@/lib/support-chat/store'

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const paths = await removeSupportConversation(auth.supabase, id)
    if (paths === null) return notFound()
    // Their own uploads only (558's policy); our side sends no files.
    await removeFiles(auth.supabase, paths)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return teamChatErrorResponse(err, 'support delete')
  }
}
