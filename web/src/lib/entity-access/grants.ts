/**
 * PER-ITEM ACCESS, the read rule for an explicit user: the TypeScript mirror
 * of has_entity_grant (migration 492), for the code that runs on a
 * SERVICE-ROLE client (the eve tool routes, the graph walks), where RLS
 * hides nothing and auth.uid() is NULL. On a session client the same reads
 * go through entity_access's own RLS, which shows a grantee their grants, so
 * the answer is the same.
 *
 * A grant on a record (type, id) in workspace W reaches user U when U has a
 * member row M in W and the grant names:
 *   - M itself (grantee_kind 'member');
 *   - a team of W that M is in ('team');
 *   - a team-chat channel of W that U can read ('channel'; 474's
 *     team_chat_can_read, the team chat fence in
 *     src/lib/knowledge/entity-fences.ts).
 * The grant's own workspace must be W: a grant never reaches across
 * workspaces (the table's trigger refuses one, and this re-checks).
 *
 * Every read FAILS CLOSED: an error, no user or no member row is "no grant".
 * Flat cost: one read of the member row, one of the grants for the ids asked
 * about (chunked), then at most one read of team rows and one channel fence.
 *
 * Server only. Change the SQL rule, change this (the tests pin both).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inChunks } from '@/lib/supabase/paging'
import { visiblePrivateKindIds } from '@/lib/knowledge/entity-fences'
import type { GrantableType } from './model'

const ID_CHUNK = 200

type GrantRow = {
  entity_id: string
  grantee_kind: string
  grantee_member_id: string | null
  grantee_team_id: string | null
  grantee_channel_id: string | null
}

const uniq = (ids: readonly string[]) => [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]

/**
 * The ids among `ids` (records of `type` in `workspaceId`) that a grant
 * reaches `userId` for. Empty for no user, no member row, or a failed read.
 */
export async function grantedEntityIds(
  supabase: SupabaseClient,
  scope: { userId: string | null | undefined; workspaceId: string },
  type: GrantableType,
  ids: readonly string[],
): Promise<Set<string>> {
  const wanted = uniq(ids)
  const { userId, workspaceId } = scope
  if (!userId || !workspaceId || wanted.length === 0) return new Set()
  try {
    const { data: me, error: meError } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    const memberId = (me as { id?: unknown } | null)?.id
    if (meError || typeof memberId !== 'string') return new Set()

    const { data: grantData, error } = await inChunks(wanted, ID_CHUNK, async (c) => {
      const res = await supabase
        .from('entity_access')
        .select('entity_id, grantee_kind, grantee_member_id, grantee_team_id, grantee_channel_id')
        .eq('workspace_id', workspaceId)
        .eq('entity_type', type)
        .in('entity_id', c)
      return { data: (res.data ?? []) as GrantRow[], error: res.error }
    })
    if (error) {
      console.warn('[entity-access] grant read failed:', error.message)
      return new Set()
    }
    const grants = (grantData ?? []) as GrantRow[]
    if (grants.length === 0) return new Set()

    const teamIds = uniq(grants.filter((g) => g.grantee_kind === 'team').map((g) => g.grantee_team_id as string))
    const channelIds = uniq(grants.filter((g) => g.grantee_kind === 'channel').map((g) => g.grantee_channel_id as string))
    const [myTeams, readableChannels] = await Promise.all([
      teamIds.length ? teamsOf(supabase, memberId, workspaceId, teamIds) : Promise.resolve(new Set<string>()),
      channelIds.length
        ? visiblePrivateKindIds(supabase, 'team_chat_channel', userId, channelIds, workspaceId)
        : Promise.resolve(new Set<string>()),
    ])

    const out = new Set<string>()
    for (const g of grants) {
      if (
        (g.grantee_kind === 'member' && g.grantee_member_id === memberId) ||
        (g.grantee_kind === 'team' && !!g.grantee_team_id && myTeams.has(g.grantee_team_id)) ||
        (g.grantee_kind === 'channel' && !!g.grantee_channel_id && readableChannels.has(g.grantee_channel_id))
      ) {
        out.add(g.entity_id)
      }
    }
    return out
  } catch (err) {
    console.warn('[entity-access] grant check threw:', err instanceof Error ? err.message : 'unknown')
    return new Set()
  }
}

/** The teams among `teamIds` that live in `workspaceId` and have `memberId` in them. */
async function teamsOf(supabase: SupabaseClient, memberId: string, workspaceId: string, teamIds: string[]): Promise<Set<string>> {
  const [teams, memberships] = await Promise.all([
    supabase.from('team').select('id').eq('workspace_id', workspaceId).in('id', teamIds),
    supabase.from('team_member').select('team_id').eq('member_id', memberId).in('team_id', teamIds),
  ])
  if (teams.error || memberships.error) return new Set()
  const inWorkspace = new Set(((teams.data ?? []) as Array<{ id: string }>).map((t) => t.id))
  return new Set(
    ((memberships.data ?? []) as Array<{ team_id: string }>).map((m) => m.team_id).filter((id) => inWorkspace.has(id)),
  )
}

/** The table each document-like grantable kind reads from (contacts and companies go through their SQL twins). */
const RECORD_TABLE = { document: 'document', capture: 'captures' } as const

/**
 * `visible` plus the ids among `ids` that a grant reaches `userId` for and
 * that are real rows of `type` in `workspaceId` (an eval capture never is).
 * For the document and capture fences that filter by their own rule first
 * (applyDocumentVisibility, applyCaptureVisibility): what they refused, a
 * grant may still let through. No user: `visible` as it was.
 */
export async function withGrantedIds(
  supabase: SupabaseClient,
  scope: { userId: string | null | undefined; workspaceId: string },
  type: 'document' | 'capture',
  ids: readonly string[],
  visible: Iterable<string>,
): Promise<Set<string>> {
  const out = new Set(visible)
  const rest = uniq(ids).filter((id) => !out.has(id))
  if (!scope.userId || rest.length === 0) return out
  const granted = [...(await grantedEntityIds(supabase, scope, type, rest))]
  if (granted.length === 0) return out
  const { data, error } = await inChunks(granted, ID_CHUNK, async (c) => {
    let q = supabase.from(RECORD_TABLE[type]).select('id').eq('workspace_id', scope.workspaceId).in('id', c)
    if (type === 'capture') q = q.neq('is_eval', true)
    const res = await q
    return { data: (res.data ?? []) as Array<{ id: string }>, error: res.error }
  })
  if (error) return out
  for (const r of (data ?? []) as Array<{ id: string }>) if (typeof r.id === 'string') out.add(r.id)
  return out
}

/**
 * SESSION CLIENT: does the signed-in caller see any of these records ONLY
 * through a grant (migration 494's entity_grant_only)? For a route that reads
 * a record with the caller's RLS and then writes it with the service role: a
 * grant is view-only, so such a route must refuse. Fails CLOSED: an RPC error
 * or a throw counts as "only through a grant".
 */
export async function anySeenOnlyByGrant(supabase: SupabaseClient, type: GrantableType, ids: readonly string[]): Promise<boolean> {
  const answers = await Promise.all(
    uniq(ids).map(async (id) => {
      try {
        const { data, error } = await supabase.rpc('entity_grant_only', { p_type: type, p_id: id })
        return error ? true : data !== false
      } catch {
        return true
      }
    }),
  )
  return answers.some(Boolean)
}
