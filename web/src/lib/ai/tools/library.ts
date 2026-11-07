import type { SupabaseClient } from '@supabase/supabase-js'
import { tool } from 'ai'
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
import { ensureUniqueSlug, normalizeSlug } from '@/lib/library/slug'
import { isRecipeVisibleTo, visibleRecipesFilter } from '@/lib/library/visibility'
import { isLivePlaybookConfig } from '@/lib/library/agent-config'
import { MAX_PLAYBOOK_BODY_CHARS } from '@/lib/live-agent/call-playbooks'
import {
  MAX_SKILL_TOOL_CATEGORIES,
  agentSkillConfig,
  validateToolCategories,
  widensSkillCeiling,
  withToolCategories,
  type SkillToolConfig,
} from '@/lib/flows/skill-tool-profile'
import {
  resolveCreateWorkspace,
  resolveEntityWorkspace,
  workspaceEcho,
  type CreateWorkspacePolicy,
} from './_shared'

/**
 * Skill authoring FROM CHAT — the tools behind the `/create-skill` system skill
 * (migration 225).
 *
 * "Save as skill" used to be a bespoke button: a hardcoded distiller route plus
 * its own dialog. That made skill-authoring the one workflow the assistant
 * couldn't perform, even though authoring a skill is exactly the kind of thing
 * a skill should do. Now the workflow IS a skill, and these are the tools it
 * calls — so the same capability is reachable by `/create-skill`, by asking in
 * plain language, and by any future skill that wants to compose on top of it.
 *
 * These mirror the MCP library tools (src/lib/mcp/tools/library.ts) but WRITES
 * are scoped to skills only — chat has no reason to author live-capture Agents
 * or Meeting Types, and a narrower surface keeps the tool descriptions sharp.
 *
 * READS are wider than that, deliberately. `list_agents` / `get_agent` mirror
 * `dial8_list_agents` / `dial8_get_agent` because a skill that grades an agent
 * has to be able to READ that agent's prompt: `/create-eval` (migration 253)
 * opens by reading the target recipe, and with no chat-side `get_agent` the
 * assistant burned a dozen `search_tools` calls hunting for one that didn't
 * exist, then wrote its cases against the catalog description instead of the
 * real prompt. Reading an agent is safe; authoring one still isn't offered
 * here, so the write scoping above stands.
 *
 * Two deliberate differences from the MCP versions:
 *   - Slug uniqueness goes through `ensureUniqueSlug`, which dodges collisions
 *     in the workspace AND system namespaces (a `/command` resolves against
 *     both) and auto-suffixes rather than erroring. The MCP tool only checks
 *     the workspace, so it can mint a slug that a system row already owns.
 *   - Creates default to visibility 'personal'. The user is right there in
 *     chat and can promote it, but nothing lands in front of the team because
 *     a model chose a default.
 *
 * Publishing to Discover (visibility 'public', which every Dial8 user sees) is
 * owner/admin only, as on the HTTP routes and over MCP: see {@link publishDenied}.
 *
 * create_skill and update_skill are ATTENDED ONLY (ATTENDED_ONLY_TOOL_NAMES in
 * src/lib/ai/tool-registry.ts). A skill is instructions the main agent later
 * loads and follows, so a run reading injected text (an email, a capture, a web
 * page) must never be able to save it as one. Only the main chat and the
 * person's own MCP connector hold them.
 *
 * Every read is scoped to what the CALLER may see, not just to this workspace.
 * The tool routes run these on the SERVICE client, where RLS never fires, so
 * `visibleRecipesFilter` (src/lib/library/visibility.ts) stands in for
 * `recipe_select_visibility`: another member's personal skill or agent is not
 * listed, read or editable here.
 *
 * `is_system` rows are never creatable or modifiable here: RLS on `recipe`
 * enforces it, and `fetchEditableSkill` rejects it before the write is
 * attempted so the model gets a clear message instead of a policy error.
 */

