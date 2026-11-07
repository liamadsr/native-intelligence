/**
 * Which bots' notices live with their bot (bots-v4 Phase 4c, decision 8, as
 * Liam refined it on #653): only those whose bot the caller can reach. A
 * notice names its teammate (`metadata.teammate_id`, bot-notice.ts); when that
 * teammate is gone (deleted), hidden from the caller, or behind a private team
 * they aren't on (left, or never joined), the notice has no bot to live with,
 * so it is a plain notice. (No list draws plain notices any more: the bell
 * went, docs/plans/retire-notifications-page.md. The shell holds them for
 * their banners.)
 *
 * The rule is the roster's `reachable` (callerReachableTeammateIds, the
 * private-team rule), read in a batch on the caller's RLS client:
 *
 *   1. the teammates the recipients' notices name: `metadata->>teammate_id`
 *      off their newest NAMED_NOTICES_READ unarchived bot notices (one text
 *      column each), each id once;
 *   2. those teammates as the caller sees them (`ai_team_member` under RLS:
 *      a deleted or hidden one isn't returned), in chunks of TEAMMATES_CHUNK;
 *   3. which of those the caller may reach (at most three more reads, and
 *      only the ones needed: callerReachableTeammateIds).
 *
 * What's named and can't be reached is an ORPHAN. The plain reads filter on
 * the orphans (`plainNotices`: no teammate, or an orphaned one) and a bot's
 * lists on the rest (`botNotices`), and the filter stays as short as the
 * orphans are few. A failed reach read falls back to "every teammate the
 * caller sees is reachable" (only the deleted and hidden ones are orphans),
 * logged. A failed read of the names is no orphans.
 *
 * A failed run's notice lives with its bot like any other (its bot's dot). It
 * reaches the person through the agent: the router tells it in the home
 * thread (agent-events/router.ts, retire-notifications-page phase 2).
 *
 * Only a teammate id that is a uuid is ever named in a filter (the values come
 * from a jsonb field, so nothing else is spliced into PostgREST's syntax); a
 * malformed one is never an orphan. At most ORPHANS_MAX are named (the newest
 * notices' first), logged when more.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { callerReachableTeammateIds } from '@/lib/chat/teammate-access'
import { BOT_NOTICE_TEAMMATE_PATH } from './bot-notice'

/** How many of the recipients' newest bot notices are read for the teammates they name. */
export const NAMED_NOTICES_READ = 1000
/** Teammates read per `in` (keeps each request's URL short). */
export const TEAMMATES_CHUNK = 150
/** At most this many orphaned teammates are named in a filter. */
export const ORPHANS_MAX = 100

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The teammates the recipients' notices name, split: those the caller can reach, and the orphans. */
export interface NoticeReach {
  /** Named and reachable: their notices live with their bots. */
  reachable: string[]
  /** Named and not reachable (deleted, hidden, a private team's): their notices are plain ones. At most ORPHANS_MAX. */
  orphans: string[]
}

const NOBODY: NoticeReach = { reachable: [], orphans: [] }

/** The teammates the recipients' notices name, reachable and orphaned (see the module note). Never throws. */
export async function noticeTeammateReach(
  supabase: SupabaseClient,
  args: { userId: string; recipientIds: readonly string[] },
): Promise<NoticeReach> {
  if (args.recipientIds.length === 0) return NOBODY
  try {
    const base = supabase.from('notification').select(`teammate_id:${BOT_NOTICE_TEAMMATE_PATH}`)
    const { data, error } = await (args.recipientIds.length === 1
      ? base.eq('recipient_id', args.recipientIds[0])
      : base.in('recipient_id', [...args.recipientIds])
    )
      .eq('is_archived', false)
      .not(BOT_NOTICE_TEAMMATE_PATH, 'is', null)
      .order('created_at', { ascending: false })
      .limit(NAMED_NOTICES_READ)
    if (error) throw new Error(error.message)
    const named: string[] = []
    const seen = new Set<string>()
    for (const row of (data ?? []) as Array<{ teammate_id?: unknown }>) {
      const id = typeof row.teammate_id === 'string' ? row.teammate_id : null
      if (!id || seen.has(id) || !UUID.test(id)) continue
      seen.add(id)
      named.push(id)
    }
    if (named.length === 0) return NOBODY

    const visible: Array<{ id: string; workspace_id: string; team_id: string | null; is_system: boolean | null }> = []
    for (let i = 0; i < named.length; i += TEAMMATES_CHUNK) {
      const { data: mates, error: matesError } = await supabase
        .from('ai_team_member')
        .select('id, workspace_id, team_id, is_system')
        .in('id', named.slice(i, i + TEAMMATES_CHUNK))
      if (matesError) throw new Error(matesError.message)
      visible.push(...((mates ?? []) as typeof visible))
    }

    let reachable: Set<string>
    try {
      reachable = await callerReachableTeammateIds(supabase, {
        userId: args.userId,
        teammates: visible.map((t) => ({ id: t.id, workspaceId: t.workspace_id, isSystem: t.is_system === true, teamId: t.team_id ?? null })),
      })
    } catch (err) {
      console.error('[notifications] reach read failed; only unseen teammates are orphans:', err instanceof Error ? err.message : err)
      reachable = new Set(visible.map((t) => t.id))
    }
    const orphans = named.filter((id) => !reachable.has(id))
    if (orphans.length > ORPHANS_MAX) console.warn(`[notifications] ${orphans.length} orphaned bots; naming the newest ${ORPHANS_MAX}`)
    return { reachable: named.filter((id) => reachable.has(id)), orphans: orphans.slice(0, ORPHANS_MAX) }
  } catch (err) {
    console.error('[notifications] notice teammates read failed:', err instanceof Error ? err.message : err)
    return NOBODY
  }
}

/** A filter on a query (PostgREST's builder, structurally: the routes' and the tool's). */
interface Filterable<Q> {
  not: (column: string, operator: string, value: unknown) => Q
  or: (filters: string) => Q
}

/** `query` narrowed to the plain notices: no teammate, or an orphaned one. */
export function plainNotices<Q extends Filterable<Q>>(query: Q, orphans: readonly string[]): Q {
  if (orphans.length === 0) return query.or(`${BOT_NOTICE_TEAMMATE_PATH}.is.null`)
  return query.or(`${BOT_NOTICE_TEAMMATE_PATH}.is.null,${BOT_NOTICE_TEAMMATE_PATH}.in.(${orphans.join(',')})`)
}

/**
 * `query` narrowed to the bots' notices: a teammate the caller can reach
 * (named, and not an orphan). A failed run's is here (its bot keeps it, and its
 * page's switcher dot reads it).
 */
export function botNotices<Q extends Filterable<Q>>(query: Q, orphans: readonly string[]): Q {
  const named = query.not(BOT_NOTICE_TEAMMATE_PATH, 'is', null)
  return orphans.length === 0 ? named : named.not(BOT_NOTICE_TEAMMATE_PATH, 'in', `(${orphans.join(',')})`)
}
