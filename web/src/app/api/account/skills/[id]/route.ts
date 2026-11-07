import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { trackServerEvent } from '@/lib/posthog'
import {
  LIBRARY_ITEM_FIELDS,
  PUBLISH_ROLE_ERROR,
  canPublishPublic,
  validateSlug,
} from '@/lib/library/queries'
import { ensureUniqueSlug, normalizeSlug } from '@/lib/library/slug'
import { applyAgentConfigUpdate } from '@/lib/library/agent-config'
import { parseSkillArea } from '@/lib/packs/registry'

/**
 * Skill PATCH/DELETE. Same handler logic as agents and meeting types
 * except slug handling, so kept per-category for clarity rather than
 * over-abstracted.
 */

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth

  const { id } = await params

  // Block editing system items. `visibility` is fetched so a transition TO
  // 'public' can also emit `recipe_published` after the write.
  const { data: existing } = await supabase
    .from('recipe')
    .select('is_system, category, visibility, slug, agent_config')
    .eq('id', id)
    .single()

  if (existing?.is_system) return forbidden('Cannot edit system skills')
  if (existing?.category !== 'skill') return badRequest('Not a skill')

  const body = await request.json()

  // Gate the TRANSITION to public (an already-public row re-saved by a member is
  // fine; flipping a non-public row to Discover is platform-wide — owner/admin only).
  if (
    body.visibility === 'public' &&
    existing?.visibility !== 'public' &&
    !canPublishPublic(member.role)
  ) {
    return forbidden(PUBLISH_ROLE_ERROR)
  }

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.icon !== undefined) updates.icon = body.icon
  if (body.color !== undefined) updates.color = body.color
  if (body.description !== undefined) updates.description = body.description
  if (body.system_prompt !== undefined) updates.system_prompt = body.system_prompt
  if (body.sort_order !== undefined) updates.sort_order = body.sort_order
  if (body.agent_config !== undefined) {
    // Validated without stripping; the contract keys (output_contract,
    // preconditions, capture_mode) are carried over when omitted and may only
    // CHANGE for an owner/admin (Sequence step 1, the D.1 lockdown).
    const next = applyAgentConfigUpdate({
      existing: existing?.agent_config,
      incoming: body.agent_config,
      role: member.role,
    })
    if (!next.ok) {
      return next.code === 'AGENT_CONFIG_CONTRACT_LOCKED' ? forbidden(next.error) : badRequest(next.error)
    }
    updates.agent_config = next.config
  }
  if (body.model !== undefined) updates.model = body.model || null
  if (body.visibility !== undefined) updates.visibility = body.visibility
  // The area its pack loads it in: absent leaves it, null or '' clears it.
  const area = parseSkillArea(body.area)
  if (!area.ok) return badRequest(area.error)
  if (area.area !== undefined) updates.area = area.area

  // Only re-slug when the slug is actually CHANGING. An unchanged slug (same
  // value re-sent by the editor) is left untouched — re-running uniqueness on
  // the row's own slug would otherwise suffix it against itself. When it does
  // change, normalize + ensure unique against the workspace(+system) namespace,
  // excluding this row; a collision self-heals via suffix rather than 409ing.
  if (body.slug !== undefined) {
    const requested = normalizeSlug(String(body.slug))
    if (requested !== (existing?.slug ?? '')) {
      const slugError = validateSlug(requested)
      if (slugError) return badRequest(slugError)
      updates.slug = await ensureUniqueSlug(supabase, workspaceId, requested, id)
    }
  }

  const { data, error } = await supabase
    .from('recipe')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(LIBRARY_ITEM_FIELDS)
    .single()

  if (error) return serverError(error.message)

  // Fire-and-forget analytics (never blocks/fails the write). `recipe_published`
  // rides alongside when this edit is what flips the item public.
  trackServerEvent('recipe_updated', { userId: user.id, workspaceId, email: user.email }, {
    category: 'skill',
    visibility: data.visibility,
    recipe_id: id,
    workspace_id: workspaceId,
  })
  if (data.visibility === 'public' && existing?.visibility !== 'public') {
    trackServerEvent('recipe_published', { userId: user.id, workspaceId, email: user.email }, {
      category: 'skill',
      recipe_id: id,
      workspace_id: workspaceId,
    })
  }

  return NextResponse.json({ skill: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { id } = await params

  const { data: existing } = await supabase
    .from('recipe')
    .select('is_system, workspace_id')
    .eq('id', id)
    .single()

  if (existing?.is_system) return forbidden('Cannot delete system skills')

  // count: 'exact' because recipe delete RLS (creator or owner/admin, migration
  // 191) skips a refused row without an error, which read as success.
  const { error, count } = await supabase
    .from('recipe')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  if (error) return serverError(error.message)
  if (!count) {
    return existing?.workspace_id === workspaceId
      ? forbidden('Only the skill’s author, or a workspace owner or admin, can delete it')
      : notFound('Skill not found')
  }

  // Fire-and-forget analytics (never blocks/fails the delete).
  trackServerEvent('recipe_deleted', { userId: user.id, workspaceId, email: user.email }, {
    category: 'skill',
    recipe_id: id,
    workspace_id: workspaceId,
  })

  return NextResponse.json({ success: true })
}
