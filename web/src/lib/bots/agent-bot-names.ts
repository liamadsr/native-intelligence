/**
 * The custom agent a work bot speaks for, by name (docs/plans/bots-v3.md,
 * Phase 6). A custom agent's work bot is built on the agent itself
 * (`agent_recipe_id`, library/agent-bot.ts), where a loop's work bot is built
 * on the global anchor recipe. So a work bot speaks for an agent when its
 * recipe is an agent of the bot's OWN workspace (the anchor has none), shared
 * with the workspace or public (a personal agent's name stays its author's).
 *
 * The Agents roster and the loop editor's "Its bot" picker label such a bot
 * "Bot for Sales Coach" instead of as a loop's bot. Fail-soft: a failed read
 * labels nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface AgentBotMateLike {
  id: string
  workspace_id: string
  fronts_only?: boolean | null
  agent_recipe_id?: string | null
}

/** Teammate id → the name of the custom agent its work bot speaks for. */
export async function agentsWorkBotsSpeakFor(
  client: SupabaseClient,
  mates: readonly AgentBotMateLike[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const bots = mates.filter((m) => m.fronts_only === true && m.agent_recipe_id)
  if (bots.length === 0) return out
  try {
    const ids = [...new Set(bots.map((b) => b.agent_recipe_id as string))]
    const { data, error } = await client
      .from('recipe')
      .select('id, name, workspace_id, category, visibility')
      .in('id', ids)
    if (error) throw new Error(error.message)
    const recipes = new Map(
      ((data ?? []) as Array<{ id: string; name: string | null; workspace_id: string | null; category: string | null; visibility: string | null }>).map(
        (r) => [r.id, r],
      ),
    )
    for (const bot of bots) {
      const r = recipes.get(bot.agent_recipe_id as string)
      if (!r || r.category !== 'agent' || !r.workspace_id || r.workspace_id !== bot.workspace_id) continue
      if (r.visibility !== 'workspace' && r.visibility !== 'public') continue
      const name = r.name?.trim()
      if (name) out.set(bot.id, name)
    }
  } catch (err) {
    console.error('[agent-bot-names] agent read failed:', err instanceof Error ? err.message : err)
  }
  return out
}
