import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { featureGatedRecipeExclusions, resolveWorkspaceEdition } from '@/lib/editions'
import { excludeFeatureGatedRecipes } from '@/lib/library/feature-gate'

/**
 * Skill commands — the lightweight list used by the slash-command picker.
 * Returns only skills that have a slug (i.e. callable via slash command).
 */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  // A feature-owned system skill (today `/create-eval`) must not appear in the
  // slash-command picker of a workspace that has its feature off.
  const gated = featureGatedRecipeExclusions(
    await resolveWorkspaceEdition(supabase, workspaceId),
  )

  const { data, error } = await excludeFeatureGatedRecipes(
    supabase
      .from('recipe')
      .select('id, slug, name, icon, color, description, views_context')
      .eq('category', 'skill')
      .or(`is_system.eq.true,workspace_id.eq.${workspaceId}`),
    gated,
  )
    .not('slug', 'is', null)
    // A lens skill (F3) only runs as a call loop's skill: no /command for it.
    .is('agent_config->>lens', null)
    .order('sort_order', { ascending: true })

  if (error) return serverError(error.message)
  return NextResponse.json({ commands: data || [] })
}
