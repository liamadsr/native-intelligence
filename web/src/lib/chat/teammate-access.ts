/**
 * The private-team rule for a teammate chat (bots v2, Phase 1), checked
 * EXPLICITLY wherever the chat resolves its teammate: the mint and the thread
 * (resolveVisibleTeammate), the spec rebuild (chat-system-prompt.ts
 * loadTeammateLayer) and the tool route (chat-ceiling.ts
 * resolveTeammateChatBounds).
 *
 * ai_team_member's RLS can't be relied on for it. Its select policy carries
 * the rule ("Workspace members can view AI team members": a system teammate,
 * or a team that is not private, or one the caller is in), but the permissive
 * ALL policy "Admins and leads can manage AI team members" also grants SELECT,
 * to every workspace owner and admin with no team check. So an admin outside
 * a private team sees its teammates, and without this check could open a chat
 * with one and read its persona, skills and memory
 * (docs/plans/orchestration-followups.md #44 tracks narrowing that policy).
 *
 * Plain reads with no auth.uid() dependence, so it works on either client: the
 * caller's RLS client (a private team they are not in reads as missing, since
 * team's select policy has no admin bypass) or the service client (the
 * explicit team_member row decides).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The ai_team_member facts the rule reads. */
export interface TeammateTeamRef {
  isSystem: boolean
  teamId: string | null
}

/**
 * True when `userId` may talk to the teammate: it is a system teammate, OR its
 * team (in `workspaceId`) is not private, OR the user's member row in that
 * workspace is on the team. A non-system teammate with no team, a team that
 * is missing or in another workspace, and a user with no member row all read
 * as false. Pass `memberId` when the caller already holds the user's member id
 * in `workspaceId` (null: they have none). Throws on a query error; each call
 * site decides whether that is a 500 or a closed door.
 */
export async function callerCanReachTeammate(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; teammate: TeammateTeamRef; memberId?: string | null },
): Promise<boolean> {
  const { userId, workspaceId, teammate } = args
  if (teammate.isSystem) return true
  const teamId = teammate.teamId
  if (!teamId) return false

  const { data: team, error: teamError } = await supabase
    .from('team')
    .select('is_private')
    .eq('id', teamId)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ is_private: boolean | null }>()
  if (teamError) throw new Error(`team lookup failed: ${teamError.message}`)
  if (!team) return false
  // Only an explicit false is public: anything else reads as private.
  if (team.is_private === false) return true

  let memberId = args.memberId
  if (memberId === undefined) {
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .maybeSingle<{ id: string }>()
    if (memberError) throw new Error(`membership lookup failed: ${memberError.message}`)
    memberId = member?.id ?? null
  }
  if (!memberId) return false

  const { data: seat, error: seatError } = await supabase
    .from('team_member')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('member_id', memberId)
    .maybeSingle<{ team_id: string }>()
  if (seatError) throw new Error(`team membership lookup failed: ${seatError.message}`)
  return !!seat
}

/** A teammate as {@link callerReachableTeammateIds} reads it: who it is, its workspace, and the rule's facts. */
export interface TeammateReachRef extends TeammateTeamRef {
  id: string
  workspaceId: string
}

/**
 * Which of `teammates` `userId` may talk to: {@link callerCanReachTeammate}'s
 * rule, for many at once (each roster entry's `reachable`, bots-v4 Phase C:
 * an unreachable bot's work shows as the Assistant's, bot-owner.ts, and
 * isn't drawn). The same rule, case for case: a
 * system teammate; else its team, read in the teammate's own workspace, is
 * explicitly not private; else the user's member row in that workspace holds
 * a seat on it. A non-system teammate with no team, a team that is missing,
 * hidden or in another workspace, and a user with no member row there all
 * read as unreachable.
 *
 * At most three reads whatever the number of teammates, and only the ones it
 * needs: the teams, then (only for private ones) the user's member rows in
 * their workspaces, then the user's seats on them. On the caller's RLS client
 * a private team they are not on reads as missing (team's select policy has
 * no admin bypass), as it does for the single check. Returns the ids that
 * pass. Throws on a query error; the caller decides what that closes.
 */
export async function callerReachableTeammateIds(
  supabase: SupabaseClient,
  args: { userId: string; teammates: readonly TeammateReachRef[] },
): Promise<Set<string>> {
  const reachable = new Set<string>()
  const onTeams: Array<TeammateReachRef & { teamId: string }> = []
  for (const t of args.teammates) {
    if (t.isSystem) reachable.add(t.id)
    else if (t.teamId) onTeams.push({ ...t, teamId: t.teamId })
  }
  if (onTeams.length === 0) return reachable

  const { data: teams, error: teamError } = await supabase
    .from('team')
    .select('id, workspace_id, is_private')
    .in('id', [...new Set(onTeams.map((t) => t.teamId))])
  if (teamError) throw new Error(`team lookup failed: ${teamError.message}`)
  const teamById = new Map(
    ((teams ?? []) as Array<{ id: string; workspace_id: string; is_private: boolean | null }>).map((team) => [team.id, team]),
  )
  const onPrivateTeams: typeof onTeams = []
  for (const t of onTeams) {
    const team = teamById.get(t.teamId)
    if (!team || team.workspace_id !== t.workspaceId) continue
    // Only an explicit false is public: anything else reads as private.
    if (team.is_private === false) reachable.add(t.id)
    else onPrivateTeams.push(t)
  }
  if (onPrivateTeams.length === 0) return reachable

  const { data: members, error: memberError } = await supabase
    .from('member')
    .select('id, workspace_id')
    .eq('user_id', args.userId)
    .in('workspace_id', [...new Set(onPrivateTeams.map((t) => t.workspaceId))])
  if (memberError) throw new Error(`membership lookup failed: ${memberError.message}`)
  const memberIn = new Map(((members ?? []) as Array<{ id: string; workspace_id: string }>).map((m) => [m.workspace_id, m.id]))
  if (memberIn.size === 0) return reachable

  const { data: seats, error: seatError } = await supabase
    .from('team_member')
    .select('team_id, member_id')
    .in('team_id', [...new Set(onPrivateTeams.map((t) => t.teamId))])
    .in('member_id', [...new Set(memberIn.values())])
  if (seatError) throw new Error(`team membership lookup failed: ${seatError.message}`)
  const seated = new Set(((seats ?? []) as Array<{ team_id: string; member_id: string }>).map((s) => `${s.team_id}:${s.member_id}`))
  for (const t of onPrivateTeams) {
    const memberId = memberIn.get(t.workspaceId)
    if (memberId && seated.has(`${t.teamId}:${memberId}`)) reachable.add(t.id)
  }
  return reachable
}
