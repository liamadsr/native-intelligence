/**
 * /api/account/team-chat/channels/[id]/snooze (migration 702)
 *   POST { until: ISO time | null } → { muted_until } mute the channel for the
 *        person until then (in the future, 31 days at most), or end a
 *        snooze now (null). While it lasts nothing about the channel notifies
 *        them, mentions included; its unread count keeps counting.
 * Runs as the person (702's team_chat_snooze: a channel they may read).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { setSnooze } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { snoozeUntilError } from '@/lib/team-chat/snooze'
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
  const until = input.until ?? null
  if (until !== null) {
    const why = snoozeUntilError(until)
    if (why) return badRequest(why)
  }
  try {
    const muted_until = await setSnooze(auth.supabase, id, until === null ? null : new Date(until as string).toISOString())
    return NextResponse.json({ muted_until })
  } catch (err) {
    return teamChatErrorResponse(err, 'snooze')
  }
}