/**
 * `agent_config` is NOT model-writable (Sequence step 1, the D.1 lockdown): a
 * skill's tool limits and its contract keys (output_contract, preconditions,
 * capture_mode) are set in the Library UI through the HTTP routes, which
 * validate them against src/lib/library/agent-config.ts and gate contract
 * changes to owners/admins. The two schemas below are `.strict()` so a model
 * that still sends `agent_config` (or any unknown key) gets a validation
 * error it can read, not a silent drop.
 *
 * What a model MAY say is which tool categories the skill needs
 * (`tool_categories`, F1, src/lib/flows/skill-tool-profile.ts): validated
 * against the registry and stored as the skill's `enabled_tools`. Every skill
 * create_skill writes is marked `authored_by: 'agent'`, so one saved without
 * categories runs on reads and drafts only when a loop runs it in act mode.
 * update_skill may narrow a skill's categories freely; it refuses to WIDEN
 * them while an enabled act-mode loop runs the skill (switching that loop
 * back on shows the person the new tools on its card).
 */

type EditableSkill = {
  id: string
  is_system: boolean
  category: string
  workspace_id: string | null
  created_by: string | null
  visibility: string | null
}

export const SKILL_NOT_EDITABLE_ERROR =
  "Only the skill's creator or a workspace owner/admin can change it. Suggest the user ask its creator, or fork it from Personas."

/**
 * The caller's member role in `workspaceId`, read directly on the service
 * client. No member row reads as null: never an owner/admin.
 */
async function memberRole(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<string | null> {
  const { data } = await supabase
    .from('member')
    .select('role')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return (data as { role?: string | null } | null)?.role ?? null
}

/**
 * True when this write would publish a skill to Discover and the caller may
 * not. Owner/admin only, as on the HTTP routes (skills POST / PATCH) and MCP
 * (`publishDenied` in src/lib/mcp/tools/library.ts). The role is read in
 * `workspaceId`, the workspace the skill lands in (create) or lives in
 * (update), never the session's. Pass `current` on update: only the TRANSITION
 * to public is gated, so a creator re-saving an already-public skill is fine.
 */
async function publishDenied(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  visibility: string | undefined,
  current?: string | null,
): Promise<boolean> {
  return visibility === 'public' && current !== 'public' && !canPublishPublic(await memberRole(supabase, userId, workspaceId))
}

/** What create_skill / update_skill return when {@link publishDenied} says no. */
function publishForbidden() {
  return { success: false as const, error: PUBLISH_ROLE_ERROR, code: 'PUBLISH_FORBIDDEN' as const }
}

/**
 * Load a skill and confirm it's one this caller may edit. Rejects system
 * rows explicitly so the model reads "Cannot modify a system skill" rather
 * than an opaque RLS failure.
 *
 * `is_system` rows carry no `workspace_id` (mig 225) and that guard is checked
 * FIRST, before any workspace routing — a system row must always read "Cannot
 * modify a system skill", never "not found", regardless of which workspace is
 * active. A workspace-owned row is then routed like every other id-based
 * mutate via {@link resolveEntityWorkspace}: an id copied from another
 * workspace the caller belongs to still resolves, instead of silently 404ing
 * at the caller's UPDATE with an opaque DB error.
 *
 * These tools run on the SERVICE client, so neither `recipe_select_visibility`
 * nor migration 191's UPDATE policy fires; both are applied here. Another
 * member's personal skill is invisible, so it reads "Skill not found" exactly
 * like a bad id. A visible one is editable by its creator or a workspace
 * owner/admin, as the Library UI allows.
 */
async function fetchEditableSkill(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  strictWorkspace: boolean,
  id: string,
): Promise<{ ok: true; row: EditableSkill } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('recipe')
    .select('id, is_system, category, workspace_id, created_by, visibility')
    .eq('id', id)
    .single()

  if (error || !data) return { ok: false, error: 'Skill not found' }
  const row = data as EditableSkill
  if (row.category !== 'skill') return { ok: false, error: 'That item is not a skill' }
  if (row.is_system) {
    return {
      ok: false,
      error: 'Cannot modify a system skill. Suggest the user fork it from Personas instead.',
    }
  }

  const wsResolved = await resolveEntityWorkspace(supabase, userId, 'recipe', id, workspaceId, strictWorkspace)
  if (!wsResolved) return { ok: false, error: 'Skill not found' }
  const targetWs = wsResolved.workspaceId
  if (!isRecipeVisibleTo(row, targetWs, userId)) return { ok: false, error: 'Skill not found' }

  if (row.created_by !== userId && !canPublishPublic(await memberRole(supabase, userId, targetWs))) {
    return { ok: false, error: SKILL_NOT_EDITABLE_ERROR }
  }

  return { ok: true, row: { ...row, workspace_id: targetWs } }
}

