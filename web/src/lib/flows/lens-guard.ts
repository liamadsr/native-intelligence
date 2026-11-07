/**
 * Where a lens skill may be used (F3 review S1, S10): checked whenever a
 * loop's trigger or steps are saved (the REST routes and chat's
 * create_flow / update_flow), so a lens loop that could only fail is never
 * saved.
 *
 *   - A lens skill (recipe.agent_config.lens) only runs after a call: its
 *     loop's trigger must be capture_processed. On any other trigger there is
 *     no call to read and nothing for its condition to check.
 *   - The marketing lens edits the product doc, which only owners and admins
 *     can edit: a member who isn't one can't own a marketing-lens loop (its
 *     every batch would be refused).
 *
 * Reads the steps' skills once. Fails CLOSED: a failed read refuses.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isLensKey } from './lenses'
import type { FlowAction, RunSkillActionConfig } from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The lens a skill names, by skill id, for these steps' run_skill skills. */
async function lensSkills(supabase: SupabaseClient, workspaceId: string, actions: ReadonlyArray<Pick<FlowAction, 'type' | 'config'>>): Promise<Map<string, { lens: string; name: string }> | null> {
  const ids = [
    ...new Set(
      actions
        .filter((a) => a.type === 'run_skill')
        .map((a) => (a.config as RunSkillActionConfig)?.skill_id)
        .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)),
    ),
  ]
  const out = new Map<string, { lens: string; name: string }>()
  if (ids.length === 0) return out
  const { data, error } = await supabase
    .from('recipe')
    .select('id, name, agent_config')
    .in('id', ids)
    .eq('category', 'skill')
    .or(`workspace_id.eq.${workspaceId},is_system.eq.true`)
  if (error) return null
  for (const row of (data ?? []) as Array<{ id: string; name: string | null; agent_config: { lens?: unknown } | null }>) {
    const lens = row.agent_config?.lens
    if (isLensKey(lens)) out.set(row.id, { lens, name: row.name ?? lens })
  }
  return out
}

/**
 * Why these steps can't be saved on this trigger by this person, naming the
 * step (0-based) and the fix, or null. `userId` is the loop's owner: the
 * person saving it (a loop's owner is fixed, F1).
 */
export async function lensStepRefusal(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; triggerType: string; actions: ReadonlyArray<Pick<FlowAction, 'type' | 'config'>> },
): Promise<{ index: number; message: string; fix: string } | null> {
  const lenses = await lensSkills(supabase, args.workspaceId, args.actions)
  if (!lenses) return { index: 0, message: "couldn't check this loop's skills", fix: 'Try again' }
  if (lenses.size === 0) return null
  for (let index = 0; index < args.actions.length; index++) {
    const a = args.actions[index]
    if (a.type !== 'run_skill') continue
    const lens = lenses.get((a.config as RunSkillActionConfig)?.skill_id)
    if (!lens) continue
    if (args.triggerType !== 'capture_processed') {
      return {
        index,
        message: `${lens.name} is a lens: it reads calls, so it only runs on a capture_processed trigger`,
        fix: 'Use trigger.type "capture_processed", or another skill',
      }
    }
    if (lens.lens === 'marketing') {
      const { data, error } = await supabase.from('member').select('role').eq('workspace_id', args.workspaceId).eq('user_id', args.userId).maybeSingle()
      const role = (data as { role?: unknown } | null)?.role
      if (error || (role !== 'owner' && role !== 'admin')) {
        return {
          index,
          message: `${lens.name} keeps the product doc current, which only owners and admins can edit`,
          fix: 'Ask a workspace owner or admin to set it up',
        }
      }
    }
  }
  return null
}
