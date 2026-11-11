/**
 * /api/account/team-chat/channels/[id]/read (roadmap #7, migration 474)
 *   POST → { ok: true } the channel read up to now for the person, and its
 *          notifications with it (migration 560: the banners and the chat
 *          agree). An email waiting to tell them about it is cancelled
 *          (src/lib/team-chat/email.ts).
 */
import { after, NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { markRead } from '@/lib/team-chat/store'
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
    const groupKey = teamChatGroupKey({ channel_id: id, thread_root_id: null })
    // Read before the mark clears them: only a conversation with something unread has an email to cancel.
    const hadUnread = await hasUnreadTeamChatNotices(auth.supabase, { memberId: auth.member.id, groupKey })
    await markRead(auth.supabase, id)
    if (hadUnread) after(() => sendTeamChatRead({ userId: auth.user.id, groupKey }))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return teamChatErrorResponse(err, 'mark read')
  }
}