/**
 * One value inside a PostgREST `or=(...)` group, made safe to interpolate.
 *
 * PostgREST splits that group on commas and reads parentheses as nesting, so a
 * bare needle like `Acme, Inc Sales Coach` turns one condition into four
 * malformed ones and the whole lookup comes back as a PGRST100 parse error
 * rather than a result. Double quotes make the value literal; the backslash and
 * quote escapes keep a name containing either from closing it early.
 */
export function orFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * `tool_categories` on create_skill / update_skill (F1,
 * src/lib/flows/skill-tool-profile.ts): which registry categories the skill
 * may use when a loop runs it in act mode.
 */
export const toolCategoriesSchema = z
  .array(z.string())
  .max(MAX_SKILL_TOOL_CATEGORIES)
  .optional()
  .describe(
    'The tool categories this skill needs when a loop runs it in act mode, by category id (e.g. "emails", "calendar", "documents", "actions", "contacts"). ' +
      'Omit it and the skill reads and drafts only (documents, drafts, claims, suggestions): it never changes the board or the CRM on its own. ' +
      'Name only what the playbook needs; switching on a loop that runs the skill shows the person these categories.',
  )

/**
 * `call_playbook` on create_skill / update_skill: the skill is a live call
 * playbook (agent_config.live_playbook, src/lib/live-agent/call-playbooks.ts).
 * The in-call copilot lists it on every call and follows its body on that kind
 * of call; the `/create-call-playbook` system skill interviews the person and
 * saves one with it. It is the one agent_config key a model may set: it adds
 * instructions and never widens a tool ceiling, so a playbook takes no
 * tool_categories. Any member may save one (a product decision, 2026-10-20):
 * the copilot fences the body as teammate-written text and caps its size.
 */
export const callPlaybookSchema = z
  .boolean()
  .optional()
  .describe(
    'true saves this skill as a LIVE CALL PLAYBOOK: the in-call copilot lists it (slug and description) on every call and follows its body on that kind of call. ' +
      `The body must be at most ${MAX_PLAYBOOK_BODY_CHARS} characters, and a playbook takes no tool_categories. ` +
      'A slug equal to a built-in playbook (investor-pitch, sales-call, discovery) replaces that built-in for whoever can see this skill. ' +
      'Use it only for a playbook the person built for their calls (the create-call-playbook skill walks it).',
  )

const CALL_PLAYBOOK_NO_TOOLS_ERROR =
  'tool_categories: refused, nothing saved. A call playbook is instructions only and takes no tools; drop tool_categories.'

/** The refusal for a playbook body over the cap, or null. Pure. */
export function callPlaybookBodyError(body: string): string | null {
  return body.length > MAX_PLAYBOOK_BODY_CHARS
    ? `system_prompt: refused, nothing saved. A call playbook rides every copilot turn, so its body is capped at ${MAX_PLAYBOOK_BODY_CHARS} characters (this one is ${body.length}). Tighten it and save again.`
    : null
}

/**
 * update_skill's `tool_categories`: a new list, or `[]` / `null` to reset the
 * skill to the agent-made default, reads and drafts only.
 */
export const toolCategoriesUpdateSchema = z
  .array(z.string())
  .max(MAX_SKILL_TOOL_CATEGORIES)
  .nullable()
  .optional()
  .describe(
    'Replace the tool categories this skill may use when a loop runs it in act mode (see create_skill); [] or null resets it to reads and drafts only. Narrowing is always fine; widening is refused while an enabled act-mode loop runs the skill.',
  )

