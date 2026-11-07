/**
 * The live meeting agent's READ tool allowlist — names only, NO heavy imports.
 *
 * This module is deliberately dependency-free (no `createTools`, no server-only
 * code). It's the single source of truth for WHICH tools the live agent may read,
 * shared by:
 *   - the cloud route (server) → `buildLiveAgentReadTools` in read-tools.ts maps
 *     these names to actual tool objects from `createTools`.
 *   - the capture panel (CLIENT) and the eve live-agent tool proxy.
 *
 * Keeping the names here (not in read-tools.ts) is what keeps the client bundle
 * clean: read-tools.ts pulls in `createTools`, which transitively imports
 * server-only modules (next/headers via admin.ts). A client file importing the
 * NAMES must not drag that whole chain into the browser bundle. The only import
 * allowed here is the equally dependency-free tool-registry (category → names).
 *
 * Curation policy: a tool is in the allowlist ONLY if it performs no workspace
 * mutation and no external side effect. That excludes every create_/update_/
 * delete_/complete_/confirm_/dismiss_/archive_ tool, the claim write tools, the
 * email SEND/DRAFT tools, and calendar/flow writers. When in doubt we EXCLUDE —
 * a missing read is a smaller failure than an unintended write slipping through.
 */

import { getToolNamesForCategories, ALL_CATEGORY_IDS } from '@/lib/ai/tool-registry'
export const LIVE_AGENT_READ_TOOLS: ReadonlySet<string> = new Set<string>([
  // Search / semantic
  'find',
  'search',
  'deep_search',
  'search_claims',
  // Captures
  'list_captures',
  'list_recent_captures',
  'list_contact_captures',
  'get_capture_content',
  'get_capture_transcript',
  'get_capture_extractions',
  // Actions
  'list_actions',
  'get_action',
  'get_action_suggestions',
  'list_labels',
  'list_workspace_members',
  'list_workflow_states',
  // Projects / milestones
  'list_projects',
  'get_project_context',
  'list_milestones',
  // Initiatives
  'list_initiatives',
  'get_initiative',
  // Cycles
  'list_cycles',
  'get_cycle',
  // Documents
  'list_documents',
  'get_document',
  'read_canon',
  'list_action_documents',
  // Decisions
  'list_decisions',
  // Emails (read-only — NOT create_email_draft / generate_email_drafts)
  'list_emails',
  'read_email',
  'get_email_summary',
  'get_email_drafts',
  // Contacts / CRM (companies read-only — NOT create_company / update_company)
  'list_contacts',
  'get_contact',
  'get_contact_details',
  'list_companies',
  // Campaigns read-only — NOT create_campaign / update_campaign.
  'list_campaigns',
  'get_company_overview',
  // Calendar (read-only — NOT create/update/delete event, NOT sync)
  'get_calendar_events',
  'get_upcoming_meetings',
  'get_meeting_prep',
  // Attachments
  'list_attachments',
  'get_attachment_content',
  'read_chat_file',
  // Comments
  'list_comments',
  'get_comment_replies',
  // Dashboard / notifications
  'get_dashboard_summary',
  'get_notifications',
  // Flows (inspect only — NOT create/update/delete)
  'list_flows',
  'list_flow_runs',
  // Knowledge graph (read-only — NOT create/confirm/link/ingest/package writes)
  'list_claims',
  'get_claim',
  'traverse',
  'get_context_bundle',
  'list_entity_links',
  'list_packages',
  'get_package',
  // Sequences (read-only — NOT create/update/enroll/remove; and launch has no
  // tool at all, by design)
  'list_sequences',
  'get_sequence',
  // Library (read-only)
  'list_recipes',
])

/**
 * A small set of read tools to expose in the INITIAL `activeTools` (cloud route),
 * so common lookups don't cost a `search_tools` round-trip on every meeting. The
 * rest of the read surface is discovered on demand.
 */
export const LIVE_AGENT_CORE_READ_TOOLS: readonly string[] = [
  'find',
  'search',
  'deep_search',
  'list_actions',
  'list_projects',
  'list_workspace_members',
  'list_labels',
]

/** The enabled/disabled tool selection carried on a library item's agent_config. */
export interface AgentToolSelection {
  enabled_tools?: string[] | null
  disabled_tools?: string[] | null
  /**
   * ASSIST-ONLY LIVE MODE. `'assist_only'` splits the two jobs a capture agent
   * used to do at once: this agent helps the user IN the conversation and never
   * writes the record. See `AgentConfig.capture_mode` in src/lib/types/library.ts
   * for the canonical doc; it is restated on this client-safe type because every
   * live runtime (cloud route, eve live-agent, capture panel) reads the
   * flag through `AgentToolSelection`, not through the heavier library type.
   */
  capture_mode?: string | null
}

/**
 * The BUILT-IN Assistant's selection — the persona a turn runs when no recipe
 * row resolves (no recipe_id, no edition default, or the assist-only safety net
 * fell all the way back). It is not a row anyone edits, so the D.1 rule that a
 * persona row's NULL agent_config is core-only does not apply to it: it keeps
 * every read tool, exactly as the chat default assistant (no agent) inherits
 * all. Callers pass `personaToolSelection(recipe)` so the two cases — "no
 * persona" and "a persona with no selection" — never collapse into one.
 */
