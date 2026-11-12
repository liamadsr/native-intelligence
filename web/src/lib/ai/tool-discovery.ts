/**
 * Provider-agnostic tool discovery for AI chat.
 *
 * Instead of sending all 86+ tools on every request, we expose a small set of
 * core tools plus a `search_tools` meta-tool. The model calls `search_tools`
 * to discover additional tools, and `prepareStep` dynamically expands
 * `activeTools` to include them.
 *
 * Works with any LLM provider — Anthropic, OpenAI, Google, etc.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { TOOL_CATEGORIES, getToolNamesForCategories, ALL_CATEGORY_IDS, ALL_TOOL_NAMES } from './tool-registry'
import type { MentionRecordKind } from '@/lib/search/menu-search'

/** Fast membership test: is this name an actual registered tool (vs a category id)? */
const TOOL_NAME_SET = new Set<string>(ALL_TOOL_NAMES)

// CORE_TOOL_NAMES and computeToolCeiling live in ./tool-ceiling-core, which
// imports neither `ai` nor `zod`. They are re-exported here so every existing
// server-side import of this module keeps working unchanged; the split exists
// purely so `@/lib/editions` — which the nav rail and calendar pull into the
// CLIENT bundle — can reach the ceiling without dragging the AI SDK with it.
export { CORE_TOOL_NAMES, computeToolCeiling } from './tool-ceiling-core'
import { CORE_TOOL_NAMES } from './tool-ceiling-core'

/**
 * Capability tools that are ALWAYS on, for every agent, regardless of any tool
 * allowlist. Today that is `web_search` (Exa, provider-executed — see
 * ./tools/web-search.ts).
 *
 * Deliberately SEPARATE from CORE_TOOL_NAMES, and deliberately NOT in
 * tool-registry.ts, for two reasons:
 *
 *   1. Web access is a capability, not a permission. It has no registry entry,
 *      no TOOL_CATEGORIES row and no editions manifest entry, so an agent's
 *      allowlist can neither grant nor revoke it.
 *   2. COLLISION GUARD. CORE_TOOL_NAMES feeds the eve spec builders'
 *      `coreToolNames` (src/lib/chat/chat-run-rebuild.ts) and, via
 *      computeToolCeiling, their `ceilingTools`. eve's resolver turns every
 *      such name into a workspace PROXY tool — and eve already has a NATIVE
 *      provider-executed tool called `web_search`. A proxy of the same name
 *      would shadow the real thing. Keeping this list out of CORE_TOOL_NAMES is
 *      what keeps the eve specs clean; the guard test lives in
 *      __tests__/web-search-spec-collision.test.ts.
 *
 * `pickPermittedTools` and `createPrepareStep` both honor this set, so the tool
 * survives a narrow agent ceiling and is active from step one without a
 * search_tools round-trip.
 */
export const ALWAYS_ON_CAPABILITY_TOOL_NAMES: string[] = ['web_search']

/** Fast membership test for the always-on capability tools. */
const ALWAYS_ON_CAPABILITY_SET = new Set(ALWAYS_ON_CAPABILITY_TOOL_NAMES)

/**
 * Tools seeded into the active set for a turn ONLY when the user @-mentioned a
 * contact (`systemContext.attachedContactIds`). Not in CORE_TOOL_NAMES — they
 * are per-turn additions so a person-anchored question can be answered without
 * a search_tools round-trip. Both runtimes (cloud route + eve spec rebuild)
 * apply the same list, still subject to the agent ceiling.
 */
export const PERSON_MENTION_TOOL_NAMES: string[] = [
  'get_contact_details',
  'list_contact_captures',
  'get_meeting_prep',
]

/**
 * Tools seeded into the active set for a turn ONLY when the user @-mentioned a
 * company (`systemContext.attachedCompanyIds`). Same posture as
 * PERSON_MENTION_TOOL_NAMES: per-turn additions so a company-anchored question
 * (or a follow-up about one of its people) can be answered without a
 * search_tools round-trip; still subject to the agent ceiling in both runtimes.
 */
export const COMPANY_MENTION_TOOL_NAMES: string[] = [
  'get_company_overview',
  'get_contact_details',
  'list_contact_captures',
  'get_meeting_prep',
]

/**
 * The tool that reads each record kind a turn can @-mention by id
 * (`systemContext.attachedActionIds`… as MENTION_RECORD_KEYS names them; §6h
 * names the tool on each record's line). Seeded only for the kinds present,
 * still subject to the agent ceiling.
 */
