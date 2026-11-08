/**
 * GET /api/account/notifications — the notices the shell holds.
 *
 * No list draws them any more: the notifications page (the bell's Inbox) went,
 * and every notice reaches the agent as an event
 * (docs/plans/retire-notifications-page.md). The shell still holds the newest
 * page for their banners (taken down once read) and for an item opened again
 * to read its late notice. The rows are the plain notices: from people,
 * clocks and Native Intelligence itself (bots-v4 Phase 4c, decision 8). A notice whose row
 * names a teammate (`metadata.teammate_id`, bot-notice.ts) that the caller
 * can reach is its bot's and lives with the bot (its bubble's and its page's
 * Notices, GET /notifications/bot). One whose teammate the caller can't reach
 * (deleted, hidden, behind a private team they aren't on) is an orphan and is
 * a plain notice (notice-reach.ts: the roster's reach rule, read in a batch).
 *
 * `include_bots=1` (the shell asks it with its first page): the answer also
 * carries `bot_notifications`, the bots' newest BOT_NOTICES_HELD notices in the
 * same scope plus every unread one (at most BOT_UNREAD_HELD), which nothing
 * draws as a list (the peeks read their sentences, an item opened again reads
 * its late notice, an unread failed run lights its bot's dot, and the desktop
 * overlay's bubble lists the unread ones), and the teammates the notices name,
 * split as this route split them (`bot_teammate_ids` reachable,
 * `orphan_teammate_ids` not), so the window sorts a notice realtime brings the
 * way this route does. Fail-soft: a failed read of them is none, never a
 * failed bell.
 *
 * The filter names the orphans only (a short list: notice-reach.ts), never
 * every reachable teammate, so the URL stays short in the `all` scope too.
 */
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceIdOrResponse } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'
import { botNotices, noticeTeammateReach, plainNotices } from '@/lib/bots/notice-reach'
import { BOT_NOTICES_HELD, BOT_NOTICE_COLUMNS, BOT_UNREAD_HELD, asBotNotice } from './bot-notices'
import {
  parseWorkspaceScope,
  resolveMemberships,
  WORKSPACE_SCOPE_PARAM,
  type UserMembership,
} from './scope'

/**
 * The row the inbox has always read. Unchanged, and deliberately so: the
 * default scope must emit the query it emitted before cross-workspace existed,
 * select string included.
 */
const NOTIFICATION_SELECT = `
      id, workspace_id, recipient_id, type, title, body, actor_id,
      target_type, target_id, context_type, context_id,
      is_read, read_at, is_archived, group_key, metadata, created_at,
      actor:member!actor_id(id, display_name, avatar_url)
    `

/**
 * The same row plus the workspace it belongs to, for the `all` scope only.
 *
 * CONDITIONAL, unlike the views query engine's unconditional workspace embed —
 * and for a reason specific to this list. A single-workspace notification list
 * is, by construction, entirely the active workspace: the client would compute
 * `workspace.id !== currentId` as false on every row and draw nothing. So the
 * join would buy the default path exactly nothing while adding a join to the
 * one query the shell fires on every dashboard load.
 *
 * `workspace_id` names the FK as the disambiguating hint, the same form the
 * sibling `actor:member!actor_id` embed above uses (`notification.workspace_id
 * REFERENCES workspace(id)`, migration 031). Row-sized on purpose — the badge
 * needs a name, a logo and a slug, not the settings blob.
 *
 * Readable across the whole scope without widening anything: `workspace`'s
 * SELECT policy is `is_workspace_member(id)` (migration 013), which is the same
 * membership the notifications themselves are gated on.
 */
/**
 * The shape this handler READS off a fetched row. Everything else on the row is
 * passed straight through by the spread below and never named here.
 *
 * Hand-written because the select string is now chosen at runtime (see
 * `listSelect`), which costs supabase-js the literal-driven row inference it
 * does when the string is a constant. The embeds were already being cast by
 * hand for the same reason, so this only makes the existing practice explicit.
 */
type NotificationRow = {
  target_type: string | null
  target_id: string | null
  context_type: string | null
  context_id: string | null
  actor?: unknown
  workspace?: unknown
} & Record<string, unknown>