export const BUILTIN_ASSISTANT_TOOL_SELECTION: AgentToolSelection = Object.freeze({
  enabled_tools: [...ALL_CATEGORY_IDS],
  disabled_tools: [],
})

/**
 * The tool selection to narrow a live turn by: the resolved persona row's own
 * agent_config (null → core-only, per the D.1 lockdown), or the built-in
 * Assistant's inherit-all selection when NO persona row resolved.
 */
export function personaToolSelection(
  recipe: { agent_config?: AgentToolSelection | null } | null | undefined,
): AgentToolSelection | null {
  if (!recipe) return BUILTIN_ASSISTANT_TOOL_SELECTION
  return recipe.agent_config ?? null
}

/**
 * The capture tools an ASSIST-ONLY live agent must NOT be given.
 *
 * Every one of them writes the RECORD — the summary, the proposal queue, the
 * capture's own title. An assist-only agent's whole contract is that the record
 * is written later, in one pass, by the post-call batch agent; a live agent that
 * could stage even one proposal would put the two writers back in the same
 * capture and reintroduce exactly the duplication this split removes.
 *
 * Deliberately NOT a narrowing of `enabled_tools`: that mechanism scopes READ
 * categories, and these are the staging tools, which `narrowReadToolsByAgent`
 * never touches. This set is applied to the staging half directly.
 *
 * `say_to_user` and `ask_user` are absent on purpose — they ARE the assist-only
 * agent's output channel. So is the entire read surface: help is only as good as
 * the grounding behind it.
 */
export const ASSIST_ONLY_EXCLUDED_TOOLS: ReadonlySet<string> = new Set<string>([
  'write_summary',
  'update_summary',
  'propose_change',
  'record_commitment',
  'edit_proposal',
  'dismiss_proposal',
  'propose_mcp_call',
  'set_capture_title',
])

/**
 * True when an agent_config declares the ASSIST-ONLY live contract.
 *
 * Fail-CLOSED on the flag itself (an unreadable config is a normal note-taking
 * agent, i.e. today's behavior) and tolerant of shape: the value is read from a
 * jsonb column that no schema constrains, so anything that is not the exact
 * string is treated as "not assist-only" rather than throwing.
 */
export function isAssistOnlyAgent(
  agentConfig: AgentToolSelection | null | undefined,
): boolean {
  return agentConfig?.capture_mode === 'assist_only'
}

/**
 * The staging tools withheld from a PAIRED NOTE-TAKER — the second live agent
 * that runs beside an assist-only copilot (live route `live_role: 'notes'`).
 *
 * The mirror image of ASSIST_ONLY_EXCLUDED_TOOLS: the copilot keeps only the
 * tools that TALK, the note-taker keeps only the tools that WRITE. Two agents
 * on one call must not both have the user's ear — a note-taker that could also
 * say_to_user would double every nudge and contradict the copilot mid-call —
 * so its talk channel is removed from the tools MAP, not just from the prompt.
 * `ask_user` goes with it for the same reason: one pending question at a time
 * is the chat's contract, and the copilot owns it.
 */
export const LIVE_NOTES_EXCLUDED_TOOLS: ReadonlySet<string> = new Set<string>([
  'say_to_user',
  'ask_user',
])

/**
 * The staging tools ONLY an assist-only copilot turn holds: the inverse of
 * ASSIST_ONLY_EXCLUDED_TOOLS. `direct_notes` hands the note-taker something the
 * user asked the copilot to record (live-agent messaging L2). A turn that
 * writes the record itself (a note-taking live agent, the paired note-taker,
 * the batch pass) records it directly, so it never holds the relay.
 */
export const PAIRED_COPILOT_ONLY_TOOLS: ReadonlySet<string> = new Set<string>(['direct_notes'])

/**
 * The staging tools only a COPILOT turn holds, assist-only or not: `load_skill`
 * picks the call's playbook (call-playbooks.ts), which says what to tell the
 * person. The paired note-taker and the batch pass talk to no one, so they
 * never hold it.
 */
export const LIVE_COPILOT_ONLY_TOOLS: ReadonlySet<string> = new Set<string>(['load_skill'])

