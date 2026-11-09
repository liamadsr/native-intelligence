/**
 * /api/account/team-chat/dm (roadmap #7, migration 474)
 *   POST { memberId } → { id } the DM between the person and that member of
 *        the workspace (opened on first use; themselves: a note to self).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { openDm } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isUuid } from '@/lib/team-chat/types'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (!isUuid(body.memberId)) return badRequest('memberId must be a member id')
  try {
    const id = await openDm(auth.supabase, { workspaceId: auth.workspaceId, memberId: body.memberId })
    return NextResponse.json({ id })
  } catch (err) {
    return teamChatErrorResponse(err, 'dm open')
  }
}