export const RECORD_MENTION_TOOL_NAMES = {
  action: ['get_action'],
  document: ['get_document'],
  project: ['get_project_context'],
  initiative: ['get_initiative'],
  deal: ['get_deal'],
  flow: ['list_flows'],
  attachment: ['get_attachment_content'],
  calendar_event: ['get_calendar_events'],
  studio_video: ['get_studio_video'],
} as const satisfies Record<MentionRecordKind, readonly string[]>

/**
 * The agent's browser tools, seeded into the active set on every turn: the
 * browser runs in the person's cloud sandbox (docs/plans/cloud-browser.md), so a
 * web, phone or SMS turn can use it as well as the desktop. Still fenced by the
 * edition ceiling (the `browser` opt-in feature): on a workspace without that
 * feature these names are dropped by the ceiling, so the seed is a no-op.
 * `wait_for_browser_command` is the pending-result poll for the slow ones.
 */
export const BROWSER_TOOL_NAMES: string[] = [
  'read_browser_page',
  'get_browser_text',
  'screenshot_browser',
  'open_browser',
  'close_browser',
  'wait_for_browser_command',
  'run_browser_task',
]

/**
 * Tools seeded into the active set for a turn ONLY during a live meeting
 * (`systemContext.liveCaptureId`): the meeting chat's line to the note-taker
 * (live-agent messaging L2). Still fenced by the ceiling, like the mention sets.
 */
export const LIVE_MEETING_TOOL_NAMES: string[] = ['tell_note_taker']

/**
 * Tools seeded into the active set for a turn ONLY when the person uploaded
 * files with it (`systemContext.chatFiles`): read_chat_file reads a text file
 * and shows the model a photo (a photo never rides the message itself: an eve
 * file part starts a sandbox). Still fenced by the ceiling, like the mention sets.
 */
export const CHAT_FILE_TOOL_NAMES: string[] = ['read_chat_file']

/**
 * Tools the MAIN chat advertises up front on every turn (not a teammate chat):
 * `remember`, so a preference the person states can be saved the moment they
 * state it (one-agent plan Part 3, "Memory"), and `update_now`, the person's
 * Now file (docs/plans/now-file.md), so the tool list stays the same from turn
 * to turn whether or not the note changes. Not in CORE_TOOL_NAMES: that set
 * seeds every runtime's ceiling, and both are attended-only. Still fenced by
 * the ceiling, like the mention sets.
 */
export const MAIN_CHAT_MEMORY_TOOL_NAMES: string[] = ['remember', 'update_now']

/**
 * Tools seeded into the active set for a turn ONLY when the chat has cards on
 * screen (`systemContext.cards`): read_card reads the rows a card shows the
 * person now. Still fenced by the ceiling, like the mention sets.
 */
export const CARD_TOOL_NAMES: string[] = ['read_card']

/**
 * Tools seeded into the active set for a turn ONLY when the person's message
 * talks about a goal for a meeting ("the goal of my 2:30 is to close the
 * pilot": mentionsMeetingGoal over the turn's route excerpt), so the goal is
 * saved without a search_tools round trip first. The model finds the meeting
 * with get_calendar_events (core). Still fenced by the ceiling, like the
 * mention sets.
 */
export const MEETING_GOAL_TOOL_NAMES: string[] = ['set_meeting_goal']

/**
 * Seeded into the active set for a chat turn whose workspace has canon
 * documents (the registry is in the prompt, canon D1): the agent reads one by
 * key without a search_tools round trip first. Still fenced by the ceiling.
 */
export const CANON_TOOL_NAMES: string[] = ['read_canon']

/**
 * Seeded into the active set for a chat turn that can hold calls for the
 * person's approval (mcp_confirm_call is there) or carries a held call's
 * outcome (an `approval-…` turn-context section, GEN-1172): the agent reads
 * how one ended by its approval_id without a search_tools round trip first.
 * Still fenced by the ceiling.
 */
export const APPROVAL_RESULT_TOOL_NAMES: string[] = ['get_tool_approval_result']

/**
 * Bringing existing customers in (roadmap track G): seeded up front on a turn
 * that carries a contacts file or asks to import or undo one. Still fenced by
 * the ceiling.
 */
export const CONTACT_IMPORT_TOOL_NAMES: string[] = ['read_contact_file', 'import_contact_file', 'import_stripe_customers', 'list_contact_imports', 'undo_contact_import']

const TEXTED_CONTACT_FILE = /\[They texted [^\]]*storage_path /
const CONTACT_FILE_PATH = /storage_path\s+\S+\.(?:csv|tsv|xlsx|vcf)\b/i
const IMPORT_ASK = /\b(?:import|undo (?:the |that |my )?import|bring (?:in|over))\b/i
const PEOPLE_WORD = /\b(?:customers?|clients?|contacts?|spreadsheet|csv|excel|list|audience|hubspot|brevo|stripe|quickbooks|square|jobber|housecall(?: pro)?|mailchimp|pipedrive)\b/i

