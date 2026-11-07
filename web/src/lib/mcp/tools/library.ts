import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { featureGatedRecipeExclusions, resolveWorkspaceEdition } from '@/lib/editions'
import { excludeFeatureGatedRecipes, isFeatureGatedRecipe } from '@/lib/library/feature-gate'
import {
  LIBRARY_ITEM_FIELDS,
  LIBRARY_LIST_FIELDS,
  PUBLISH_ROLE_ERROR,
  canPublishPublic,
  generateSlug,
  validateSlug,
} from '@/lib/library/queries'
import type { LibraryCategory } from '@/lib/types/library'
import { BOT_CHARACTER_ORDER, isBotCharacterType } from '@/lib/bots/teammate-faces'
import {
  PERSONAL_AGENT_BOT_ERROR,
  PERSONAL_WITH_BOTS_ERROR,
  agentBotFace,
  agentGetsABot,
  agentInUseMessage,
  makeAgentTeammate,
  releaseAgentBots,
  skillsErrorMessage,
} from '@/lib/library/agent-bot'
import { agentHasBots } from '@/lib/agents/agent-bots'
import { isRecipeVisibleTo, visibleRecipesFilter } from '@/lib/library/visibility'
import { withActiveWorkspace } from './envelope'
import {
  parseCategoryUpdate,
  skillCategoryUpdate,
  skillPromptRewriteRefusal,
  toolCategoriesSchema,
  toolCategoriesUpdateSchema,
} from '@/lib/ai/tools/library'
import { agentSkillConfig, validateToolCategories } from '@/lib/flows/skill-tool-profile'
import { AGENT_FACE_RESERVED_ERROR, agentFaceRefused } from '@/lib/bots/agent-face'

/**
 * MCP tools for managing Skills, Agents, and Meeting Types over the wire.
 *
 * Lets external Claude / OpenAI clients (Claude Desktop, Claude Code, the
 * OpenAI Responses API, etc.) list and author Dial8 library items as if
 * they were local. A user can say "Claude, create a skill in Dial8 that
 * summarizes my Friday status report" and have it land in their workspace.
 *
 * Underlying storage is the `recipe` table (kept that name for blast-radius
 * reasons — see migration 104). All three categories live in one table
 * discriminated by the `category` enum.
 *
 * Defaults important to safety:
 *   - Create operations default to visibility='personal' so MCP clients
 *     don't accidentally publish to the team. Users can promote to
 *     'workspace' or 'public' from the Library UI afterward.
 *   - created_by is always stamped from the MCP-authenticated user.
 *   - is_system rows can never be created or modified through MCP — the
 *     RLS policy on `recipe` already enforces this, but we also reject
 *     attempts to clear the flag.
 *   - agent_config is NOT settable over MCP (Sequence step 1, the D.1
 *     lockdown): a model must never widen a skill's tools or flip its
 *     contract keys (output_contract, preconditions, capture_mode). Both
 *     skill tools reject the field outright with AGENT_CONFIG_LOCKED; the
 *     Library UI (the HTTP routes) is the only writer.
 *   - The server runs on the SERVICE ROLE, so migration 191's row policy never
 *     fires here. fetchEditable re-applies it: update/delete only by the row's
 *     creator or a workspace owner/admin, and only within the active workspace.
 *     Publishing to Discover (visibility='public') is owner/admin only, as on
 *     the HTTP routes.
 *
 * Tool naming follows the dial8_<verb>_<noun> convention used elsewhere
 * (dial8_list_skills, dial8_create_agent, etc.) — three separate verb
 * sets per category rather than one generic library tool. Three explicit
 * tools are more discoverable for the LLM than one polymorphic one with a
 * required `category` argument.
 */

// ────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────

const VisibilitySchema = z.enum(['personal', 'workspace', 'public']).optional().describe(
  'Sharing scope. Defaults to "personal" so accidental MCP-driven creation never publishes to the team. Promote via the Library UI.',
)

/** Wrap an error message as an MCP error response. */
function fail(message: string, code?: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, code }, null, 2) }],
    isError: true,
  }
}

/**
 * System recipes this workspace must not see — a feature-owned system skill
 * (today only `/create-eval`) stays invisible while its feature is off. ONE
 * settings read per call; an empty result leaves the query untouched.
 */
