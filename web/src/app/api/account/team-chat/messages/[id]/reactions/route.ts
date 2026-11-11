/**
 * /api/account/team-chat/messages/[id]/reactions (migration 557)
 *   POST { emoji, on } → { on } the person's reaction turned on or off (an
 *        explicit state, so a retry lands the same). Only on a message of a
 *        channel they may post in, never a deleted one; one emoji (never
 *        words). Everyone reading the channel sees it live.
 * Runs as the person, through 557's team_chat_react.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { react } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isReactionEmoji, isUuid } from '@/lib/team-chat/types'

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
  if (!isReactionEmoji(input.emoji)) return badRequest('A reaction is one emoji')
  if (typeof input.on !== 'boolean') return badRequest('on must be true or false')
  try {
    const on = await react(auth.supabase, id, input.emoji, input.on)
    return NextResponse.json({ on })
  } catch (err) {
    return teamChatErrorResponse(err, 'react')
  }
}