/** Does a turn's text carry a contacts file, or ask to import (or undo an import of) people? Pure. */
export function mentionsContactImport(text: unknown): boolean {
  if (typeof text !== 'string') return false
  if (TEXTED_CONTACT_FILE.test(text) || CONTACT_FILE_PATH.test(text)) return true
  if (/\bundo (?:the |that |my )?import\b/i.test(text)) return true
  return IMPORT_ASK.test(text) && PEOPLE_WORD.test(text)
}

/** "my website", "the homepage", "my site", "github repo": the person's own site (roadmap track E). */
const WEBSITE_WORD = /\b(?:(?:my|our|the) (?:web ?site|site|home ?page|landing page)|website|homepage|github|repo(?:sitory)?)\b/i

/** Does a turn's text talk about the person's website (connect it, change it, undo a change)? Pure. */
export function mentionsWebsite(text: unknown): boolean {
  return typeof text === 'string' && WEBSITE_WORD.test(text)
}

const GOAL_WORD = /\b(?:goals?|objectives?|aim|outcome)\b/i
const MEETING_WORD = /\b(?:meetings?|calls?|syncs?|1:1s?|one[- ]on[- ]ones?|demo|interview|stand-?up|check-?in)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i

/** "I want / need / I'd like / hoping to …" (the goal said without the word). */
const WANT_WORD = /\b(?:i|we)\s+(?:want|need|would like)\b|\b(?:i|we)['’]d like\b|\bhoping to\b/i
/** "for / out of / from the Acme call", "for tomorrow's meeting": a particular meeting. */
const FOR_THE_MEETING =
  /\b(?:for|out of|from|at)\s+(?:the|my|our|this|today['’]s|tomorrow['’]s)\s+(?:[\w'’-]+\s+){0,3}?(?:meetings?|calls?|syncs?|demo|interview|1:1)\b/i
/** What someone wants FROM a past call (its notes), not out of the next one. */
const RECAP_WORD = /\b(?:notes|summary|recap|transcript|recording|minutes|action items)\b/i

/**
 * Does a message talk about a goal for a meeting? A goal word and a meeting
 * word (or a clock time) together: "my goal for the Acme call", "the goal of
 * my 2:30"; or what the person wants out of a particular meeting: "for the
 * Acme call I want a yes on pricing" (never its notes or summary). A goal with
 * no meeting ("Q4 goals") seeds nothing. Pure.
 */
export function mentionsMeetingGoal(text: unknown): boolean {
  if (typeof text !== 'string') return false
  if (GOAL_WORD.test(text) && MEETING_WORD.test(text)) return true
  return WANT_WORD.test(text) && FOR_THE_MEETING.test(text) && !RECAP_WORD.test(text)
}

/**
 * Token-based search over the tool registry.
 *
 * Scoring:
 *   +3 per query token in tool name
 *   +2 per query token in tool description
 *   +2 per query token matching category id/label
 *   +1 per query token in category description
 *   +2 bonus if tool name starts with a query token
 *   +1 category-sibling boost when any tool in a category scores > 0
 */
export function searchRegistry(query: string) {
  const tokens = query
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((t) => t.length > 1)

  if (tokens.length === 0) {
    // Return category summaries instead of all tools to avoid blowing open activeTools
    return TOOL_CATEGORIES.map((cat) => ({
      name: cat.id,
      description: `${cat.label}: ${cat.description} (${cat.tools.length} tools)`,
      category: cat.label,
    }))
  }

  // Score each tool
  const scored: Array<{
    name: string
    description: string
    category: string
    categoryId: string
    score: number
  }> = []

  for (const cat of TOOL_CATEGORIES) {
    const catIdLower = cat.id.toLowerCase()
    const catLabelLower = cat.label.toLowerCase()
    const catDescLower = cat.description.toLowerCase()

    let anyCatHit = false

    for (const t of cat.tools) {
      const nameLower = t.name.toLowerCase()
      const descLower = t.description.toLowerCase()
      let score = 0

      for (const token of tokens) {
        if (nameLower.includes(token)) score += 3
        if (descLower.includes(token)) score += 2
        if (catIdLower.includes(token) || catLabelLower.includes(token)) score += 2
        if (catDescLower.includes(token)) score += 1
        if (nameLower.startsWith(token)) score += 2
      }

      if (score > 0) anyCatHit = true

      scored.push({
        name: t.name,
        description: t.description,
        category: cat.label,
        categoryId: cat.id,
        score,
      })
    }

    // Category-sibling boost: if any tool in this category scored, boost all siblings
    if (anyCatHit) {
      for (const entry of scored) {
        if (entry.categoryId === cat.id) {
          entry.score += 1
        }
      }
    }
  }

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map(({ name, description, category }) => ({ name, description, category }))
}

/**
 * Filter a tools object down to the entries a run is permitted to CALL.
 *
 * This is the security boundary (loop-closure Phase 2, Workstream A). Passing
 * the full tools map to generateText/streamText and relying on `activeTools` +
 * `prepareStep` to restrict things is NOT enforcement: the SDK validates every
 * model-emitted tool call against the FULL `tools` map (ai@6 parseToolCall), so
 * a model that *believes* it has an excluded tool — because search_tools told
 * it so — can call it and it executes. The forensic proof: "report"-mode flow
 * runs accepted/dismissed proposals in prod despite the ceiling excluding those
 * tools (docs/loop-engine/LOOP-CLOSURE-PHASE2-PLAN.md, F1).
 *
 * The fix is structural: a tool absent from the map cannot parse and cannot
 * execute. Build the map FROM the ceiling; keep `activeTools`/`prepareStep` only
 * as the progressive-disclosure (context-economy) layer.
 *
 * `ceiling` is a Set of BARE tool names (the same shape computeToolCeiling /
 * computeReportModeCeiling return). `null`/`undefined` means inherit-all — no
 * restriction — so the map passes through unchanged.
 *
 * `search_tools` is always retained: it's the discovery meta-tool, must stay
 * callable so the model can find its OTHER permitted tools, and is itself a
 * read-only registry lookup (it can only ever surface names — it can't mutate).
 * It's part of every real ceiling anyway via CORE_TOOL_NAMES; keeping it
 * explicitly is defensive against a caller that hands a hand-built ceiling.
 *
 * ALWAYS_ON_CAPABILITY_TOOL_NAMES (`web_search`) is retained on the same
 * footing: web access is a capability every agent has, not a permission an
 * allowlist grants, so a narrow ceiling must not strip it. It is read-only and
 * provider-executed — it can only ever return public search results — so it
 * widens no mutation surface. Note this only PRESERVES an entry the caller
 * already put in `tools`; it never invents one, so a run that deliberately
 * builds its map without web_search (e.g. Gateway disabled) stays without it.
 */
export function pickPermittedTools<T extends Record<string, unknown>>(
  tools: T,
  ceiling: Set<string> | null | undefined,
): T {
  if (!ceiling) return tools
  const out: Record<string, unknown> = {}
  for (const [name, impl] of Object.entries(tools)) {
    if (name === 'search_tools' || ALWAYS_ON_CAPABILITY_SET.has(name) || ceiling.has(name)) {
      out[name] = impl
    }
  }
  return out as T
}

/**
 * Creates the search_tools meta-tool.
 *
 * `ceiling`, when provided, is the set of bare tool names this run is permitted
 * to CALL. search_tools then never advertises an out-of-ceiling tool as
 * available — a report-mode run must not be told "accept_proposal is now
 * available. Call it directly." (that lie is what the model acted on in the F1
 * incident). Out-of-ceiling matches are dropped from the results entirely so
 * the model doesn't waste steps trying to call a tool it can't reach. `null`/
 * omitted → inherit-all, every registered tool is discoverable (chat default).
 */
export function createSearchToolsTool(ceiling?: Set<string> | null) {
  const allowed = (name: string) => !ceiling || ceiling.has(name)
  return tool({
    // Derive the advertised category list from the live registry so it can never
    // drift from ALL_CATEGORY_IDS again (it previously omitted knowledge + flows).
    description:
      'Discover additional workspace tools by searching with a natural language query or browsing a category. ' +
      'Use this when you need a tool not currently available to you. ' +
      `Available categories: ${ALL_CATEGORY_IDS.join(', ')}.`,
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'Natural language search query (e.g., "email drafts", "milestones", "CRM contacts") ' +
            'OR a category name to browse all tools in that category.',
        ),
    }),
    execute: async ({ query }) => {
      // Check for exact category match first
      const exactCat = TOOL_CATEGORIES.find(
        (c) => c.id.toLowerCase() === query.toLowerCase() || c.label.toLowerCase() === query.toLowerCase(),
      )

      if (exactCat) {
        // Drop tools outside the ceiling — never advertise what can't be called.
        const catTools = exactCat.tools.filter((t) => allowed(t.name))
        if (catTools.length === 0) {
          return {
            tools: [],
            hint: 'No tools in that category are available in this mode. Work with the tools you already have.',
          }
        }
        return {
          tools: catTools.map((t) => ({
            name: t.name,
            description: t.description,
            category: exactCat.label,
          })),
          hint: 'These tools are now available. Call them directly.',
        }
      }

      // Filter only rows that are actual tool names; category-summary rows
      // (the empty-query browse path) carry a category id in `name` and are
      // navigation hints, not callable tools — pass them through (browsing a
      // category re-enters the ceiling-filtered exactCat path above).
      const results = searchRegistry(query).filter(
        (r) => !TOOL_NAME_SET.has(r.name) || allowed(r.name),
      )

      if (results.length === 0) {
        return {
          tools: [],
          hint: 'No matching tools found. Try a different query or browse a category: ' +
            TOOL_CATEGORIES.map((c) => c.id).join(', '),
        }
      }

      // Category-completeness hints: the top-15 slice can crowd out a matched
      // category's siblings (a query like "email automation" fills the list
      // with email tools, and the model then concludes create_sequence does
      // not exist because it saw only list_sequences). For every category
      // represented in the kept results, name the in-ceiling siblings that
      // were NOT returned, so one search is enough to learn the full surface.
      const keptNames = new Set(results.map((r) => r.name))
      const categoryHints: string[] = []
      for (const cat of TOOL_CATEGORIES) {
        if (!results.some((r) => TOOL_NAME_SET.has(r.name) && cat.tools.some((t) => t.name === r.name))) continue
        const missing = cat.tools
          .filter((t) => allowed(t.name) && !keptNames.has(t.name))
          .map((t) => t.name)
        if (missing.length > 0) {
          categoryHints.push(`${cat.label} also has: ${missing.join(', ')} (search "${cat.id}" to load them)`)
        }
      }

      return {
        tools: results,
        hint:
          'These tools are now available. Call them directly.' +
          (categoryHints.length > 0 ? ` ${categoryHints.join('. ')}.` : ''),
      }
    },
  })
}