const NOTIFICATION_SELECT_ALL = `
      id, workspace_id, recipient_id, type, title, body, actor_id,
      target_type, target_id, context_type, context_id,
      is_read, read_at, is_archived, group_key, metadata, created_at,
      actor:member!actor_id(id, display_name, avatar_url),
      workspace:workspace!workspace_id(id, name, slug, logo_url)
    `

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = request.nextUrl
  const scope = parseWorkspaceScope(searchParams.get(WORKSPACE_SCOPE_PARAM))
  if (scope instanceof Response) return scope
  const includeBots = searchParams.get('include_bots') === '1'

  // The recipient ids this request reads. One member row in the default scope
  // (resolved exactly as before — active workspace, 403 if not a member), the
  // whole server-resolved membership set in `all`.
  let recipientIds: string[]
  let memberships: UserMembership[] = []

  if (scope === 'all') {
    const resolved = await resolveMemberships(supabase, user.id)
    if (resolved instanceof Response) return resolved
    memberships = resolved
    recipientIds = memberships.map((m) => m.memberId)
    // No memberships at all: there is nothing to read and `in.()` on an empty
    // list is a degenerate filter, so answer directly. Shaped like a normal
    // empty page so the client needs no special case.
    if (recipientIds.length === 0) {
      return NextResponse.json({
        notifications: [],
        memberships,
        ...(includeBots ? { bot_notifications: [], orphan_teammate_ids: [], bot_teammate_ids: [] } : {}),
      })
    }
  } else {
    const workspaceId = await getCurrentWorkspaceIdOrResponse()
    if (workspaceId instanceof Response) return workspaceId
    if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

    const { data: member } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .single()
    if (!member) return NextResponse.json({ error: 'Not a member' }, { status: 403 })
    recipientIds = [member.id]
  }

  // One page, the newest: the shell holds it for banners and late reads, and
  // nothing pages further (no list draws these any more).
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100)

  // The recipient predicate is the ONLY thing the scope changes: `eq` on the one
  // member id, or `in` over the set. Everything downstream of it — the archived
  // filter, the ordering, the limit — is untouched and stays in the same
  // position in the chain.
  // Widened to `string` on purpose: supabase-js parses a select LITERAL into the
  // row type, and it cannot parse a union of two literals — so the scope choice
  // is made behind a `string` and the rows are shaped by hand below, exactly as
  // the `actor` embed already was.
  const listSelect: string = scope === 'all' ? NOTIFICATION_SELECT_ALL : NOTIFICATION_SELECT
  // The bots the caller can't reach, whose notices are plain ones (Phase 4c).
  const reach = await noticeTeammateReach(supabase, { userId: user.id, recipientIds })
  const orphans = reach.orphans
  const listBase = supabase.from('notification').select(listSelect)

  const query = plainNotices(
    (scope === 'all'
      ? listBase.in('recipient_id', recipientIds)
      : listBase.eq('recipient_id', recipientIds[0])
    ).eq('is_archived', false),
    // The plain notices only: a reachable bot's live with the bot (Phase 4c).
    orphans,
  )
    .order('created_at', { ascending: false })
    .limit(limit)

  // The bots' notices, for the shell to hold (see the module note): the newest,
  // and every unread one.
  const botRead = (unread: boolean) => {
    const base = supabase.from('notification').select(BOT_NOTICE_COLUMNS)
    const mine = botNotices(
      (scope === 'all' ? base.in('recipient_id', recipientIds) : base.eq('recipient_id', recipientIds[0])).eq('is_archived', false),
      orphans,
    )
    return (unread ? mine.eq('is_read', false) : mine)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(unread ? BOT_UNREAD_HELD : BOT_NOTICES_HELD)
  }

  const [{ data: notifications, error }, bots, botsUnread] = await Promise.all([
    query,
    includeBots ? botRead(false) : null,
    includeBots ? botRead(true) : null,
  ])

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  for (const read of [bots, botsUnread]) {
    if (read?.error) console.error('[notifications] bot notices read failed:', read.error.message)
  }
  // Newest first, each once: the newest, then the unread ones older than them.
  const botNotifications = includeBots
    ? (() => {
        const held = new Map<string, Record<string, unknown>>()
        for (const read of [bots, botsUnread]) {
          for (const row of (read?.error ? [] : (read?.data ?? [])) as unknown as Array<Record<string, unknown>>) {
            if (typeof row.id === 'string' && !held.has(row.id)) held.set(row.id, row)
          }
        }
        return [...held.values()]
          .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || String(b.id).localeCompare(String(a.id)))
          .map(asBotNotice)
      })()
    : null

  let result = ((notifications || []) as unknown as NotificationRow[]).map((n) => {
    const actor = n.actor as unknown as { id: string; display_name: string; avatar_url: string | null } | null
    // PostgREST hands a many-to-one embed back as an object, but supabase-js has
    // typed it as an array in the past — normalize both shapes to one row.
    const embedded = n.workspace
    const workspace = Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null
    return {
      ...n,
      actor_name: actor?.display_name || null,
      actor_avatar: actor?.avatar_url || null,
      actor: undefined,
      // Spread conditionally: in the default scope there is no embed, so the
      // response keeps exactly the keys it has always had.
      ...(workspace ? { workspace } : {}),
    }
  })

  // Resolve share notifications that are missing context — look up the
  // underlying shareable entity so the client can open a detail panel.
  const unresolvedShareIds = result
    .filter((n) => n.target_type === 'share' && n.target_id && !n.context_type)
    .map((n) => n.target_id as string)

  if (unresolvedShareIds.length > 0) {
    const { data: shares } = await supabase
      .from('share')
      .select('id, shareable_type, shareable_id')
      .in('id', unresolvedShareIds)

    if (shares && shares.length > 0) {
      const shareMap = new Map(shares.map((s) => [s.id, s]))
      result = result.map((n) => {
        if (n.target_type === 'share' && n.target_id && !n.context_type) {
          const share = shareMap.get(n.target_id)
          if (share) {
            return { ...n, context_type: share.shareable_type, context_id: share.shareable_id }
          }
        }
        return n
      })
    }
  }

  return NextResponse.json({
    notifications: result,
    ...(botNotifications ? { bot_notifications: botNotifications, orphan_teammate_ids: orphans, bot_teammate_ids: reach.reachable } : {}),
    // Only in `all`: the client subscribes ONE realtime channel per member id
    // (the channel filter is `recipient_id=eq.<id>`, which takes a single
    // value), so it needs the set the server actually read.
    ...(scope === 'all' ? { memberships } : {}),
  })
}
