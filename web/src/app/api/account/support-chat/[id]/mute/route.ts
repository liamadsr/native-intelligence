/**
 * /api/account/support-chat/[id]/mute (migration 715)
 *   POST { muted } → { muted } our support staff mute (or unmute) one
 *        customer's support conversation for themselves: no notification
 *        about it, and no unread count in their list. 403 for anyone who isn't
 *        on the support team (715's support_chat_mute checks).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isUuid } from '@/lib/team-chat/types'
import { isSupportStaffUser } from '@/lib/support-chat/staff'
import { setSupportMuted } from '@/lib/support-chat/store'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id) || !isSupportStaffUser(auth.user)) return notFound()
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (typeof input.muted !== 'boolean') return badRequest('muted must be true or false')
  try {
    return NextResponse.json({ muted: await setSupportMuted(auth.supabase, id, input.muted) })
  } catch (err) {
    return teamChatErrorResponse(err, 'support mute')
  }
}
