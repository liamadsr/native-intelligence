/**
 * POST /api/account/agents/[id]/copy — "Make a copy for this bot"
 * (docs/plans/bots-v4.md, Phase B1, decision 11).
 *
 * Copies the agent into this workspace as a new agent the caller authors: its
 * instructions, description, tool tree, model, icon and colour, shared with
 * the workspace (a bot's persona must be: a personal agent has no bot), with
 * `forked_from` naming the original, as the marketplace's fork route does.
 * No slug (a role persona's `role-<role>` slug stays its own) and no bot: the
 * editor points the bot it was opened on at the copy next, through that bot's
 * own route (ai-members for a full teammate, work-bots for a work bot), and
 * deletes the copy again if that's refused. The bot keeps its skills.
 *
 * Any member may copy an agent they can read that is this workspace's own or
 * a built-in one (any member may make an agent, migration 191). Body:
 * `{ name? }`, default "<name> (copy)".
 *
 * Its tool tree goes through the one definition of `agent_config`
 * (agent-config.ts parseAgentConfig), as every other write of one does: the
 * keys it may hold, each of the right shape. A key only a built-in agent's
 * seed knows (Meeting's `preferred_tools`) stays behind; a config that doesn't
 * parse isn't copied (400).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, notFound, serverError } from '@/lib/api-errors'
import { trackServerEvent } from '@/lib/posthog'
import { LIBRARY_ITEM_FIELDS } from '@/lib/library/queries'
import { personaKindOf } from '@/lib/agents/editable-fields'
import { agentConfigSchema, parseAgentConfig, type ParseAgentConfigResult } from '@/lib/library/agent-config'

const NAME_MAX = 120

/** The original's config as its copy carries it: the keys an agent_config may hold, parsed. */
function copiedConfig(raw: unknown): ParseAgentConfigResult {
  if (raw === null || raw === undefined) return { ok: true, config: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return parseAgentConfig(raw)
  const known = Object.entries(raw as Record<string, unknown>).filter(([key]) => key in agentConfigSchema.shape)
  return parseAgentConfig(Object.fromEntries(known))
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null

  // The original, as the caller may read it (RLS): another member's personal agent and the anchors read as missing.
  const { data: source, error: sourceError } = await supabase
    .from('recipe')
    .select('id, name, icon, color, description, system_prompt, agent_config, model, category, is_system, workspace_id')
    .eq('id', id)
    .maybeSingle()
  if (sourceError) return serverError(sourceError.message)
  const original = source as {
    name: string
    icon: string | null
    color: string | null
    description: string | null
    system_prompt: string | null
    agent_config: Record<string, unknown> | null
    model: string | null
    category: string
    is_system: boolean | null
    workspace_id: string | null
  } | null
  if (!original || original.category !== 'agent' || personaKindOf(original, workspaceId) === 'anchor') {
    return notFound('Agent not found')
  }

  const config = copiedConfig(original.agent_config)
  if (!config.ok) {
    return apiError(`This agent’s tool settings can’t be copied: ${config.error}`, { status: 400, code: config.code })
  }

  const asked = typeof body?.name === 'string' ? body.name.trim() : ''
  const name = (asked || `${original.name} (copy)`).slice(0, NAME_MAX)

  const { data, error } = await supabase
    .from('recipe')
    .insert({
      workspace_id: workspaceId,
      name,
      icon: original.icon,
      color: original.color,
      description: original.description,
      system_prompt: original.system_prompt ?? '',
      agent_config: config.config,
      model: original.model,
      category: 'agent',
      is_system: false,
      visibility: 'workspace',
      created_by: user.id,
      forked_from: id,
    })
    .select(LIBRARY_ITEM_FIELDS)
    .single()
  if (error || !data) return serverError(error?.message ?? 'Could not copy the agent')

  trackServerEvent('recipe_created', { userId: user.id, workspaceId, email: user.email }, {
    category: 'agent',
    visibility: 'workspace',
    recipe_id: (data as { id: string }).id,
    workspace_id: workspaceId,
    copied_from: id,
  })
  return NextResponse.json({ agent: data }, { status: 201 })
}
