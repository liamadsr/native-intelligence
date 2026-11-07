/**
 * POST /api/account/notifications/bot/mark-all-read { teammate: <id> } — every
 * unread notice of one bot read, for the caller only (bots-v4 Phase 4c, Liam
 * on #653: the bot page's Notices card has "Mark all read").
 *
 * The caller's own notices (their member in the teammate's workspace, the
 * notification's own UPDATE policy besides) that name that teammate, unread
 * and not archived. The teammate must be one the caller can reach
 * (resolveVisibleTeammate: visible under RLS, a member of its workspace, the
 * private-team rule), else a 404, as GET /notifications/bot answers; a bad id
 * is a 400. Nothing else is touched: the plain notices, another bot's, anyone
 * else's. The agent's (the workspace's Assistant: one face) covers its
 * workspace's area faces' notices too (agent-notices-server.ts). Answers `{ success, read }`, how many it read. The realtime UPDATEs
 * reach every window holding them (their banners leave Notification Center).
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { BOT_NOTICE_TEAMMATE_PATH } from '@/lib/bots/bot-notice'
import { resolveVisibleTeammate, type VisibleTeammate } from '@/lib/chat/teammate-chat'
import { noticeTeammateIds } from '@/lib/bots/agent-notices-server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  let body: { teammate?: unknown }
  try {
    body = (await request.json()) as { teammate?: unknown }
  } catch {
    return badRequest('Invalid JSON body')
  }
  const teammateId = typeof body?.teammate === 'string' ? body.teammate : ''
  if (!UUID.test(teammateId)) return badRequest('teammate must be a teammate id')

  let mate: VisibleTeammate | null
  try {
    mate = await resolveVisibleTeammate(supabase, user.id, teammateId)
  } catch (err) {
    console.error('[notifications/bot] teammate check failed:', err instanceof Error ? err.message : err)
    return serverError('Could not read the teammate')
  }
  if (!mate) return notFound('Teammate not found')
  // The agent's notices cover its workspace's area faces too (one face).
  const ids = await noticeTeammateIds(supabase, mate)

  const { data, error } = await supabase
    .from('notification')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('recipient_id', mate.memberId)
    .eq('is_read', false)
    .eq('is_archived', false)
    .in(BOT_NOTICE_TEAMMATE_PATH, ids)
    .select('id')
  if (error) {
    console.error('[notifications/bot] mark all read failed:', error.message)
    return serverError('Could not mark the notices read')
  }
  return NextResponse.json({ success: true, read: Array.isArray(data) ? data.length : 0 })
}