/**
 * True when an agent_config imposes NO tool restriction (canonical semantics).
 *
 * Inherit-all is EXACTLY three cases — kept in lockstep with computeToolCeiling
 * / toClaudeAllowedTools so every runtime draws the boundary at the same place:
 *   (a) the config is null/undefined, OR
 *   (b) the `enabled_tools` KEY is absent/undefined (null counts), AND nothing
 *       is disabled — a legacy row that never carried a selection, OR
 *   (c) every ALL_CATEGORY_IDS entry is enabled AND nothing is disabled — the
 *       editor's "everything on" state, which the UI writes as full arrays.
 *
 * The load-bearing distinction: a `enabled_tools` PRESENT as an array — INCLUDING
 * `[]` — is NOT inherit-all. `[]` means "core/essentials-only" (the user
 * explicitly stripped every category), so it falls through to narrowing, matching
 * computeToolCeiling's fall-through to CORE_TOOL_NAMES. Only key-absence, not an
 * empty array, restores inherit-all.
 *
 * NO LIVE BEHAVIOR CHANGE (verified 2026-07-12): zero prod/dev agent/skill rows
 * carry `enabled_tools: []` today, so tightening `[]` from inherit-all to
 * core/essentials-only across every runtime (this helper, narrowReadToolsByAgent,
 * and the chat ceiling derivations) changes nothing live — it only closes the empty-selection
 * inversion where an agent stripped of every tool was silently granted the full
 * surface. The editor always writes full category arrays, so users can still
 * express both extremes (inherit-all via all-on; core-only via all-off).
 */
export function agentInheritsAllTools(
  agentConfig: AgentToolSelection | null | undefined,
): boolean {
  // Sequence step 1 (the D.1 lockdown): a null config and an absent/null
  // `enabled_tools` key are NOT inherit-all any more. They read exactly like
  // `[]` — core-only — on every runtime, matching computeToolCeiling. Only an
  // explicit every-category-on selection with nothing disabled inherits all.
  const enabledArr = agentConfig?.enabled_tools ?? []
  const disabled = agentConfig?.disabled_tools ?? []
  const allEnabled = ALL_CATEGORY_IDS.every((id) => enabledArr.includes(id))
  return allEnabled && disabled.length === 0
}

/**
 * Narrow a live-agent READ surface by the selected agent's tool selection.
 *
 * Semantics (Phase 3 — every runtime honors the agent's tool boundary):
 *   - The agent ceiling can only ever NARROW `readTools`, never widen it. The
 *     staging/propose (write) tools are gated SEPARATELY and are never passed in
 *     here — they stay ungated (see the call sites).
 *   - INHERIT-ALL (agentInheritsAllTools — canonical semantics): config
 *     null/undefined, or the `enabled_tools` key absent with nothing disabled, or
 *     every category enabled with nothing disabled → `readTools` is returned
 *     unchanged (a fresh copy), exactly the pre-Phase-3 behavior. This mirrors
 *     computeToolCeiling's inherit-all short-circuit, kept here as a client-safe
 *     (no `ai`/`zod`) reimplementation.
 *   - Otherwise (a scoped selection — including a present-but-empty
 *     `enabled_tools: []`, which narrows to the empty read surface) the agent
 *     ceiling is the tools its enabled categories expand to, minus its disabled
 *     tools; the result is `readTools ∩ ceiling`. Only READ tools that the
 *     agent's categories actually include survive.
 *
 * Note: unlike computeToolCeiling this does NOT seed CORE_TOOL_NAMES — the read
 * intersection is a strict narrowing, so an agent that selects a subset of
 * categories gets exactly that subset of reads (any CORE read tool it wants must
 * come from a category it enabled). Returns a plain Set of bare tool names.
 */
export function narrowReadToolsByAgent(
  agentConfig: AgentToolSelection | null | undefined,
  readTools: ReadonlySet<string>,
): Set<string> {
  // Inherit-all → no narrowing. Only an explicit every-category-on selection is
  // inherit-all (see agentInheritsAllTools); everything else narrows.
  if (agentInheritsAllTools(agentConfig)) {
    return new Set(readTools)
  }

  const enabled = agentConfig?.enabled_tools ?? []
  const disabled = agentConfig?.disabled_tools ?? []

  // Expand the enabled categories to bare tool names, drop the disabled ones,
  // then intersect with the read surface. `getToolNamesForCategories` passes
  // through unknown ids (raw tool names from older configs) unchanged, so an
  // agent_config that stored tool names directly still narrows correctly.
  const disabledSet = new Set(disabled)
  const agentTools = new Set(
    getToolNamesForCategories(enabled).filter((name) => !disabledSet.has(name)),
  )
  // An EMPTY selection — null config, absent key, or [] — is core-only, never
  // nothing: the live core reads (LIVE_AGENT_CORE_READ_TOOLS) are the seed,
  // the way computeToolCeiling seeds CORE_TOOL_NAMES. A scoped (non-empty)
  // selection stays a strict narrowing: exactly the categories it enabled.
  if (enabled.length === 0) {
    for (const name of LIVE_AGENT_CORE_READ_TOOLS) {
      if (!disabledSet.has(name)) agentTools.add(name)
    }
  }
  const out = new Set<string>()
  for (const name of readTools) {
    if (agentTools.has(name)) out.add(name)
  }
  return out
}

/**
 * The name prefix of a connected app's tool (`mcp__<server>__<tool>`,
 * src/lib/mcp-client/adapter.ts namespacedToolName). On a live turn, such a
 * name is callable ONLY when it is in the turn's read-only lookup catalog
 * (./mcp-lookups.ts); the prefix alone never grants anything.
 */
export const LIVE_MCP_TOOL_PREFIX = 'mcp__'
