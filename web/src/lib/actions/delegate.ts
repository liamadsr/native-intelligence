/**
 * Agents on actions: the delegate model (docs/plans/always-on-agent.md §4b,
 * decision 9 — Linear's model).
 *
 * An action has two assignee slots that used to exclude each other: the member
 * slot (`assignee_id` + `action_assignee`) and the agent slot
 * (`assignee_ai_member_id`, migration 145). They now coexist. The person stays
 * responsible and the agent works the action as the DELEGATE, so the board
 * shows both. When an agent is set and no person holds the action, the person
 * who set the agent (the delegator) becomes the person responsible.
 *
 * Every writer that sets an agent goes through these helpers: the action PATCH
 * and POST routes, the proposal apply engine, and the action tools'
 * `delegate` parameter.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { assignableTeammateRow } from '@/lib/workspace-fences'
import { callerCanReachTeammate } from '@/lib/chat/teammate-access'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** How many teammates a name lookup reads: a workspace's roster, never a scan. */
const ROSTER_LIMIT = 200

/**
 * The person list an action carries after a write, given the agent the write
 * sets. Pure.
 *
 *   - `delegating`: the write sets an agent (a non-null `assignee_ai_member_id`).
 *   - `requested`: the person list the write names (undefined: it names none).
 *   - `current`: the people the action holds now.
 *   - `delegatorMemberId`: the person making the write, in the action's workspace.
 *
 * Returns the list to write, or undefined to leave the people alone. A write
 * that names people always wins. A delegation that names nobody keeps the
 * people already there, and with nobody there the delegator becomes the
 * person responsible. A write that sets no agent passes its own list through.
 */
export function responsibleAssigneeIds(args: {
  delegating: boolean
  requested: string[] | undefined
  current: readonly string[]
  delegatorMemberId: string | null | undefined
}): string[] | undefined {
  const { delegating, requested, current, delegatorMemberId } = args
  if (!delegating) return requested
  if (requested && requested.length > 0) return requested
  if (requested === undefined && current.length > 0) return undefined
  return delegatorMemberId ? [delegatorMemberId] : requested
}

/** The caller's member row in a workspace, or null. */
export async function memberIdForUser(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

export type DelegateCheck =
  | { ok: true; id: string; name: string; role: string | null }
  | { ok: false; reason: 'not_found' | 'not_assignable' | 'not_visible' }

/**
 * May this caller hand work to this agent? The fence every UI path that names
 * an agent goes through (the action PATCH and POST routes, start-agent): the
 * agent is in the workspace, assignable (workspace-fences.ts), and one the
 * caller can see (a private team's agents only for its members,
 * teammate-access.ts callerCanReachTeammate — checked explicitly because the
 * admin policy on ai_team_member reads a private team's agents too). Returns
 * the agent's role for start-agent's worker choice. Fails closed: a lookup
 * error reads as not visible.
 */
export async function checkDelegate(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; teammateId: string; memberId?: string | null },
): Promise<DelegateCheck> {
  try {
    const { data } = await supabase
      .from('ai_team_member')
      .select('id, name, role, team_id, is_system, fronts_only')
      .eq('id', args.teammateId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    const row = data as (RosterRow & { role?: string | null }) | null
    if (!row?.id) return { ok: false, reason: 'not_found' }
    if (!assignableTeammateRow(row)) return { ok: false, reason: 'not_assignable' }
    const canSee = await callerCanReachTeammate(supabase, {
      userId: args.userId,
      workspaceId: args.workspaceId,
      teammate: { isSystem: row.is_system === true, teamId: row.team_id },
      ...(args.memberId !== undefined ? { memberId: args.memberId } : {}),
    })
    if (!canSee) return { ok: false, reason: 'not_visible' }
    return { ok: true, id: row.id, name: row.name?.trim() || 'Agent', role: row.role ?? null }
  } catch {
    return { ok: false, reason: 'not_visible' }
  }
}

export type DelegateResolution ={ ok: true; id: string; name: string } | { ok: false; error: string }

interface RosterRow {
  id: string
  name: string | null
  team_id: string | null
  is_system: boolean | null
  fronts_only: boolean | null
}

const DELEGATE_HINT = 'Pass an agent id or name from list_bot_work.'

/**
 * Resolve the `delegate` an action tool was given (an agent id or name) to one
 * agent the caller may hand work to:
 *   - in the action's workspace;
 *   - assignable (not a built-in loop's teammate, not a loop's work bot:
 *     workspace-fences.ts assignableTeammateRow);
 *   - one the caller can see (a private team's agents only for its members:
 *     teammate-access.ts callerCanReachTeammate, checked explicitly because the
 *     tools run on the service client).
 * A name matches case-insensitively, exactly, then as the one agent whose name
 * contains it; several matches are refused with their names. An agent the
 * caller can't see reads exactly like one that doesn't exist. Never throws.
 */
export async function resolveDelegate(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; ref: string },
): Promise<DelegateResolution> {
  const ref = args.ref.trim()
  if (!ref) return { ok: false, error: `delegate is empty. ${DELEGATE_HINT}` }
  try {
    let candidates: RosterRow[]
    if (UUID_RE.test(ref)) {
      const { data } = await supabase
        .from('ai_team_member')
        .select('id, name, team_id, is_system, fronts_only')
        .eq('id', ref)
        .eq('workspace_id', args.workspaceId)
        .maybeSingle()
      candidates = data ? [data as RosterRow] : []
    } else {
      const { data } = await supabase
        .from('ai_team_member')
        .select('id, name, team_id, is_system, fronts_only')
        .eq('workspace_id', args.workspaceId)
        .eq('is_system', false)
        .limit(ROSTER_LIMIT)
      const roster = ((data ?? []) as RosterRow[]).filter((r) => assignableTeammateRow(r))
      const needle = ref.toLowerCase()
      const exact = roster.filter((r) => (r.name ?? '').trim().toLowerCase() === needle)
      candidates = exact.length > 0 ? exact : roster.filter((r) => (r.name ?? '').toLowerCase().includes(needle))
    }

    const reachable: RosterRow[] = []
    for (const row of candidates) {
      if (!assignableTeammateRow(row)) continue
      const canSee = await callerCanReachTeammate(supabase, {
        userId: args.userId,
        workspaceId: args.workspaceId,
        teammate: { isSystem: row.is_system === true, teamId: row.team_id },
      })
      if (canSee) reachable.push(row)
    }

    if (reachable.length === 1) {
      return { ok: true, id: reachable[0].id, name: reachable[0].name?.trim() || 'Agent' }
    }
    if (reachable.length > 1) {
      const names = reachable.slice(0, 5).map((r) => `"${r.name ?? 'Agent'}" (${r.id})`).join(', ')
      return { ok: false, error: `delegate "${ref}" matches several agents: ${names}. Pass the id.` }
    }
    return { ok: false, error: `No agent "${ref}" you can hand work to in this workspace. ${DELEGATE_HINT}` }
  } catch (err) {
    return { ok: false, error: `Could not look up the delegate: ${err instanceof Error ? err.message : String(err)}` }
  }
}