/** An update's categories: undefined (unchanged), null (reset to reads and drafts), a validated list, or the refusal. */
export function parseCategoryUpdate(raw: readonly string[] | null | undefined): { categories: string[] | null } | { error: string } | undefined {
  if (raw === undefined) return undefined
  if (raw === null || raw.length === 0) return { categories: null }
  const checked = validateToolCategories(raw)
  return checked.ok ? { categories: checked.categories } : { error: checked.error }
}

/**
 * The agent_config an update_skill `tool_categories` writes, or a refusal: a
 * WIDENING (a tool the stored ceiling doesn't grant) while an enabled loop
 * runs the skill in act mode. Narrowing is always allowed. Shared with the MCP
 * twin (dial8_update_skill).
 */
export async function skillCategoryUpdate(
  supabase: SupabaseClient,
  workspaceId: string,
  skillId: string,
  /** The new categories, or null to reset to reads and drafts only (the agent-made default). */
  categories: readonly string[] | null,
): Promise<{ agentConfig: Record<string, unknown> } | { error: string }> {
  const { data: row, error: readError } = await supabase.from('recipe').select('agent_config').eq('id', skillId).maybeSingle()
  if (readError) return { error: 'Could not read the skill, so its tools were not changed. Try again.' }
  const stored = ((row as { agent_config?: unknown } | null)?.agent_config ?? null) as SkillToolConfig | null
  const next = categories === null ? toDraftingDefault(stored) : withToolCategories(stored, categories)
  if (widensSkillCeiling(stored, next as SkillToolConfig)) {
    const running = await enabledActLoopsRunning(supabase, workspaceId, skillId)
    if ('error' in running) return { error: 'Could not check the loops that run this skill, so its tools were not widened. Try again.' }
    if (running.names.length > 0) {
      return {
        error: `tool_categories: refused, nothing saved. This widens what the skill can use, and ${running.names.join(', ')} runs it in act mode right now. Switch that loop off first (update_flow enabled: false), save the categories, then switch it back on: the person sees the new tools on its card.`,
      }
    }
  }
  return { agentConfig: next }
}

/** The stored config reset to the agent-made default: reads and drafts only (no categories, the marker on). */
function toDraftingDefault(stored: unknown): Record<string, unknown> {
  const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {}
  delete base.enabled_tools
  return { ...base, authored_by: 'agent' }
}

/**
 * The enabled loops in the workspace that run this skill in act mode (their
 * quoted names), or an error when they could not be read (callers refuse:
 * fail closed). Shared by the tool-widening and the prompt-rewrite refusals.
 */
export async function enabledActLoopsRunning(
  supabase: SupabaseClient,
  workspaceId: string,
  skillId: string,
): Promise<{ names: string[] } | { error: string }> {
  const { data: flows, error } = await supabase.from('flow').select('id, name, actions').eq('workspace_id', workspaceId).eq('enabled', true)
  if (error) return { error: error.message }
  const running = ((flows ?? []) as Array<{ name: string | null; actions: unknown }>).filter((f) =>
    (Array.isArray(f.actions) ? (f.actions as Array<Record<string, unknown>>) : []).some((a) => {
      const config = (a?.config ?? {}) as { skill_id?: unknown; mode?: unknown }
      return a?.type === 'run_skill' && config.skill_id === skillId && config.mode === 'act'
    }),
  )
  return { names: running.map((f) => `"${f.name ?? 'a loop'}"`) }
}

/**
 * The refusal for rewriting a skill's prompt while an enabled act-mode loop
 * runs it (F1 review): the prompt is what the loop does (it is in the loop's
 * definition hash), and an on loop's change goes through the person's card.
 * Null when the rewrite may go ahead. Shared with dial8_update_skill.
 */
export async function skillPromptRewriteRefusal(
  supabase: SupabaseClient,
  workspaceId: string,
  skillId: string,
  systemPrompt: string,
): Promise<string | null> {
  const { data: row, error: readError } = await supabase.from('recipe').select('system_prompt').eq('id', skillId).maybeSingle()
  if (readError) return 'Could not read the skill, so its prompt was not changed. Try again.'
  if (((row as { system_prompt?: string | null } | null)?.system_prompt ?? '') === systemPrompt) return null
  const running = await enabledActLoopsRunning(supabase, workspaceId, skillId)
  if ('error' in running) return 'Could not check the loops that run this skill, so its prompt was not changed. Try again.'
  if (running.names.length === 0) return null
  return `system_prompt: refused, nothing saved. ${running.names.join(', ')} runs this skill in act mode right now, and its prompt is what that loop does. Switch the loop off first (update_flow enabled: false), save the new prompt, then switch it back on: the person approves the loop as it is now on its card.`
}

