/**
 * Which loops (flows) use a connection (flows-connectors F2: list_connections
 * shows them; disconnect names them and switches them off).
 *
 * A loop runs as its owner (created_by, F1), so only the owner's own loops
 * use the owner's connections. What a loop needs is read from what it IS,
 * never from its name:
 *   - a recurring calendar_event trigger      → a calendar;
 *   - a pr_status_changed trigger             → GitHub;
 *   - a run_skill step whose skill declares
 *     `calendar_connected` / `inbox_synced`   → a calendar / a mailbox
 *     (skill-preconditions.ts, the same words the run checks).
 * MCP servers: no loop can reach one yet (a skill run never builds them; F4
 * adds call_tool), so none uses one.
 *
 * One read of the owner's loops in the workspace and one of the skills they
 * run. Pure rule (loopNeeds) plus the loader.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { parsePreconditions } from '@/lib/flows/skill-preconditions'

/** What a loop can need from a connection. */
export type ConnectionNeed = 'calendar' | 'email' | 'github'

/** A loop row, as this reads it. */
export interface LoopForNeeds {
  id: string
  name: string | null
  enabled: boolean | null
  trigger_type: string | null
  actions: unknown
}

/** The run_skill skill ids a loop's steps name. */
export function loopSkillIds(actions: unknown): string[] {
  if (!Array.isArray(actions)) return []
  const ids: string[] = []
  for (const a of actions as Array<Record<string, unknown>>) {
    if (a?.type !== 'run_skill') continue
    const id = (a.config as { skill_id?: unknown } | undefined)?.skill_id
    if (typeof id === 'string' && id) ids.push(id)
  }
  return ids
}

/** What one loop needs, given the skills' agent_config by id. */
export function loopNeeds(loop: LoopForNeeds, skillConfigs: ReadonlyMap<string, unknown>): Set<ConnectionNeed> {
  const needs = new Set<ConnectionNeed>()
  if (loop.trigger_type === 'calendar_event') needs.add('calendar')
  if (loop.trigger_type === 'pr_status_changed') needs.add('github')
  for (const id of loopSkillIds(loop.actions)) {
    const cfg = skillConfigs.get(id) as { preconditions?: unknown } | null | undefined
    for (const key of parsePreconditions(cfg?.preconditions)) {
      if (key === 'calendar_connected') needs.add('calendar')
      if (key === 'inbox_synced') needs.add('email')
    }
  }
  return needs
}

/** What a connection provides: an OAuth account's capability, or nothing (an MCP server, today). */
export function needOfIntegration(provider: string, capability: string): ConnectionNeed | null {
  if (capability === 'calendar') return 'calendar'
  if (capability === 'email') return 'email'
  if (provider === 'github') return 'github'
  return null
}

/** A loop that uses a connection, as list_connections and disconnect show it. */
export interface DependentLoop {
  id: string
  name: string
  on: boolean
}

/**
 * The owner's loops in this workspace (or, with null, in every workspace:
 * a disconnect stops all of them), each with what it needs. Best effort: a
 * failed read is none.
 */
export async function loadLoopNeeds(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string | null },
): Promise<Array<{ loop: DependentLoop; needs: Set<ConnectionNeed> }>> {
  let query = supabase.from('flow').select('id, name, enabled, trigger_type, actions').eq('created_by', args.userId)
  if (args.workspaceId) query = query.eq('workspace_id', args.workspaceId)
  const { data, error } = await query
  if (error || !Array.isArray(data)) return []
  const loops = data as LoopForNeeds[]
  const skillIds = [...new Set(loops.flatMap((l) => loopSkillIds(l.actions)))]
  const configs = new Map<string, unknown>()
  if (skillIds.length) {
    const { data: skills } = await supabase.from('recipe').select('id, agent_config').in('id', skillIds)
    for (const s of (skills ?? []) as Array<{ id: string; agent_config: unknown }>) configs.set(s.id, s.agent_config)
  }
  return loops.map((l) => ({
    loop: { id: l.id, name: l.name?.trim() || 'Untitled loop', on: l.enabled === true },
    needs: loopNeeds(l, configs),
  }))
}

/** The loops that need `need` (none for null). */
export function loopsNeeding(
  loops: ReadonlyArray<{ loop: DependentLoop; needs: ReadonlySet<ConnectionNeed> }>,
  need: ConnectionNeed | null,
): DependentLoop[] {
  if (!need) return []
  return loops.filter((l) => l.needs.has(need)).map((l) => l.loop)
}
