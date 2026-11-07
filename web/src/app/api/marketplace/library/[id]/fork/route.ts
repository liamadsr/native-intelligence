import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { trackServerEvent } from '@/lib/posthog'
import { getServiceClient } from '@/lib/admin'
import { generateSlug } from '@/lib/library/queries'
import { ensureUniqueSlug } from '@/lib/library/slug'

/**
 * Fork a public marketplace item into the current workspace as a
 * personal/workspace item the user can edit.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { id } = await params

  // Fetch source (must be public, non-system)
  const { data: source, error: sourceError } = await supabase
    .from('recipe')
    .select('name, icon, color, description, system_prompt, extraction_config, category, agent_config')
    .eq('id', id)
    .eq('visibility', 'public')
    .eq('is_system', false)
    .single()

  if (sourceError || !source) return notFound('Library item not found or not public')

  // Skills need a unique slug in the destination workspace. ensureUniqueSlug
  // checks the workspace ∪ system namespace and suffixes -2, -3, … — replacing
  // the old workspace-only check with its opaque Date.now() suffix (which also
  // missed collisions against system rows).
  let slug: string | null = null
  if (source.category === 'skill') {
    const base = generateSlug(source.name)
    if (base) slug = await ensureUniqueSlug(supabase, workspaceId, base)
  }

  const insert: Record<string, unknown> = {
    workspace_id: workspaceId,
    name: source.name,
    icon: source.icon,
    color: source.color,
    description: source.description,
    system_prompt: source.system_prompt,
    extraction_config: source.extraction_config,
    category: source.category,
    agent_config: source.agent_config,
    is_system: false,
    visibility: 'workspace',
    created_by: user.id,
    forked_from: id,
  }
  if (slug) insert.slug = slug

  const { data: forked, error: insertError } = await supabase
    .from('recipe')
    .insert(insert)
    // Include forked_from so the returned copy carries its lineage identity; the
    // display facts (source_name/source_updated_at) are merged by the account
    // list routes' `annotateLineage` when the client refetches after the fork.
    .select('id, name, icon, color, description, category, slug, visibility, created_at, forked_from')
    .single()

  if (insertError) return serverError(insertError.message)

  // Best-effort fork count (not critical). The source usually lives in another
  // workspace, where the caller's RLS-scoped client cannot UPDATE it (a silent
  // 0-row no-op), so this goes through the service client. Recomputing from
  // the forks themselves, instead of read-then-increment, cannot lose a count
  // to two concurrent forks.
  try {
    const admin = getServiceClient()
    const { count } = await admin
      .from('recipe')
      .select('id', { count: 'exact', head: true })
      .eq('forked_from', id)
    if (typeof count === 'number') {
      await admin.from('recipe').update({ fork_count: count }).eq('id', id)
    }
  } catch (err) {
    console.error('[marketplace fork] fork_count update failed:', err)
  }

  // Fire-and-forget analytics (never blocks/fails the fork). Carries the SOURCE
  // recipe id + category alongside the new copy's id.
  trackServerEvent('recipe_forked', { userId: user.id, workspaceId, email: user.email }, {
    category: source.category,
    source_recipe_id: id,
    recipe_id: forked.id,
    workspace_id: workspaceId,
  })

  return NextResponse.json({ item: forked })
}
