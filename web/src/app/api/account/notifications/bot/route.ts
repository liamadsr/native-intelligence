/**
 * GET /api/account/notifications/bot?teammate=<id> — one bot's notices
 * (docs/plans/bots-v4.md Phase 4c, decision 8: a bot's notices live with the
 * bot, the Notices part of its bubble and of its page; use-bot-notices.ts).
 *
 * A notice is the bot's when its row names the teammate
 * (`metadata.teammate_id`, bot-notice.ts): the ones that aren't plain. Read
 * as the caller's member in the teammate's own workspace, whichever workspace
 * is on screen (a bot's page shows any workspace's bot), on the session client
 * (the notification's own SELECT policy: the recipient's rows only).
 *
 * Who may read it: the teammate must be visible to the caller under RLS, in a
 * workspace they're a member of, and reachable under the private-team rule
 * (resolveVisibleTeammate, callerCanReachTeammate: the roster's `reachable`).
 * Anything else is a 404, the same as no such teammate, so a private team's
 * bot never shows its notices to someone who can't reach it.
 *
 *   limit         how many, newest first (default NOTICES_LIMIT, at most
 *                 NOTICES_MAX: the page's "Show more" asks for more).
 *   unread_only   `1`: only the unread ones (the bubble's part lists those).
 *   except_items  work item ids (uuids, comma-separated, at most
 *                 EXCEPT_ITEMS_MAX) whose notices are left out of the list AND
 *                 the count: the bubble already lists those items, so its
 *                 "N more" counts only what it doesn't say.
 *
 * The answer: `teammate_id`, `workspace_id`, `notices` (newest first, ties by
 * id) and `unread`, how many of its notices are unread in all (the list's own
 * predicate: unread, not archived, none of `except_items`). A notice is read as
 * today: its item opened (the activity PATCH `opened`, markItemNoticesRead),
 * the notice itself clicked (PATCH /notifications/[id]), or all of the bot's at
 * once (POST /notifications/bot/mark-all-read).
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { BOT_NOTICE_TEAMMATE_PATH } from '@/lib/bots/bot-notice'
import { resolveVisibleTeammate, type VisibleTeammate } from '@/lib/chat/teammate-chat'
import { noticeTeammateIds } from '@/lib/bots/agent-notices-server'
import { BOT_NOTICE_COLUMNS, asBotNotice } from '../bot-notices'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** How many a read returns when it doesn't say. */
const NOTICES_LIMIT = 20
/** The most a read returns. */
const NOTICES_MAX = 200
/** At most this many work items are left out (the bubble lists at most a dozen new and five seen). */
const EXCEPT_ITEMS_MAX = 30
/** Where a notice names its run (bot-notice.ts `work_item_id`). */
const WORK_ITEM_PATH = 'metadata->>work_item_id'

export async function GET(request: Request) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const params = new URL(request.url).searchParams

  const teammateId = params.get('teammate') ?? ''
  if (!UUID.test(teammateId)) return badRequest('teammate must be a teammate id')
  const asked = Number.parseInt(params.get('limit') ?? '', 10)
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, NOTICES_MAX) : NOTICES_LIMIT
  const unreadOnly = params.get('unread_only') === '1'
  const exceptRaw = (params.get('except_items') ?? '').split(',').filter(Boolean)
  if (exceptRaw.length > EXCEPT_ITEMS_MAX || !exceptRaw.every((id) => UUID.test(id))) {
    return badRequest(`except_items must be at most ${EXCEPT_ITEMS_MAX} work item ids`)
  }
  // A notice about none of them (one that names no run is never left out).
  const except = <Q extends { or: (filters: string) => Q }>(query: Q): Q =>
    exceptRaw.length === 0 ? query : query.or(`${WORK_ITEM_PATH}.is.null,${WORK_ITEM_PATH}.not.in.(${exceptRaw.join(',')})`)

  let mate: VisibleTeammate | null
  try {
    mate = await resolveVisibleTeammate(supabase, user.id, teammateId)
  } catch (err) {
    console.error('[notifications/bot] teammate check failed:', err instanceof Error ? err.message : err)
    return serverError('Could not read the teammate')
  }
  // Hidden by RLS, in a workspace the caller isn't in, or on a private team
  // they aren't on: one answer for all three, the same as no such teammate.
  if (!mate) return notFound('Teammate not found')
  // The agent's notices cover its workspace's area faces too (one face).
  const ids = await noticeTeammateIds(supabase, mate)

  let list = except(
    supabase
      .from('notification')
      .select(BOT_NOTICE_COLUMNS)
      .eq('recipient_id', mate.memberId)
      .eq('is_archived', false)
      .in(BOT_NOTICE_TEAMMATE_PATH, ids),
  )
  if (unreadOnly) list = list.eq('is_read', false)
  const unread = except(
    supabase
      .from('notification')
      .select('id', { count: 'exact', head: true })
      .eq('recipient_id', mate.memberId)
      .eq('is_read', false)
      .eq('is_archived', false)
      .in(BOT_NOTICE_TEAMMATE_PATH, ids),
  )

  const [listed, counted] = await Promise.all([
    list.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit),
    unread,
  ])
  if (listed.error || counted.error) {
    console.error('[notifications/bot] read failed:', (listed.error ?? counted.error)?.message)
    return serverError('Could not read the notices')
  }

  return NextResponse.json({
    teammate_id: mate.id,
    workspace_id: mate.workspaceId,
    notices: ((listed.data ?? []) as unknown as Array<Record<string, unknown>>).map(asBotNotice),
    unread: counted.count ?? 0,
  })
}