/**
 * Creates a `prepareStep` callback for `streamText()`.
 *
 * On each step, reads previous `search_tools` results and cumulatively
 * expands `activeTools` to include discovered tool names.
 *
 * `allowedCeiling`, when provided, is a hard upper bound on which tools the
 * model may ever activate — this is what makes an agent's tool allowlist real:
 * the model can still call `search_tools` and *see* tools outside the ceiling,
 * but they are never added to `activeTools`, so it can't call them. When
 * `undefined`, discovery is unbounded (inherit-all — the default for chat with
 * no active agent).
 */
export function createPrepareStep(
  initialActiveTools: string[],
  availableToolNames?: Set<string>,
  allowedCeiling?: Set<string>,
) {
  return ({ steps }: { steps: Array<{ toolResults: Array<{ toolName: string; output: any }> }> }) => {
    const discoveredTools = new Set<string>()

    for (const step of steps) {
      for (const result of step.toolResults) {
        if (
          result.toolName === 'search_tools' &&
          result.output &&
          typeof result.output === 'object' &&
          'tools' in result.output &&
          Array.isArray(result.output.tools)
        ) {
          for (const t of result.output.tools as Array<{ name: string }>) {
            // Only add tools that actually exist in the tools object, and —
            // when an agent ceiling is in effect — only those the agent allows.
            if (
              (!availableToolNames || availableToolNames.has(t.name)) &&
              (!allowedCeiling || allowedCeiling.has(t.name))
            ) {
              discoveredTools.add(t.name)
            }
          }
        }
      }
    }

    if (discoveredTools.size === 0) return {}

    return {
      activeTools: [...new Set([...initialActiveTools, ...discoveredTools])],
    }
  }
}

// computeToolCeiling now lives in ./tool-ceiling-core (re-exported at the top
// of this file) so it can be reached without pulling in `ai`/`zod`.

/**
 * Computes the initial `activeTools` array for a chat request.
 *
 * Starts with CORE_TOOL_NAMES, then expands with skill-specific tools
 * when a skill is active (bypassing search for those).
 */
export function computeInitialActiveTools(
  skillCategoryIds?: string[],
  skillDisabledTools?: string[],
): string[] {
  const tools = new Set<string>([...CORE_TOOL_NAMES, ...ALWAYS_ON_CAPABILITY_TOOL_NAMES])

  if (skillCategoryIds?.length) {
    const skillToolNames = getToolNamesForCategories(skillCategoryIds)
    const disabled = new Set(skillDisabledTools ?? [])
    for (const name of skillToolNames) {
      if (!disabled.has(name)) tools.add(name)
    }
  }

  return [...tools]
}
