/**
 * /api/account/team-chat/channels/[id]/notify (migration 560)
 *   POST { level: 'all' | 'mentions' | 'muted' | null } → { notify } how loud
 *        the channel is for the person: every message notifies, only
 *        mentions (a channel's default), or nothing (muted: no unread count
 *        either; a mention still shows its badge). null puts the default back
 *        (a DM's is every message). Answers the level now in effect.
 * Runs as the person (560's team_chat_set_notify: a channel they may read).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { setNotifyLevel } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isTeamChatNotifyLevel } from '@/lib/team-chat/notify'
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
  const level = input.level ?? null
  if (level !== null && !isTeamChatNotifyLevel(level)) return badRequest('level must be all, mentions or muted')
  try {
    const notify = await setNotifyLevel(auth.supabase, id, level)
    return NextResponse.json({ notify })
  } catch (err) {
    return teamChatErrorResponse(err, 'notify level')
  }
}