async function gatedRecipeIds(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string[]> {
  return featureGatedRecipeExclusions(await resolveWorkspaceEdition(supabase, workspaceId))
}

/**
 * List items of one category visible to the caller. Returns system items
 * (workspace_id IS NULL) plus the workspace's own items the caller can see:
 * shared ones and their own personal ones, never another member's personal
 * item (src/lib/library/visibility.ts — this server is on the service role).
 *
 * Uses LIBRARY_LIST_FIELDS (lightweight catalog subset) — system_prompt,
 * agent_config, and extraction_config are intentionally excluded. Callers
 * who need the full record should follow up with dial8_get_<category>.
 * Without this split, a 20-item list would dump ~thousands of tokens of
 * system prompts into the agent's context just for browsing.
 */
async function listByCategory(
  supabase: SupabaseClient,
  workspaceId: string,
  category: LibraryCategory,
  opts: { mine_only?: boolean; user_id: string },
) {
  let query = excludeFeatureGatedRecipes(
    supabase
      .from('recipe')
      .select(LIBRARY_LIST_FIELDS)
      .or(visibleRecipesFilter(workspaceId, opts.user_id))
      .eq('category', category),
    await gatedRecipeIds(supabase, workspaceId),
  )

  if (opts.mine_only) {
    query = query.eq('created_by', opts.user_id).eq('is_system', false)
  }

  return query
    .order('is_system', { ascending: false })
    .order('sort_order', { ascending: true })
}

type EditableRow = {
  id: string
  is_system: boolean
  category: string
  workspace_id: string
  created_by: string | null
  visibility: string | null
}
type EditableResult =
  | { ok: true; row: EditableRow }
  | { ok: false; error: string }

/** The caller as the edit rules see it: who, where, and their member role there. */
type Caller = { userId: string; workspaceId: string; role: string | null }

export const AGENT_CONFIG_LOCKED_ERROR =
  'agent_config cannot be set over MCP. Tool limits and contract settings (output_contract, preconditions, capture_mode) are set in the Library UI by a workspace owner or admin.'

export const MCP_NOT_EDITABLE_ERROR = 'Only the creator or a workspace owner/admin can modify this item'

/**
 * Block edits/deletes against system items, items outside the active
 * workspace, and items the caller may not touch. The MCP server runs on the
 * SERVICE ROLE, so migration 191's UPDATE/DELETE policy ("members their own,
 * owners/admins all") never runs for these tools — this is that rule applied
 * in code (Sequence step 1, the D.1 lockdown). The visibility rule comes
 * first, as RLS would apply it: another member's personal item reads "Not
 * found", even to an owner/admin.
 */
async function fetchEditable(
  supabase: SupabaseClient,
  id: string,
  category: LibraryCategory,
  caller: Caller,
): Promise<EditableResult> {
  const { data, error } = await supabase
    .from('recipe')
    .select('id, is_system, category, workspace_id, created_by, visibility')
    .eq('id', id)
    .single()

  if (error || !data) return { ok: false, error: 'Not found' }
  if (data.category !== category) return { ok: false, error: `Not a ${category}` }
  if (data.is_system) return { ok: false, error: `Cannot modify system ${category}` }
  // recipe_select_visibility, which RLS would apply before 191's policy: another
  // member's personal item is not there for this caller, owner/admin included.
  if (!isRecipeVisibleTo(data, caller.workspaceId, caller.userId)) return { ok: false, error: 'Not found' }
  if (data.created_by !== caller.userId && !canPublishPublic(caller.role)) {
    return { ok: false, error: MCP_NOT_EDITABLE_ERROR }
  }
  return { ok: true, row: data as EditableRow }
}

// ────────────────────────────────────────────────────────────────
// Registration
// ────────────────────────────────────────────────────────────────

export function registerLibraryTools(
  server: McpServer,
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  workspaceName?: string | null,
) {
  /**
   * Wrap a result object as a text MCP response, stamped with `active_workspace`.
   *
   * These tools are hand-registered, so the adapter loop in ./index.ts — which
   * stamps every BRIDGED result — never sees them; without this they were the
   * only results in the catalog that didn't name their workspace. Same helper,
   * same shape, so a caller can't tell how a tool was registered. `fail` is
   * untouched: error payloads keep their exact existing text.
   */
  const active = { id: workspaceId, name: workspaceName ?? null }
  const ok = (payload: unknown) => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify(withActiveWorkspace(payload, active), null, 2),
    }],
  })

  /**
   * The caller's member role in the active workspace, read once per call that
   * needs it. The service-role client sees the membership row directly; no
   * row → treated as a plain member (never as an admin).
   */
  let cachedRole: string | null | undefined
  const memberRole = async (): Promise<string | null> => {
    if (cachedRole !== undefined) return cachedRole
    const { data } = await supabase
      .from('member')
      .select('role')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    cachedRole = (data?.role as string | null | undefined) ?? null
    return cachedRole
  }
  const caller = async (): Promise<Caller> => ({ userId, workspaceId, role: await memberRole() })
  /**
   * Publishing to Discover is platform-wide: owner/admin only, as on the HTTP
   * routes. On update only the TRANSITION to public is gated (an already-public
   * row re-saved by its creator is fine).
   */
  const publishDenied = async (visibility: string | undefined, current?: string | null) =>
    visibility === 'public' && current !== 'public' && !canPublishPublic(await memberRole())

  // ──────────────── Skills ────────────────

  server.tool(
    'dial8_list_skills',
    'List Skills available in the active workspace. Skills are chat-invoked AI presets — the user activates one with a slash command (e.g. /weekly-planner) and the chat picks up its system prompt and tool config. Returns both system Skills and the workspace\'s custom Skills. Lightweight catalog only (id, name, description, icon, slug, visibility, fork count) — call dial8_get_skill with an id to fetch the full system_prompt and agent_config.',
    {
      mine_only: z.boolean().optional().describe('If true, only return Skills the authenticated user created.'),
    },
    async ({ mine_only }) => {
      const { data, error } = await listByCategory(supabase, workspaceId, 'skill', {
        mine_only,
        user_id: userId,
      })
      if (error) return fail(error.message)
      return ok({ skills: data || [] })
    },
  )

  server.tool(
    'dial8_get_skill',
    'Fetch a single Skill by ID — returns the full record including system_prompt and agent_config. Use dial8_list_skills first to discover IDs.',
    {
      id: z.string().describe('The Skill UUID.'),
    },
    async ({ id }) => {
      // A gated system skill is NOT FOUND, not forbidden — it is invisible in
      // this workspace, so it must read exactly like a bad id.
      if (isFeatureGatedRecipe(id, await gatedRecipeIds(supabase, workspaceId))) {
        return fail('Skill not found')
      }
      const { data, error } = await supabase
        .from('recipe')
        .select(LIBRARY_ITEM_FIELDS)
        .eq('id', id)
        .eq('category', 'skill')
        .or(visibleRecipesFilter(workspaceId, userId))
        .single()
      if (error || !data) return fail('Skill not found')
      return ok({ skill: data })
    },
  )

  server.tool(
    'dial8_create_skill',
    'Create a new Skill in the active workspace. Defaults to visibility="personal" so it doesn\'t auto-publish to the team. Skills require a slug — a URL-friendly identifier used for slash-command invocation (auto-generated from name if not provided). Reserved slugs: clear, reset, help.',
    {
      name: z.string().describe('Display name, e.g. "Weekly Planner".'),
      description: z.string().optional().describe('Short one-liner explaining what this Skill does.'),
      system_prompt: z.string().describe('The system prompt that defines the Skill\'s persona and behavior.'),
      slug: z.string().optional().describe('Slash-command slug, e.g. "weekly-planner". Auto-generated from name if omitted.'),
      icon: z.string().optional().describe('Optional emoji or icon string.'),
      color: z.string().optional().describe('Optional hex color, e.g. "#3b82f6".'),
      agent_config: z.unknown().optional().describe('Not settable over MCP — rejected if present. Tool limits and contract settings are set in the Library UI by a workspace owner/admin.'),
      visibility: VisibilitySchema,
      tool_categories: toolCategoriesSchema,
    },
    async ({ name, description, system_prompt, slug, icon, color, agent_config, visibility, tool_categories }) => {
      if (agent_config !== undefined) return fail(AGENT_CONFIG_LOCKED_ERROR, 'AGENT_CONFIG_LOCKED')
      // The categories it needs (F1), or reads and drafts only: skill-tool-profile.ts.
      const categories = tool_categories === undefined ? undefined : validateToolCategories(tool_categories)
      if (categories && !categories.ok) return fail(categories.error, 'INVALID_TOOL_CATEGORIES')
      if (await publishDenied(visibility)) return fail(PUBLISH_ROLE_ERROR, 'PUBLISH_FORBIDDEN')
      const trimmedName = name.trim()
      if (!trimmedName) return fail('Name is required', 'INVALID_NAME')

      const finalSlug = slug ? String(slug).trim() : generateSlug(trimmedName)
      const slugError = validateSlug(finalSlug)
      if (slugError) return fail(slugError, 'INVALID_SLUG')

      // Uniqueness check within workspace
      const { data: existing } = await supabase
        .from('recipe')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('slug', finalSlug)
        .limit(1)
      if (existing && existing.length > 0) {
        return fail(`Slug "${finalSlug}" is already in use`, 'SLUG_TAKEN')
      }

      const insert: Record<string, unknown> = {
        workspace_id: workspaceId,
        name: trimmedName,
        system_prompt: system_prompt || '',
        is_system: false,
        category: 'skill',
        visibility: visibility || 'personal', // MCP default: personal
        created_by: userId,
        slug: finalSlug,
        agent_config: agentSkillConfig(categories?.ok ? categories.categories : undefined),
      }
      if (icon !== undefined) insert.icon = icon
      if (color !== undefined) insert.color = color
      if (description !== undefined) insert.description = description

      const { data, error } = await supabase
        .from('recipe')
        .insert(insert)
        .select(LIBRARY_ITEM_FIELDS)
        .single()
      if (error) return fail(error.message)
      return ok({ skill: data })
    },
  )

  server.tool(
    'dial8_update_skill',
    'Update a Skill\'s fields. Cannot modify system Skills. Only fields you pass are updated.',
    {
      id: z.string().describe('The Skill UUID.'),
      name: z.string().optional(),
      description: z.string().optional(),
      system_prompt: z.string().optional(),
      slug: z.string().optional().describe('New slug. Must be unique within workspace.'),
      icon: z.string().optional(),
      color: z.string().optional(),
      agent_config: z.unknown().optional().describe('Not settable over MCP — rejected if present. Tool limits and contract settings are set in the Library UI by a workspace owner/admin.'),
      visibility: VisibilitySchema,
      tool_categories: toolCategoriesUpdateSchema,
    },
    async ({ id, name, description, system_prompt, slug, icon, color, agent_config, visibility, tool_categories }) => {
      if (agent_config !== undefined) return fail(AGENT_CONFIG_LOCKED_ERROR, 'AGENT_CONFIG_LOCKED')
      const categories = parseCategoryUpdate(tool_categories)
      if (categories && 'error' in categories) return fail(categories.error, 'INVALID_TOOL_CATEGORIES')
      const guard = await fetchEditable(supabase, id, 'skill', await caller())
      if (!guard.ok) return fail(guard.error, 'NOT_EDITABLE')
      if (await publishDenied(visibility, guard.row.visibility)) return fail(PUBLISH_ROLE_ERROR, 'PUBLISH_FORBIDDEN')

      const updates: Record<string, unknown> = {}
      if (categories) {
        const ceiling = await skillCategoryUpdate(supabase, workspaceId, id, categories.categories)
        if ('error' in ceiling) return fail(ceiling.error, 'TOOL_CATEGORIES_REFUSED')
        updates.agent_config = ceiling.agentConfig
      }
      // The prompt is what a loop that runs the skill does (F1 review).
      if (system_prompt !== undefined) {
        const refused = await skillPromptRewriteRefusal(supabase, workspaceId, id, system_prompt)
        if (refused) return fail(refused, 'SKILL_IN_USE')
      }
      if (name !== undefined) updates.name = name
      if (description !== undefined) updates.description = description
      if (system_prompt !== undefined) updates.system_prompt = system_prompt
      if (icon !== undefined) updates.icon = icon
      if (color !== undefined) updates.color = color
      if (visibility !== undefined) updates.visibility = visibility

      if (slug !== undefined) {
        const finalSlug = String(slug).trim()
        const slugError = validateSlug(finalSlug)
        if (slugError) return fail(slugError, 'INVALID_SLUG')
        const { data: conflict } = await supabase
          .from('recipe')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('slug', finalSlug)
          .neq('id', id)
          .limit(1)
        if (conflict && conflict.length > 0) return fail(`Slug "${finalSlug}" is already in use`, 'SLUG_TAKEN')
        updates.slug = finalSlug
      }

      const { data, error } = await supabase
        .from('recipe')
        .update(updates)
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .select(LIBRARY_ITEM_FIELDS)
        .single()
      if (error) return fail(error.message)
      return ok({ skill: data })
    },
  )

  server.tool(
    'dial8_delete_skill',
    'Delete a custom Skill. Cannot delete system Skills.',
    {
      id: z.string().describe('The Skill UUID.'),
    },
    async ({ id }) => {
      const guard = await fetchEditable(supabase, id, 'skill', await caller())
      if (!guard.ok) return fail(guard.error, 'NOT_DELETABLE')

      const { error } = await supabase
        .from('recipe')
        .delete()
        .eq('id', id)
        .eq('workspace_id', workspaceId)
      if (error) return fail(error.message)
      return ok({ success: true, deleted_id: id })
    },
  )

  // ──────────────── Agents ────────────────

  server.tool(
    'dial8_list_agents',
    'List Agents available in the active workspace. Agents are autonomous AI that run during a live capture — they listen to the transcript and propose changes (actions, decisions, etc.). The user picks which Agent is active when starting a recording. Returns both system Agents (e.g. "Project Manager") and custom workspace Agents. Lightweight catalog only (id, name, description, icon, visibility, fork count) — call dial8_get_agent with an id to fetch the full system_prompt and config.',
    {
      mine_only: z.boolean().optional().describe('If true, only return Agents the authenticated user created.'),
    },
    async ({ mine_only }) => {
      const { data, error } = await listByCategory(supabase, workspaceId, 'agent', {
        mine_only,
        user_id: userId,
      })
      if (error) return fail(error.message)
      return ok({ agents: data || [] })
    },
  )

  server.tool(
    'dial8_get_agent',
    'Fetch a single Agent by ID — returns the full record including system_prompt and model. Use dial8_list_agents first to discover IDs.',
    {
      id: z.string().describe('The Agent UUID.'),
    },
    async ({ id }) => {
      if (isFeatureGatedRecipe(id, await gatedRecipeIds(supabase, workspaceId))) {
        return fail('Agent not found')
      }
      const { data, error } = await supabase
        .from('recipe')
        .select(LIBRARY_ITEM_FIELDS)
        .eq('id', id)
        .eq('category', 'agent')
        .or(visibleRecipesFilter(workspaceId, userId))
        .single()
      if (error || !data) return fail('Agent not found')
      return ok({ agent: data })
    },
  )

  server.tool(
    'dial8_create_agent',
    'Create a new Agent in the active workspace. Defaults to visibility="personal". Agents do NOT use slugs (they\'re selected by ID from the live-capture picker). A shared agent (visibility "workspace" or "public") always gets its teammate, made with it (a full teammate for a workspace owner, admin or team lead, otherwise one that speaks for the agent and takes no assignments), on bot_character or, without one, the first character nobody in the workspace has. A personal agent has no teammate.',
    {
      name: z.string().describe('Display name, e.g. "Sales Coach".'),
      description: z.string().optional().describe('Short one-liner explaining what this Agent listens for and does.'),
      system_prompt: z.string().describe('The system prompt that defines the Agent\'s listening persona and proposal behavior during live captures.'),
      icon: z.string().optional(),
      color: z.string().optional(),
      model: z.string().optional().describe('Optional LLM model override.'),
      visibility: VisibilitySchema,
      bot_character: z
        .string()
        .optional()
        .describe(
          `Its teammate's character: one of ${BOT_CHARACTER_ORDER.join(', ')}, or a built character's id. Omit for the first free one. Only for a shared agent.`,
        ),
    },
    async ({ name, description, system_prompt, icon, color, model, visibility, bot_character }) => {
      if (await publishDenied(visibility)) return fail(PUBLISH_ROLE_ERROR, 'PUBLISH_FORBIDDEN')
      const trimmedName = name.trim()
      if (!trimmedName) return fail('Name is required', 'INVALID_NAME')
      if (bot_character !== undefined && !isBotCharacterType(bot_character)) {
        return fail('bot_character must be one of the characters, or a built character\'s id', 'INVALID_BOT_CHARACTER')
      }
      // One face: the assistant's own face is never a new agent's bot's.
      if (agentFaceRefused(bot_character)) return fail(AGENT_FACE_RESERVED_ERROR, 'INVALID_BOT_CHARACTER')
      if (bot_character !== undefined && (visibility || 'personal') === 'personal') {
        return fail(PERSONAL_AGENT_BOT_ERROR, 'PERSONAL_AGENT_BOT')
      }

      const insert: Record<string, unknown> = {
        workspace_id: workspaceId,
        name: trimmedName,
        system_prompt: system_prompt || '',
        is_system: false,
        category: 'agent',
        visibility: visibility || 'personal',
        created_by: userId,
      }
      if (icon !== undefined) insert.icon = icon
      if (color !== undefined) insert.color = color
      if (description !== undefined) insert.description = description
      if (model !== undefined) insert.model = model || null

      const { data, error } = await supabase
        .from('recipe')
        .insert(insert)
        .select(LIBRARY_ITEM_FIELDS)
        .single()
      if (error) return fail(error.message)
      // Every shared agent gets its bot (bots-v4 B1).
      if (agentGetsABot(data.visibility)) {
        // The server is on the service role: makeAgentTeammate does its own role checks.
        const made = await makeAgentTeammate(supabase, {
          workspaceId,
          userId,
          agent: { id: data.id, name: data.name ?? trimmedName },
          character: await agentBotFace(supabase, workspaceId, bot_character),
        })
        if ('error' in made) return ok({ agent: data, bot_error: made.error })
        return ok({
          agent: data,
          ai_team_member: made.teammate,
          bot_kind: made.kind,
          ...(made.skillsError ? { skills_error: skillsErrorMessage(made.skillsError) } : {}),
        })
      }
      return ok({ agent: data })
    },
  )

  server.tool(
    'dial8_update_agent',
    'Update an Agent\'s fields. Cannot modify system Agents.',
    {
      id: z.string().describe('The Agent UUID.'),
      name: z.string().optional(),
      description: z.string().optional(),
      system_prompt: z.string().optional(),
      icon: z.string().optional(),
      color: z.string().optional(),
      model: z.string().optional(),
      visibility: VisibilitySchema,
    },
    async ({ id, name, description, system_prompt, icon, color, model, visibility }) => {
      const guard = await fetchEditable(supabase, id, 'agent', await caller())
      if (!guard.ok) return fail(guard.error, 'NOT_EDITABLE')
      if (await publishDenied(visibility, guard.row.visibility)) return fail(PUBLISH_ROLE_ERROR, 'PUBLISH_FORBIDDEN')
      // A personal agent has no bot (bots-v4 B1): one with bots stays shared.
      if (visibility === 'personal' && guard.row.visibility !== 'personal') {
        const hasBots = await agentHasBots(supabase, { workspaceId, agentId: id }).catch(() => null)
        if (hasBots === null) return fail('Could not check the persona’s agents')
        if (hasBots) return fail(PERSONAL_WITH_BOTS_ERROR, 'AGENT_HAS_BOTS')
      }

      const updates: Record<string, unknown> = {}
      if (name !== undefined) updates.name = name
      if (description !== undefined) updates.description = description
      if (system_prompt !== undefined) updates.system_prompt = system_prompt
      if (icon !== undefined) updates.icon = icon
      if (color !== undefined) updates.color = color
      if (model !== undefined) updates.model = model || null
      if (visibility !== undefined) updates.visibility = visibility

      const { data, error } = await supabase
        .from('recipe')
        .update(updates)
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .select(LIBRARY_ITEM_FIELDS)
        .single()
      if (error) return fail(error.message)
      return ok({ agent: data })
    },
  )

  server.tool(
    'dial8_delete_agent',
    'Delete a custom Agent. Cannot delete system Agents.',
    {
      id: z.string().describe('The Agent UUID.'),
    },
    async ({ id }) => {
      const who = await caller()
      const guard = await fetchEditable(supabase, id, 'agent', who)
      if (!guard.ok) return fail(guard.error, 'NOT_DELETABLE')

      // Its bots go with it; a full teammate built on it is refused, by name (agent-bot.ts).
      const released = await releaseAgentBots(supabase, {
        workspaceId,
        agentId: id,
        userId,
        elevated: canPublishPublic(who.role),
      })
      if (!released.ok) return fail(released.message, released.code)

      const { error } = await supabase
        .from('recipe')
        .delete()
        .eq('id', id)
        .eq('workspace_id', workspaceId)
      if (error) return fail(agentInUseMessage(error) ?? error.message, agentInUseMessage(error) ? 'AGENT_IN_USE' : undefined)
      return ok({ success: true, deleted_id: id })
    },
  )

}
