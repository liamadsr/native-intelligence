/**
 * The owner rule's facts on the server (bot-owner.ts): each workspace's
 * Assistant, and whether the caller can reach each teammate the work names.
 *
 * Read from the work itself, never from a capped list: the Assistants of the
 * caller's workspaces, plus exactly the teammates the rows and cards name
 * (`teammateIds`), or, for the Assistant's own page, every teammate of its
 * workspace (`'all'`, paged), so the facts are complete (bot-owner.ts
 * `complete`): a named teammate this read can't see is deleted or hidden by
 * RLS (a private team's, on a session client), out of reach either way.
 *
 * Reach is the private-team rule (callerReachableTeammateIds), as the roster
 * reads it. Fail-soft: a failed teammate read is no owners (nothing falls
 * back: today's behaviour), logged; a failed reach read keeps every teammate
 * read reachable (only the deleted and hidden ones fall back), as the roster
 * does.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { callerReachableTeammateIds } from '@/lib/chat/teammate-access'
import { ASSISTANT_SYSTEM_KEY, NO_BOT_OWNERS, botOwners, type BotOwners } from './bot-owner'

/** Ids per `in` list (keeps each request's URL short). */
const IDS_CHUNK = 150
/** Rows per page of a whole workspace's read (PostgREST's own row cap). */
const PAGE = 1000

const SELECT = 'id, workspace_id, team_id, name, is_system, system_key, bot_character'

interface TeammateRow {
  id: string
  workspace_id: string
  team_id: string | null
  name: string | null
  is_system: boolean | null
  system_key: string | null
  bot_character: string | null
}

async function readTeammates(
  supabase: SupabaseClient,
  workspaceIds: readonly string[],
  teammateIds: readonly string[] | 'all',
): Promise<TeammateRow[]> {
  const out = new Map<string, TeammateRow>()
  const keep = (data: unknown) => {
    for (const r of (data ?? []) as TeammateRow[]) if (r?.id) out.set(r.id, r)
  }
  const assistants = await supabase.from('ai_team_member').select(SELECT).in('workspace_id', [...workspaceIds]).eq('system_key', ASSISTANT_SYSTEM_KEY)
  if (assistants.error) throw new Error(assistants.error.message)
  keep(assistants.data)
  if (teammateIds === 'all') {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('ai_team_member')
        .select(SELECT)
        .in('workspace_id', [...workspaceIds])
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(error.message)
      keep(data)
      if ((data ?? []).length < PAGE) break
    }
  } else {
    const ids = [...new Set(teammateIds)].filter((id) => !out.has(id))
    for (let i = 0; i < ids.length; i += IDS_CHUNK) {
      const { data, error } = await supabase.from('ai_team_member').select(SELECT).in('id', ids.slice(i, i + IDS_CHUNK)).in('workspace_id', [...workspaceIds])
      if (error) throw new Error(error.message)
      keep(data)
    }
  }
  return [...out.values()]
}

export async function loadBotOwners(
  supabase: SupabaseClient,
  args: { userId: string; workspaceIds: readonly string[]; teammateIds: readonly string[] | 'all' },
): Promise<BotOwners> {
  if (args.workspaceIds.length === 0) return NO_BOT_OWNERS
  let rows: TeammateRow[]
  try {
    rows = await readTeammates(supabase, args.workspaceIds, args.teammateIds)
  } catch (err) {
    console.error('[bot-owner] teammates read failed; nothing falls back to the Assistant:', err instanceof Error ? err.message : err)
    return NO_BOT_OWNERS
  }
  let reachable: Set<string> | null
  try {
    reachable = await callerReachableTeammateIds(supabase, {
      userId: args.userId,
      teammates: rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id, isSystem: r.is_system === true, teamId: r.team_id ?? null })),
    })
  } catch (err) {
    console.error('[bot-owner] reach read failed; every teammate read keeps its work:', err instanceof Error ? err.message : err)
    reachable = null
  }
  return botOwners(
    rows.map((r) => ({ ...r, reachable: reachable ? reachable.has(r.id) : null })),
    { complete: true },
  )
}

/**
 * The teammates the caller can reach in `workspaceId`, but its Assistant and
 * its area faces: whose rows the Assistant's read leaves out (queries.ts
 * TeammateScope.unowned). An area face's rows are the agent's own (one face,
 * bot-owner.ts), so the Assistant's read takes them in. Read off owners
 * loaded with `'all'` for that workspace.
 */
export function otherReachableTeammates(owners: BotOwners, workspaceId: string): string[] {
  const assistant = owners.assistants.get(workspaceId)?.id ?? null
  return [...owners.reachable].flatMap(([id, ws]) => (ws === workspaceId && id !== assistant && !owners.areaFaces.has(id) ? [id] : []))
}
