import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { trackServerEvent } from '@/lib/posthog'
import {
  LIBRARY_ITEM_FIELDS,
  PUBLISH_ROLE_ERROR,
  canPublishPublic,
  validateSlug,
} from '@/lib/library/queries'
import { ensureUniqueSlug, normalizeSlug } from '@/lib/library/slug'
import { applyAgentConfigUpdate } from '@/lib/library/agent-config'
import { PERSONAL_WITH_BOTS_ERROR, agentInUseMessage, releaseAgentBots } from '@/lib/library/agent-bot'
import { getServiceClient } from '@/lib/supabase/service'
import { personaKindOf, personaRule } from '@/lib/agents/editable-fields'
import { listAgentBots } from '@/lib/agents/agent-bots'

/**
 * One agent, scoped exactly like the list: the system agents plus this
 * workspace's own. The chat panel reads it to pin a live-capture
 * conversation's persona (fetchAgentOption), so the chat talks as the agent
 * that is listening in on the call.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params

  const { data, error } = await supabase
    .from('recipe')
    .select(LIBRARY_ITEM_FIELDS)
    .eq('id', id)
    .eq('category', 'agent')
    .or(`is_system.eq.true,workspace_id.eq.${workspaceId}`)
    .maybeSingle()

  if (error) return serverError(error.message)
  if (!data) return notFound('Agent not found')
  return NextResponse.json({ agent: data })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth

  const { id } = await params

  // `visibility` is fetched so a transition TO 'public' can also emit
  // `recipe_published` after the write.
  const { data: existing } = await supabase
    .from('recipe')
    .select('is_system, category, visibility, slug, agent_config, created_by, workspace_id')
    .eq('id', id)
    .single()

  if (existing?.is_system) return forbidden('Cannot edit system agents')
  if (existing?.category !== 'agent') return badRequest('Not an agent')

  // The recipe's rule (migration 191), said plainly instead of an UPDATE RLS
  // filters to nothing: its author, or a workspace owner or admin. The agent's
  // instructions and tools are shared by every bot on it (bots-v4 decision 11).
  const personaKind = personaKindOf(existing, workspaceId)
  if (personaKind === 'anchor') return notFound('Agent not found')
  const rule = personaRule({ kind: personaKind, createdBy: existing.created_by ?? null }, { userId: user.id, role: member.role })
  if (!rule.editable) return forbidden(rule.reason)

  const body = await request.json()

  // A personal agent has no bot (agent-bot.ts): one with bots stays shared.
  if (body.visibility === 'personal' && existing.visibility !== 'personal') {
    const bots = await listAgentBots(getServiceClient(), { workspaceId, agentId: id }).catch(() => null)
    if (bots === null) return serverError('Could not check the persona’s agents')
    if (bots.length > 0) return apiError(PERSONAL_WITH_BOTS_ERROR, { status: 409, code: 'AGENT_HAS_BOTS' })
  }

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
  if (body.model !== undefined) updates.model = body.model || null
  if (body.visibility !== undefined) updates.visibility = body.visibility
  // The agent's tool allowlist (enabled_tools/disabled_tools), validated
  // without stripping; capture_mode (and the other contract keys) are carried
  // over when omitted and may only CHANGE for an owner/admin (Sequence step 1).
  if (body.agent_config !== undefined) {
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

  // Slug handling parallels skills: agents aren't slash-invoked so the editor
  // won't send one, but honor it defensively if supplied and only re-slug when
  // it's actually CHANGING (re-running uniqueness on the row's own slug would
  // suffix it against itself). A collision self-heals via suffix, no 409.
  if (body.slug !== undefined) {
    const requested = normalizeSlug(String(body.slug))
    if (requested !== (existing?.slug ?? '')) {
      const slugError = validateSlug(requested)
      if (slugError) return badRequest(slugError)
      updates.slug = await ensureUniqueSlug(supabase, workspaceId, requested, id)
    }
  }

  // is_default: only one default agent per workspace
  if (body.is_default === true) {
    await supabase
      .from('recipe')
      .update({ is_default: false })
      .eq('workspace_id', workspaceId)
      .eq('category', 'agent')
      .eq('is_default', true)
    updates.is_default = true
  } else if (body.is_default === false) {
    updates.is_default = false
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
    category: 'agent',
    visibility: data.visibility,
    recipe_id: id,
    workspace_id: workspaceId,
  })
  if (data.visibility === 'public' && existing?.visibility !== 'public') {
    trackServerEvent('recipe_published', { userId: user.id, workspaceId, email: user.email }, {
      category: 'agent',
      recipe_id: id,
      workspace_id: workspaceId,
    })
  }

  return NextResponse.json({ agent: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth

  const { id } = await params

  const { data: existing } = await supabase
    .from('recipe')
    .select('is_system, created_by, workspace_id')
    .eq('id', id)
    .maybeSingle()

  if (existing?.is_system) return forbidden('Cannot delete system agents')
  if (!existing || existing.workspace_id !== workspaceId) return notFound('Agent not found')
  // RLS's rule (migration 191), checked here because its bots go first.
  const elevated = canPublishPublic(member.role)
  if (existing.created_by !== user.id && !elevated) {
    return forbidden('Only the agent’s author, or a workspace owner or admin, can delete it')
  }

  // Its teammates are built on it (ON DELETE RESTRICT): its bots go with it,
  // and a full teammate is a readable 409 (bots-v3 Phase 6, agent-bot.ts).
  const released = await releaseAgentBots(getServiceClient(), { workspaceId, agentId: id, userId: user.id, elevated })
  if (!released.ok) return apiError(released.message, { status: released.status, code: released.code })

  const { error } = await supabase
    .from('recipe')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  if (error) {
    const inUse = agentInUseMessage(error)
    return inUse ? apiError(inUse, { status: 409, code: 'AGENT_IN_USE' }) : serverError(error.message)
  }

  // Fire-and-forget analytics (never blocks/fails the delete).
  trackServerEvent('recipe_deleted', { userId: user.id, workspaceId, email: user.email }, {
    category: 'agent',
    recipe_id: id,
    workspace_id: workspaceId,
  })

  return NextResponse.json({ success: true })
}
