/**
 * /api/account/team-chat/threads/[id]/read (migration 556)
 *   POST → { ok: true } the thread (its root message's id) read up to now for
 *          the person. Reading a thread they aren't in changes nothing of
 *          the thread's; its notifications are read either way (migration
 *          560), and an email waiting to tell them about it is cancelled
 *          (src/lib/team-chat/email.ts).
 */
import { after, NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { markThreadRead } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { hasUnreadTeamChatNotices, sendTeamChatRead } from '@/lib/team-chat/email'
import { teamChatGroupKey } from '@/lib/team-chat/notify'
import { isUuid } from '@/lib/team-chat/types'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    // A thread's key is its root's (the channel isn't part of it).
    const groupKey = teamChatGroupKey({ channel_id: '', thread_root_id: id })
    const hadUnread = await hasUnreadTeamChatNotices(auth.supabase, { memberId: auth.member.id, groupKey })
    await markThreadRead(auth.supabase, id)
    if (hadUnread) after(() => sendTeamChatRead({ userId: auth.user.id, groupKey }))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return teamChatErrorResponse(err, 'mark thread read')
  }
}
