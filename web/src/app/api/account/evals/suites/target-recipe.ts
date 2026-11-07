/**
 * Can this CALLER, in this workspace, see the recipe a suite wants to grade?
 *
 * `target_recipe_id` is validated by zod as a uuid and nothing more, and the
 * FK it lands on (`eval_suite.target_recipe_id -> recipe(id)`, migration 252)
 * is global: it carries no workspace predicate, so a uuid belonging to another
 * workspace inserts cleanly. That would be harmless if nothing ever read the
 * recipe, but `startEvalRun` snapshots its `system_prompt`, `agent_config` and
 * `model` onto the run row on the SERVICE client, and `RUN_FIELDS` serves
 * `target_system_prompt` back on the run detail to every member of the suite's
 * workspace. So an unchecked id is another workspace's private agent prompt,
 * copied into a row this workspace can read.
 *
 * The predicate, not RLS, is what does the work here. Two of the four callers
 * run on the SERVICE client — the MCP registrar (`src/lib/mcp/auth.ts`) and the
 * eve executor (`/api/internal/chat/tool`) both hand their tools a service
 * client — so an RLS-only check would resolve ANY uuid on those paths. Naming
 * `is_system OR workspace_id = <caller's workspace>` makes the answer identical
 * on every client, which is the only version that is safe to reuse. Within the
 * workspace the predicate is `recipe_select_visibility`'s, applied in code
 * (src/lib/library/visibility.ts): another member's PERSONAL agent or skill is
 * as invisible as a foreign one, or its prompt would land on a run row every
 * member reads.
 *
 * 'error' is distinguished from `false` on purpose: a read that FAILED must not
 * be reported to the user as "that agent does not exist".
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { visibleRecipesFilter } from '@/lib/library/visibility'

export async function recipeIsVisible(
  supabase: SupabaseClient,
  recipeId: string,
  workspaceId: string,
  userId: string,
): Promise<boolean | 'error'> {
  const { data, error } = await supabase
    .from('recipe')
    .select('id')
    .eq('id', recipeId)
    .or(visibleRecipesFilter(workspaceId, userId))
    .maybeSingle()

  if (error) {
    console.error('[evals] target recipe check failed:', error.message)
    return 'error'
  }
  return data !== null
}
