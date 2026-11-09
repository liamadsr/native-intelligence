/**
 * /api/account/team-chat/channels/[id]/read (roadmap #7, migration 474)
 *   POST → { ok: true } the channel read up to now for the person.
 */
import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { markRead } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isUuid } from '@/lib/team-chat/types'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    await markRead(auth.supabase, id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return teamChatErrorResponse(err, 'mark read')
  }
}
