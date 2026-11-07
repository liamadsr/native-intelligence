/**
 * A persona's runs are attributed to its teammate (docs/plans/bots-v3.md,
 * Phase 6). A run done as a persona alone (a run_agent loop action, or any
 * agent_run that carries `agent_recipe_id` and no teammate) has no teammate of
 * its own; the custom agent's teammate (made with the agent: library/agent-bot.ts)
 * fronts it, so its ledger row names that teammate and its bot brings it to you.
 *
 * DORMANT today: the only producer of such a run is run_agent
 * (flows/run-agent.ts), and RUN_AGENT_DISPATCH_ENABLED is off, so no agent_run
 * is written. Delegation, a work item's Start and a chat's delegate always
 * name a teammate. Until the flag is on, a plain member's agent bot fronts no
 * run; it is still the agent's face, and its chat speaks for the agent.
 *
 * Kept apart from agent-bot.ts so the work ledger (agent-run-mirror.ts) reads
 * it without the loop-bot module.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { callerCanReachTeammate } from '@/lib/chat/teammate-access'

/**
 * The teammate a persona's runs are attributed to: the oldest non-system
 * teammate of this workspace built on the persona (`agent_recipe_id`), that
 * the run's user can reach when one is named (a bot on a private team they
 * aren't on would front work they can never see). Null when none. Fail-soft:
 * attribution never blocks a run.
 */
export async function teammateForPersona(
  service: SupabaseClient,
  args: { workspaceId: string; agentRecipeId: string; userId?: string | null },
): Promise<string | null> {
  try {
    const { data, error } = await service
      .from('ai_team_member')
      .select('id, team_id, is_system, created_at')
      .eq('workspace_id', args.workspaceId)
      .eq('agent_recipe_id', args.agentRecipeId)
      .eq('is_system', false)
      .order('created_at', { ascending: true })
    if (error) return null
    for (const mate of (data ?? []) as Array<{ id: string; team_id: string | null; is_system: boolean }>) {
      if (!args.userId) return mate.id
      const reachable = await callerCanReachTeammate(service, {
        userId: args.userId,
        workspaceId: args.workspaceId,
        teammate: { isSystem: false, teamId: mate.team_id ?? null },
      }).catch(() => false)
      if (reachable) return mate.id
    }
    return null
  } catch {
    return null
  }
}