export function createLibraryTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
) {
  /**
   * System recipes this workspace must not see — a feature-owned system skill
   * (today only `/create-eval`) is invisible while its feature is off. ONE
   * settings read per tool call; the empty result leaves the query untouched.
   */
  const gatedRecipeIds = async (): Promise<string[]> =>
    featureGatedRecipeExclusions(await resolveWorkspaceEdition(supabase, workspaceId))

  return {
    list_skills: tool({
      description:
        'List the skills available in this workspace — both built-in system skills and the workspace\'s own. ' +
        'Skills are reusable chat presets the user invokes with a slash command (e.g. /weekly-planner). ' +
        'Returns a lightweight catalog (no prompts); call get_skill for the full system_prompt. ' +
        'Use this before creating a skill to check whether a similar one already exists.',
      inputSchema: z.object({
        mine_only: z
          .boolean()
          .optional()
          .describe('Only skills this user created. Excludes system skills.'),
      }),
      execute: async ({ mine_only }) => {
        let query = excludeFeatureGatedRecipes(
          supabase
            .from('recipe')
            .select(LIBRARY_LIST_FIELDS)
            .eq('category', 'skill')
            .or(visibleRecipesFilter(workspaceId, userId)),
          await gatedRecipeIds(),
        )

        if (mine_only) query = query.eq('created_by', userId).eq('is_system', false)

        const { data, error } = await query
          .order('is_system', { ascending: false })
          .order('sort_order', { ascending: true })

        if (error) return { success: false, error: error.message }
        return { success: true, skills: data || [], count: (data || []).length }
      },
    }),

    get_skill: tool({
      description:
        'Fetch one skill in full, including its system_prompt and agent_config. ' +
        'Use after list_skills to read an existing skill before editing it or modelling a new one on it.',
      inputSchema: z.object({
        id: z.string().describe('The skill UUID, from list_skills.'),
      }),
      execute: async ({ id }) => {
        // A gated system skill is NOT FOUND, not forbidden — the row is
        // invisible in this workspace, so it must read exactly like a bad id.
        if (isFeatureGatedRecipe(id, await gatedRecipeIds())) {
          return { success: false, error: 'Skill not found' }
        }

        const { data, error } = await supabase
          .from('recipe')
          .select(LIBRARY_ITEM_FIELDS)
          .eq('id', id)
          .eq('category', 'skill')
          .or(visibleRecipesFilter(workspaceId, userId))
          .single()

        if (error || !data) return { success: false, error: 'Skill not found' }
        return { success: true, skill: data }
      },
    }),

    // ── Agents (read-only) ─────────────────────────────────────────────
    // Live-capture agents. Chat can read them so a skill can grade or explain
    // one; authoring stays in Agents & Skills and the MCP surface.

    list_agents: tool({
      description:
        'List the live-meeting agents available in this workspace — both built-in system agents and the ' +
        'workspace\'s own. An agent is autonomous AI that listens during a capture and proposes actions, ' +
        'decisions and nudges (unlike a skill, which the user invokes in chat with a slash command). ' +
        'Returns a lightweight catalog (no prompts); call get_agent for the full system_prompt. ' +
        'Use get_agent to read a live-meeting agent\'s prompt; use get_skill for skills.',
      inputSchema: z.object({
        mine: z
          .boolean()
          .optional()
          .describe('Only agents this user created. Excludes system agents.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe('Cap the number of agents returned. Defaults to all of them.'),
      }),
      execute: async ({ mine, limit }) => {
        let query = excludeFeatureGatedRecipes(
          supabase
            .from('recipe')
            .select(LIBRARY_LIST_FIELDS)
            .eq('category', 'agent')
            .or(visibleRecipesFilter(workspaceId, userId)),
          await gatedRecipeIds(),
        )

        if (mine) query = query.eq('created_by', userId).eq('is_system', false)

        query = query
          .order('is_system', { ascending: false })
          .order('sort_order', { ascending: true })

        if (limit !== undefined) query = query.limit(limit)

        const { data, error } = await query

        if (error) return { success: false, error: error.message }
        return { success: true, agents: data || [], count: (data || []).length }
      },
    }),

    get_agent: tool({
      description:
        'Fetch one live-meeting agent in full, including its system_prompt, agent_config and model. ' +
        'Resolve by id from list_agents, or by name when the user named one. ' +
        'Use this to read what an agent was actually told to do before grading, explaining or copying it. ' +
        'This reads AGENTS only — for a chat skill (a slash command) use get_skill instead.',
      inputSchema: z.object({
        id: z.string().optional().describe('The agent UUID, from list_agents.'),
        name: z
          .string()
          .optional()
          .describe('The agent name or slug, matched case-insensitively. Used when no id is given.'),
      }),
      execute: async ({ id, name }) => {
        if (!id && !name) {
          return { success: false, error: 'Pass either an agent id or a name — call list_agents first.' }
        }

        const visible = visibleRecipesFilter(workspaceId, userId)
        const gated = await gatedRecipeIds()

        if (id) {
          // A gated system agent reads as not found, same as get_skill.
          const { data, error } = isFeatureGatedRecipe(id, gated)
            ? { data: null, error: null }
            : await supabase
                .from('recipe')
                .select(LIBRARY_ITEM_FIELDS)
                .eq('id', id)
                .eq('category', 'agent')
                .or(visible)
                .single()

          if (error || !data) {
            return {
              success: false,
              error:
                'Agent not found. This looks up AGENTS (live-meeting) only — if that id is a chat skill, ' +
                'call get_skill instead, or list_agents to see what agents exist.',
            }
          }
          return { success: true, agent: data }
        }

        // Name lookup: match either the display name or the slug, case-insensitively.
        const needle = (name as string).trim()
        const { data, error } = await excludeFeatureGatedRecipes(
          supabase
            .from('recipe')
            .select(LIBRARY_ITEM_FIELDS)
            .eq('category', 'agent')
            .or(visible)
            .or(`name.ilike.${orFilterValue(needle)},slug.ilike.${orFilterValue(needle)}`),
          gated,
        )
          .order('is_system', { ascending: false })
          .limit(2)

        // Never the raw driver message: it leaks the filter's shape and tells
        // the model nothing it can act on.
        if (error) return { success: false, error: 'Could not look up that agent by name. Try list_agents and pass an id.' }
        const rows = (data || []) as Array<Record<string, unknown>>
        if (rows.length === 0) {
          return {
            success: false,
            error:
              `No AGENT named "${needle}". This looks up live-meeting agents only — if that is a chat skill, ` +
              'call get_skill instead, or list_agents to see what agents exist.',
          }
        }
        return {
          success: true,
          agent: rows[0],
          ...(rows.length > 1
            ? { note: `More than one agent matches "${needle}" — returned the first. Pass an id to disambiguate.` }
            : {}),
        }
      },
    }),

    create_skill: tool({
      description:
        'Save a new skill in this workspace. A skill is a reusable playbook the user can re-invoke as a ' +
        'slash command. Use this to turn an approach that just worked in this conversation — or one the ' +
        'user describes — into something they can run again. ' +
        'Defaults to personal visibility. Always show the user the name, description and prompt and get ' +
        'their confirmation before calling this.',
      inputSchema: z.object({
        name: z
          .string()
          .describe('Short imperative title, e.g. "Draft release notes". No trailing punctuation.'),
        description: z
          .string()
          .describe(
            'The ROUTING HINT: one sentence (≤200 chars) stating WHEN this skill applies, e.g. "When the ' +
              'user wants to turn a meeting into a customer follow-up email". Chat reads this line alone to ' +
              'decide whether to load the skill, so describe the trigger, not the mechanics.',
          ),
        system_prompt: z
          .string()
          .describe(
            'The reusable playbook, in markdown, written as second-person standing instructions. ' +
              'Generalize: keep the step structure that worked but replace this run\'s specific names, dates, ' +
              'IDs and pasted contents with descriptive placeholders like [meeting title].',
          ),
        slug: z
          .string()
          .optional()
          .describe('Slash-command slug, e.g. "release-notes". Derived from the name when omitted.'),
        icon: z.string().optional().describe('A single emoji.'),
        color: z.string().optional().describe('Hex color, e.g. "#3b82f6".'),
        visibility: z
          .enum(['personal', 'workspace', 'public'])
          .optional()
          .describe(
            'Defaults to "personal". Only widen this when the user explicitly asks to share it. ' +
              '"public" publishes to Discover, which only a workspace owner or admin can do.',
          ),
        tool_categories: toolCategoriesSchema,
        call_playbook: callPlaybookSchema,
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.',
          ),
      }).strict(),
      execute: async ({ name, description, system_prompt, slug, icon, color, visibility, tool_categories, call_playbook, workspace_id }) => {
        let categories: string[] | undefined
        if (tool_categories !== undefined) {
          const checked = validateToolCategories(tool_categories)
          if (!checked.ok) return { success: false, error: checked.error }
          categories = checked.categories
        }
        if (call_playbook) {
          if (categories?.length) return { success: false, error: CALL_PLAYBOOK_NO_TOOLS_ERROR }
          const tooLong = callPlaybookBodyError(system_prompt)
          if (tooLong) return { success: false, error: tooLong }
        }
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId
        if (await publishDenied(supabase, userId, targetWs, visibility)) return publishForbidden()

        const trimmedName = name.trim()
        if (!trimmedName) return { success: false, error: 'Name is required' }
        if (!system_prompt.trim()) return { success: false, error: 'A system_prompt is required' }

        // Normalize whatever the model proposed, then let ensureUniqueSlug
        // resolve collisions across BOTH namespaces (in the TARGET workspace)
        // by suffixing.
        const base = slug ? normalizeSlug(slug) : generateSlug(trimmedName)
        const slugError = validateSlug(base)
        if (slugError) return { success: false, error: slugError }

        const finalSlug = await ensureUniqueSlug(supabase, targetWs, base)
        if (!finalSlug) return { success: false, error: 'Could not derive a valid slug from that name' }

        const insert: Record<string, unknown> = {
          workspace_id: targetWs,
          name: trimmedName,
          description,
          system_prompt,
          slug: finalSlug,
          category: 'skill',
          is_system: false,
          visibility: visibility || 'personal',
          created_by: userId,
          // The agent wrote it: its categories, or reads and drafts only. A
          // call playbook carries the flag the copilot lists it by.
          agent_config: call_playbook ? { ...agentSkillConfig(undefined), live_playbook: true } : agentSkillConfig(categories),
        }
        if (icon !== undefined) insert.icon = icon
        if (color !== undefined) insert.color = color

        const { data, error } = await supabase
          .from('recipe')
          .insert(insert)
          .select(LIBRARY_ITEM_FIELDS)
          .single()

        if (error) return { success: false, error: error.message }
        return {
          success: true,
          skill: data,
          // Surface the slug that actually landed — ensureUniqueSlug may have
          // suffixed it, and the model should tell the user the real command.
          command: `/${finalSlug}`,
          message: call_playbook
            ? `Saved as the live call playbook "${finalSlug}". The copilot lists it on every call from now on and loads it when a call fits; naming this kind of call in the call goal makes it start with it. Edit it under Personas.`
            : `Saved. The user can now run it with /${finalSlug}, or find it under Personas.`,
          ...workspaceEcho(targetWs, ws.workspaceName),
        }
      },
    }),

    update_skill: tool({
      description:
        'Update an existing custom skill. Only the fields you pass change. System skills cannot be edited — ' +
        'fork them from Personas first. Use get_skill to read the current prompt before rewriting it.',
      inputSchema: z.object({
        id: z.string().describe('The skill UUID, from list_skills.'),
        name: z.string().optional(),
        description: z.string().optional().describe('The routing hint — see create_skill.'),
        system_prompt: z.string().optional(),
        slug: z.string().optional(),
        icon: z.string().optional(),
        color: z.string().optional(),
        visibility: z
          .enum(['personal', 'workspace', 'public'])
          .optional()
          .describe('"public" publishes to Discover, which only a workspace owner or admin can do.'),
        tool_categories: toolCategoriesUpdateSchema,
        call_playbook: z
          .boolean()
          .optional()
          .describe('true makes this skill a live call playbook (see create_skill), false stops it being one. Omit it to leave that unchanged.'),
      }).strict(),
      execute: async ({ id, name, description, system_prompt, slug, icon, color, visibility, tool_categories, call_playbook }) => {
        const parsedCategories = parseCategoryUpdate(tool_categories)
        if (parsedCategories && 'error' in parsedCategories) return { success: false, error: parsedCategories.error }
        const categories = parsedCategories?.categories
        const guard = await fetchEditableSkill(supabase, userId, workspaceId, strictWorkspace, id)
        if (!guard.ok) return { success: false, error: guard.error }
        // Non-null: fetchEditableSkill only returns ok:true after resolveEntityWorkspace succeeded.
        const targetWs = guard.row.workspace_id as string
        if (await publishDenied(supabase, userId, targetWs, visibility, guard.row.visibility)) return publishForbidden()

        const updates: Record<string, unknown> = {}
        if (name !== undefined) updates.name = name.trim()
        if (description !== undefined) updates.description = description
        if (system_prompt !== undefined) updates.system_prompt = system_prompt
        if (icon !== undefined) updates.icon = icon
        if (color !== undefined) updates.color = color
        if (visibility !== undefined) updates.visibility = visibility

        if (categories !== undefined) {
          const ceiling = await skillCategoryUpdate(supabase, targetWs, id, categories)
          if ('error' in ceiling) return { success: false, error: ceiling.error }
          updates.agent_config = ceiling.agentConfig
        }
        // A call playbook: the flag, no tools, and the body cap,
        // checked against the prompt it will have after this save.
        if (call_playbook !== undefined || system_prompt !== undefined || categories !== undefined) {
          const { data: storedRow, error: storedError } = await supabase
            .from('recipe')
            .select('agent_config, system_prompt')
            .eq('id', id)
            .maybeSingle()
          if (storedError) return { success: false, error: 'Could not read the skill, so nothing was saved. Try again.' }
          const stored = (storedRow as { agent_config?: unknown; system_prompt?: string | null } | null) ?? null
          const storedConfig = (stored?.agent_config ?? null) as Record<string, unknown> | null
          const playbook = call_playbook ?? isLivePlaybookConfig(storedConfig)
          if (playbook) {
            if (categories?.length) return { success: false, error: CALL_PLAYBOOK_NO_TOOLS_ERROR }
            const tooLong = callPlaybookBodyError(system_prompt ?? stored?.system_prompt ?? '')
            if (tooLong) return { success: false, error: tooLong }
          }
          if (call_playbook !== undefined) {
            const base = { ...((updates.agent_config as Record<string, unknown> | undefined) ?? storedConfig ?? {}) }
            // A playbook takes no tools: a skill that becomes one drops its
            // categories (a narrowing, so always allowed), as create_skill refuses them.
            if (call_playbook) delete base.enabled_tools
            updates.agent_config = { ...base, live_playbook: call_playbook }
          }
        }
        // The prompt is what a loop that runs the skill does (F1 review).
        if (system_prompt !== undefined) {
          const refused = await skillPromptRewriteRefusal(supabase, targetWs, id, system_prompt)
          if (refused) return { success: false, error: refused }
        }

        if (slug !== undefined) {
          const base = normalizeSlug(slug)
          const slugError = validateSlug(base)
          if (slugError) return { success: false, error: slugError }
          updates.slug = await ensureUniqueSlug(supabase, targetWs, base, id)
        }

        if (Object.keys(updates).length === 0) {
          return { success: false, error: 'Nothing to update — pass at least one field' }
        }

        const { data, error } = await supabase
          .from('recipe')
          .update(updates)
          .eq('id', id)
          .eq('workspace_id', targetWs)
          .select(LIBRARY_ITEM_FIELDS)
          .single()

        if (error) return { success: false, error: error.message }
        return { success: true, skill: data }
      },
    }),
  }
}
